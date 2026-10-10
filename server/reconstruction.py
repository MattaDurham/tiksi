"""Bounded, same-origin local photo reconstruction service for Tiksi.

The browser uploads original files to this Mac. Each native job runs in an isolated
process. No photos are sent to a relay/cloud, and no user-supplied command is executed.
"""
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from urllib.parse import unquote, urlsplit
import zipfile

MAX_IMAGE_BYTES = 60 * 1024 * 1024  # Original high-resolution camera photographs.
MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024  # One job must fit a typical local SSD budget.
MAX_IMAGES = 300  # Native matching cost grows rapidly with the capture count.
MIN_IMAGES = 20
MAX_JOBS = 20  # Bound retained photos; users can remove completed jobs explicitly.
MAX_MODEL_BYTES = 600 * 1024 * 1024  # Matches the browser's scan import capacity.
JOB_TIMEOUT = 2 * 60 * 60  # Prevent a native job from pinning the Mac indefinitely.
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff"}
QUALITIES = ("preview", "reduced", "medium", "full", "raw")
TERMINAL = {"complete", "failed", "cancelled", "interrupted"}


class APIError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


class ReconstructionService:
    def __init__(self, state_dir, engine=None, engine_command=None):
        self.root = Path(state_dir).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.engine = Path(engine) if engine else self.root.parent / "bin" / "object-capture"
        # Explicit process seam for portable tests; HTTP callers cannot configure it.
        self.engine_command = list(engine_command) if engine_command else [str(self.engine)]
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.processes = {}
        self.closed = False
        self.jobs = {}
        self.engine_status = None
        for folder in self.root.iterdir():
            if not folder.is_dir() or not re.fullmatch(r"[a-f0-9]{32}", folder.name): continue
            try:
                job = json.loads((folder / "job.json").read_text(encoding="utf-8"))
                if job["state"] in {"running", "converting", "uploading"}:
                    job.update(state="interrupted", error="The local server stopped before this job finished. Create a new job using the original photos.")
                    self._save(job)
                self.jobs[job["id"]] = job
            except (OSError, ValueError, KeyError): continue

    def _save(self, job):
        folder = self.root / job["id"]
        folder.mkdir(exist_ok=True)
        tmp = folder / "job.json.tmp"
        tmp.write_text(json.dumps(job, allow_nan=False), encoding="utf-8")
        os.replace(tmp, folder / "job.json")

    def _public(self, job):
        # Copies isolate snapshots from the asynchronous progress stream.
        return json.loads(json.dumps(job))

    def _availability(self):
        if not self.engine.is_file():
            return {"available": False, "engine": "Apple Object Capture", "reason": "The native engine has not been built. Run python3 tools/build-reconstruction.py for this instance."}
        if self.engine_status is None:
            try:
                check = subprocess.run(self.engine_command + ["--check"], capture_output=True, text=True, encoding="utf-8", timeout=20)
                self.engine_status = {"available": check.returncode == 0, "engine": "Apple Object Capture"}
                if check.returncode: self.engine_status["reason"] = "Object Capture is unsupported on this Mac, or the native engine failed its hardware check."
            except (OSError, subprocess.TimeoutExpired) as error:
                self.engine_status = {"available": False, "engine": "Apple Object Capture", "reason": str(error)}
        return self.engine_status

    def capabilities(self):
        return {**self._availability(), "token": self.token, "minImages": MIN_IMAGES,
                "maxImages": MAX_IMAGES, "maxImageBytes": MAX_IMAGE_BYTES, "maxTotalBytes": MAX_TOTAL_BYTES,
                "maxJobs": MAX_JOBS, "qualities": list(QUALITIES), "formats": sorted(IMAGE_EXT)}

    def active_jobs(self):
        with self.lock:
            return sum(job["state"] in {"uploading", "running", "converting"} for job in self.jobs.values())

    def create(self, metadata):
        with self.lock:
            if self.closed: raise APIError(503, "The local server is shutting down")
            if not self._availability()["available"]: raise APIError(503, self._availability().get("reason", "Engine unavailable"))
            if len(self.jobs) >= MAX_JOBS: raise APIError(409, "Remove an old reconstruction job before creating another")
            quality = metadata.get("quality", "medium")
            order = metadata.get("order", "unordered")
            if quality not in QUALITIES or order not in {"unordered", "sequential"}: raise APIError(400, "Invalid reconstruction quality or photo ordering")
            identifier = secrets.token_hex(16)
            job = {"id": identifier, "name": str(metadata.get("name", "Photo model"))[:120], "quality": quality,
                   "order": order, "state": "draft", "images": 0, "bytes": 0, "progress": 0,
                   "createdAt": time.time(), "warnings": [], "error": ""}
            (self.root / identifier / "images").mkdir(parents=True)
            self.jobs[identifier] = job
            self._save(job)
            return self._public(job)

    def _job(self, identifier):
        job = self.jobs.get(identifier)
        if not job: raise APIError(404, "Reconstruction job not found")
        return job

    def upload(self, identifier, name, length, source):
        suffix = Path(name).suffix.lower()
        if suffix not in IMAGE_EXT: raise APIError(415, "Use JPEG, PNG, HEIC/HEIF or TIFF original photographs")
        if not 0 < length <= MAX_IMAGE_BYTES: raise APIError(413, "Image is empty or exceeds the 60 MB limit")
        with self.lock:
            job = self._job(identifier)
            if job["state"] != "draft": raise APIError(409, "This job is no longer accepting photos")
            if job["images"] >= MAX_IMAGES or job["bytes"] + length > MAX_TOTAL_BYTES: raise APIError(413, "The photo count or 2 GB job limit would be exceeded")
            job["state"] = "uploading"
            self._save(job)
            path = self.root / identifier / "images" / (f"image-{job['images']:04d}" + suffix)
        try:
            remaining = length
            with path.open("wb") as stream:
                while remaining:
                    chunk = source.read(min(1024 * 1024, remaining))
                    if not chunk: raise APIError(400, "Image upload ended early")
                    stream.write(chunk); remaining -= len(chunk)
            header = path.read_bytes()[:16] if length < 16 else None
            if header is None:
                with path.open("rb") as stream: header = stream.read(16)
            valid = (header.startswith(b"\xff\xd8\xff") if suffix in {".jpg", ".jpeg"} else
                     header.startswith(b"\x89PNG\r\n\x1a\n") if suffix == ".png" else
                     b"ftyp" in header if suffix in {".heic", ".heif"} else
                     header.startswith((b"II*\0", b"MM\0*")))
            if not valid: raise APIError(415, "The file's contents do not match its image format")
            with self.lock:
                job.update(state="draft", images=job["images"] + 1, bytes=job["bytes"] + length)
                self._save(job)
                return self._public(job)
        except Exception:
            path.unlink(missing_ok=True)
            with self.lock:
                job["state"] = "draft"; self._save(job)
            raise

    def start(self, identifier):
        with self.lock:
            job = self._job(identifier)
            if job["state"] != "draft": raise APIError(409, "Job has already started")
            if job["images"] < MIN_IMAGES: raise APIError(400, f"At least {MIN_IMAGES} overlapping photographs are required")
            if any(j["state"] in {"running", "converting"} for j in self.jobs.values()): raise APIError(409, "Another model is being reconstructed. Wait or cancel that job first.")
            if self.closed: raise APIError(503, "The local server is shutting down")
            job.update(state="running", startedAt=time.time(), progress=0)
            self._save(job)
            threading.Thread(target=self._run, args=(identifier,), name="tiksi-photogrammetry", daemon=True).start()
            return self._public(job)

    def _run(self, identifier):
        process = None
        try:
            with self.lock:
                job = self._job(identifier)
                if job["state"] == "cancelled" or self.closed: return
                folder = self.root / identifier
                with (folder / "engine.log").open("w", encoding="utf-8") as log:
                    process = subprocess.Popen(self.engine_command + [str(folder / "images"), str(folder / "output"), job["quality"], job["order"]], stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8")
                self.processes[identifier] = process
            timer = threading.Timer(JOB_TIMEOUT, lambda: self._timeout(identifier))
            timer.daemon = True; timer.start()
            try:
                for line in process.stdout:
                    try: event = json.loads(line)
                    except ValueError: continue  # Framework diagnostics aren't JSON events.
                    with self.lock:
                        if job["state"] == "cancelled": continue
                        if event.get("event") == "progress": job["progress"] = min(1, max(0, float(event["progress"])))
                        elif event.get("event") == "warning": job["warnings"] = (job["warnings"] + [str(event.get("message", ""))[:500]])[-100:]
                        elif event.get("event") == "error": job["error"] = str(event.get("message", "Reconstruction failed"))[:1000]
                        self._save(job)
                code = process.wait()
            finally: timer.cancel()
            with self.lock:
                if job["state"] in TERMINAL: return
                if code:
                    detail = job["error"] or f"The native engine exited with code {code}."
                    raise RuntimeError(detail + " Use sharp, full-resolution photographs with consistent lighting and substantial overlap; check the engine notices for rejected images.")
                job["state"] = "converting"; self._save(job)
            models = list((folder / "output").rglob("*.obj"))
            if len(models) != 1: raise RuntimeError("The native engine did not produce one usable OBJ model")
            with self.lock:
                if job["state"] in TERMINAL: return
                # Conversion also runs outside the server, so cancellation kills both
                # heavy phases and an invalid OBJ cannot wedge the request threads.
                process.stdout.close()
                process = subprocess.Popen([sys.executable, "-m", "server.obj2glb", str(models[0]), str(folder / "model.glb")],
                                           cwd=Path(__file__).resolve().parents[1], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           text=True, encoding="utf-8")
                self.processes[identifier] = process
            try:
                output, error_output = process.communicate(timeout=300)
            except subprocess.TimeoutExpired:
                process.kill(); process.communicate()
                raise RuntimeError("Model conversion exceeded five minutes. Try reduced quality.")
            if process.returncode:
                raise RuntimeError("Model conversion failed: " + error_output[-1000:])
            stats = json.loads(output)
            if stats["bytes"] > MAX_MODEL_BYTES: raise RuntimeError("Reconstructed model exceeds the 600 MB browser limit. Try reduced quality.")
            with self.lock:
                if job["state"] in TERMINAL: return
                if stats.get("displacementMaps"):
                    job["warnings"].append("Native EXR displacement maps are preserved in the native OBJ archive. GLB review uses the original mesh, normal, roughness and ambient occlusion maps; glTF does not apply displacement.")
                job.update(state="complete", progress=1, stats=stats, completedAt=time.time(), error="")
                self._save(job)
        except Exception as error:
            with self.lock:
                job = self.jobs.get(identifier)
                if job and job["state"] not in TERMINAL: job.update(state="failed", error=str(error)[:1000]); self._save(job)
        finally:
            if process and process.stdout: process.stdout.close()
            with self.lock: self.processes.pop(identifier, None)

    def _timeout(self, identifier):
        with self.lock:
            job = self.jobs.get(identifier)
            process = self.processes.get(identifier)
            if job and job["state"] == "running":
                job.update(state="failed", error="Reconstruction exceeded the two-hour time limit. Try fewer photos or reduced quality.")
                self._save(job)
                if process and process.poll() is None: process.kill()

    def cancel(self, identifier):
        with self.lock:
            job = self._job(identifier)
            if job["state"] in TERMINAL: return self._public(job)
            if job["state"] == "uploading": raise APIError(409, "Wait for the current image upload to finish")
            job["state"] = "cancelled"; self._save(job)
            process = self.processes.get(identifier)
            if process and process.poll() is None: process.terminate()
            return self._public(job)

    def delete(self, identifier):
        with self.lock:
            job = self._job(identifier)
            if job["state"] not in TERMINAL | {"draft"} or identifier in self.processes: raise APIError(409, "Cancel this job and wait for its worker to stop before removing it")
            shutil.rmtree(self.root / identifier)
            del self.jobs[identifier]
            return {"removed": True}

    def close(self):
        with self.lock:
            self.closed = True
            for identifier, process in self.processes.items():
                if process.poll() is None: process.terminate()
                job = self.jobs[identifier]
                if job["state"] not in TERMINAL: job.update(state="interrupted", error="The local server shut down"); self._save(job)

    def _reply(self, handler, code, payload):
        body = json.dumps(payload, allow_nan=False).encode("utf-8")
        handler.send_response(code)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.send_header("Cache-Control", "no-store")
        handler.send_header("X-Content-Type-Options", "nosniff")
        handler.end_headers(); handler.wfile.write(body)

    def dispatch(self, handler):
        path = urlsplit(handler.path).path
        base = "/api/reconstruction"
        if path != base and not path.startswith(base + "/"): return False
        try:
            origin = handler.headers.get("Origin")
            host = handler.headers.get("Host", "")
            if origin and urlsplit(origin).netloc != host: raise APIError(403, "Only the Tiksi app on this server can use reconstruction")
            if handler.headers.get("Sec-Fetch-Site") == "cross-site": raise APIError(403, "Cross-site requests are not allowed")
            method = handler.command
            if path == base + "/capabilities" and method == "GET":
                self._reply(handler, 200, self.capabilities()); return True
            token = handler.headers.get("X-Tiksi-Token", "")
            if not secrets.compare_digest(token, self.token): raise APIError(403, "Reopen the reconstruction view to connect to this server")
            segments = path[len(base):].strip("/").split("/")
            if segments == ["jobs"]:
                if method == "GET":
                    with self.lock: response = {"jobs": [self._public(j) for j in self.jobs.values()]}
                    self._reply(handler, 200, response); return True
                if method == "POST":
                    response = self.create(self._json_body(handler)); self._reply(handler, 201, response); return True
            if len(segments) >= 2 and segments[0] == "jobs" and re.fullmatch(r"[a-f0-9]{32}", segments[1]):
                identifier = segments[1]
                if len(segments) == 2:
                    if method == "GET":
                        with self.lock: response = self._public(self._job(identifier))
                        self._reply(handler, 200, response); return True
                    if method == "DELETE": self._reply(handler, 200, self.delete(identifier)); return True
                if len(segments) == 3:
                    action = segments[2]
                    if action == "images" and method == "PUT":
                        length = self._length(handler, MAX_IMAGE_BYTES)
                        handler.connection.settimeout(60)
                        response = self.upload(identifier, unquote(handler.headers.get("X-Image-Name", "")), length, handler.rfile)
                        self._reply(handler, 200, response); return True
                    if action == "start" and method == "POST": self._reply(handler, 200, self.start(identifier)); return True
                    if action == "cancel" and method == "POST": self._reply(handler, 200, self.cancel(identifier)); return True
                    if action in {"model", "native"} and method == "GET":
                        with self.lock:
                            if self._job(identifier)["state"] != "complete": raise APIError(409, "The model is not ready")
                            folder = self.root / identifier
                            if action == "native":
                                archive = folder / "native-obj.zip"
                                if not archive.exists():
                                    source = folder / "output"
                                    artifacts = [p for p in source.rglob("*") if p.is_file()]
                                    if sum(p.stat().st_size for p in artifacts) > MAX_TOTAL_BYTES: raise APIError(413, "Native model exceeds the 2 GB download limit")
                                    with zipfile.ZipFile(archive.with_suffix(".building"), "w", compression=zipfile.ZIP_STORED) as stream:
                                        for artifact in artifacts:
                                            if not artifact.resolve().is_relative_to(source.resolve()): raise APIError(400, "Invalid native model artifact")
                                            stream.write(artifact, artifact.relative_to(source))
                                    archive.with_suffix(".building").replace(archive)
                                file = archive.open("rb")
                            else: file = (folder / "model.glb").open("rb")
                        with file:
                            handler.send_response(200); handler.send_header("Content-Type", "application/zip" if action == "native" else "model/gltf-binary")
                            handler.send_header("Content-Length", str(os.fstat(file.fileno()).st_size))
                            handler.send_header("Cache-Control", "no-store"); handler.end_headers()
                            shutil.copyfileobj(file, handler.wfile)
                        return True
            raise APIError(404, "Reconstruction endpoint not found")
        except APIError as error:
            handler.close_connection = True  # Rejected uploads may leave unread bytes.
            self._reply(handler, error.code, {"error": error.message})
        except (OSError, ValueError, TypeError) as error:
            handler.close_connection = True
            self._reply(handler, 400, {"error": str(error)[:500]})
        return True

    def _length(self, handler, limit):
        if handler.headers.get("Transfer-Encoding"): raise APIError(400, "Chunked request bodies are not supported")
        try: length = int(handler.headers.get("Content-Length", ""))
        except ValueError: raise APIError(411, "Content-Length is required")
        if not 0 <= length <= limit: raise APIError(413, "Request body exceeds its limit")
        return length

    def _json_body(self, handler):
        length = self._length(handler, 4096)
        data = handler.rfile.read(length)
        if len(data) != length: raise APIError(400, "Request body ended early")
        try: payload = json.loads(data)
        except (ValueError, UnicodeDecodeError): raise APIError(400, "Invalid JSON request")
        if not isinstance(payload, dict): raise APIError(400, "Expected a JSON object")
        return payload
