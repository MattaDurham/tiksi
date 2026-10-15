"""Bounded local model conversion, using installed authoring engines and isolated files."""
import io
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit
import zipfile

ROOT=Path(__file__).resolve().parent.parent
MAX_BYTES=600*1024*1024
CAD={'.ifc','.step','.stp','.iges','.igs','.dxf','.laz','.3dm','.e57'}
BLENDER={'.blend','.usd','.usda','.usdc','.usdz'}
MIRROR_ENTRY=re.compile(r'^(mirror\.json|existing\.skp|underlay/[\w.:-]{1,80}\.(png|jpg|jpeg|webp))$')

class ConversionError(ValueError):
    def __init__(self,message,status=400):super().__init__(message);self.status=status

class ModelConversionService:
    def __init__(self,root):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
        self.token=secrets.token_urlsafe(32);self.lock=threading.Lock();self.process=None
        self.blender=shutil.which('blender') or (str(Path('/Applications/Blender.app/Contents/MacOS/Blender')) if Path('/Applications/Blender.app/Contents/MacOS/Blender').exists() else None)
        from server.sketchup_convert import library_path
        self.sketchup=bool(library_path())
        self.python=Path(os.environ.get('TIKSI_CAD_PYTHON',str(self.root/'venv/bin/python')))
    def capabilities(self):
        return {'token':self.token,'blender':bool(self.blender),'sketchup':self.sketchup,'cad':self.python.is_file(),
                'imports':sorted((BLENDER if self.blender else set()) | (CAD if self.python.is_file() else set()) | ({'.skp'} if self.sketchup else set())),
                'exports':(['blend'] if self.blender else [])+(['skp'] if self.sketchup else [])+(['ifc'] if self.python.is_file() else []),'mirror':self.sketchup,'maxBytes':MAX_BYTES}
    def active_jobs(self):return int(self.lock.locked())
    def cancel(self):
        if self.process and self.process.poll() is None:self.process.terminate()
        return {'cancelled':bool(self.process)}
    def close(self):
        if self.process and self.process.poll() is None:self.process.terminate()
    def _run(self,args,folder):
        # No shell interpolation; user input never becomes executable commands or paths.
        env=os.environ.copy();env['TMPDIR']=str(folder)
        sandbox=shutil.which('sandbox-exec') if sys.platform=='darwin' else None
        if sandbox:
            quote=lambda path: json.dumps(str(Path(path).resolve()))
            reads=' '.join('(subpath '+quote(path)+')' for path in [folder,ROOT/'server',self.python.parent.parent,tempfile.gettempdir()])
            profile='(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath '+quote(folder)+') (subpath '+quote(tempfile.gettempdir())+') (literal "/dev/null"))(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/private/var/folders"))(allow file-read-data '+reads+')'
            args=[sandbox,'-p',profile,*args]
        with (folder/'engine.log').open('wb') as log:
            self.process=subprocess.Popen(args,stdout=log,stderr=subprocess.STDOUT,cwd=folder,env=env)
            try:code=self.process.wait(timeout=300)
            except subprocess.TimeoutExpired:
                self.process.kill();self.process.wait();raise ConversionError('Conversion exceeded five minutes',422)
            finally:self.process=None
        text=(folder/'engine.log').read_text(encoding='utf-8',errors='replace')[-16000:]
        if code:raise ConversionError('Native conversion failed. Save the agent handoff to inspect the source and engine diagnostics.',422)
        result={'warnings':[]}
        for line in text.splitlines():
            try:
                value=json.loads(line.removeprefix('TIKSI_CONVERSION '))
                if isinstance(value,dict) and isinstance(value.get('warnings'),list):result=value
            except ValueError:pass
        return result
    def convert(self,data,extension,target='glb'):
        if not extension.startswith('.') or len(extension)>12 or not extension[1:].isalnum():raise ConversionError('Invalid input extension')
        if target not in {'glb','blend','skp','ifc'}:raise ConversionError('Invalid output format')
        if not 0<len(data)<=MAX_BYTES:raise ConversionError('Model must be between 1 byte and 600 MB',413)
        if not self.lock.acquire(blocking=False):raise ConversionError('Another model conversion is running',409)
        folder=None;report={}
        try:
            jobs=[p for p in self.root.iterdir() if p.is_dir() and len(p.name)==32]
            if len(jobs)>=20 or sum(p.stat().st_size for job in jobs for p in job.rglob('*') if p.is_file())+len(data)>2*1024**3:raise ConversionError('Conversion storage is full. Delete old handoffs in 3D Exchange.',409)
            identifier=secrets.token_hex(16);folder=self.root/identifier;folder.mkdir();source=folder/('source'+extension);source.write_bytes(data)
            output=folder/('model.'+('las' if extension in {'.laz','.e57'} else target))
            if extension=='.zip':
                package=folder/'package';package.mkdir();total=0;seen=set()
                with zipfile.ZipFile(source) as archive:
                    if len(archive.infolist())>10000:raise ConversionError('Native package contains too many files')
                    for item in archive.infolist():
                        name=item.filename.replace('\\','/');path=Path(name)
                        total+=item.file_size
                        if path.is_absolute() or '..' in path.parts or ':' in name or name in seen or (item.external_attr>>16)&0o170000==0o120000:raise ConversionError('Invalid native package resource path')
                        if total>MAX_BYTES:raise ConversionError('Native package expands beyond 600 MB')
                        seen.add(name)
                    archive.extractall(package)
                models=[p for p in package.rglob('*') if p.suffix.lower() in BLENDER|CAD|{'.skp'} and p.is_file() and '__MACOSX' not in p.parts]
                if len(models)!=1:raise ConversionError('Package one native model and its resources at a time')
                source=models[0];extension=source.suffix.lower();output=folder/('model.'+('las' if extension in {'.laz','.e57'} else target))
            report={'id':identifier,'inputFormat':extension,'outputFormat':output.suffix,'state':'running','createdAt':time.time()}
            (folder/'report.json').write_text(json.dumps(report))
            if target=='ifc' and extension=='.json' and self.python.is_file():args=[str(self.python),str(ROOT/'server/ifc_write.py'),str(source),str(output)]
            elif target=='skp' and extension=='.json':args=[sys.executable,str(ROOT/'server/sketchup_convert.py'),str(source),str(output)]
            elif extension=='.skp' and target=='glb':args=[sys.executable,str(ROOT/'server/sketchup_convert.py'),str(source),str(output)]
            elif self.blender and (extension in BLENDER and target=='glb' or extension=='.glb' and target in {'blend','glb'}):
                args=[self.blender,'--background','--factory-startup','--disable-autoexec','--python-exit-code','1','--python',str(ROOT/'server/blender_convert.py'),'--',str(source),str(output)]
            elif extension in CAD and target=='glb' and self.python.is_file():args=[str(self.python),str(ROOT/'server/cad_convert.py'),str(source),str(output)]
            else:
                (folder/'interpretation.json').write_text(json.dumps({'format':'tiksi-interpretation','inputFormat':extension,'route': 'Use integrations/revit/ExportForTiksi.cs in Revit to export IFC.' if extension=='.rvt' else 'Use integrations/sketchup/tiksi_bridge.rb in an empty SketchUp document to convert CAD to GLB.' if extension=='.dwg' else 'Inspect this source in its authoring app; recover real dimensions/materials and propose reviewed Tiksi elements.','requestedOutput':'Editable model plus measured surfaces and material identity evidence; preserve before capture and photo pins.'},indent=2))
                raise ConversionError('No installed reader for this format. Source retained in an agent handoff for interpretation.',422)
            result=self._run(args,folder)
            if not output.is_file() or not 0<output.stat().st_size<=MAX_BYTES:raise ConversionError('Converter did not produce a usable file',422)
            report.update(state='complete',**result);(folder/'report.json').write_text(json.dumps(report,indent=2))
            return identifier,output.read_bytes(),report
        except Exception as error:
            if folder:
                report.update(id=folder.name,inputFormat=extension,outputFormat='.'+target,state='failed',error=str(error));(folder/'report.json').write_text(json.dumps(report,indent=2))
                if isinstance(error,ConversionError):error.job_id=folder.name
            raise
        finally:self.lock.release()
    def mirror(self,op,data):
        """SketchUp mirror of one property: 'write' takes a ZIP (mirror.json, optional
        existing.skp and underlay images) and returns SKP bytes; 'read' takes SKP bytes and
        returns the tagged elements as JSON. Job files are deleted afterwards: the mirror
        itself lives in the owner's project folder, not in server history."""
        if op not in {'write','read'}:raise ConversionError('Invalid mirror operation')
        if not self.sketchup:raise ConversionError('The SketchUp mirror needs SketchUp installed on this Mac',422)
        if not 0<len(data)<=MAX_BYTES:raise ConversionError('Mirror must be between 1 byte and 600 MB',413)
        if not self.lock.acquire(blocking=False):raise ConversionError('Another model conversion is running',409)
        folder=None
        try:
            base=self.root/'mirror';base.mkdir(exist_ok=True)
            folder=base/secrets.token_hex(16);folder.mkdir()
            worker=[sys.executable,str(ROOT/'server/sketchup_mirror.py'),op,str(folder)]
            if op=='write':
                try:archive=zipfile.ZipFile(io.BytesIO(data))
                except zipfile.BadZipFile:raise ConversionError('Mirror package must be a ZIP')
                with archive:
                    items=archive.infolist();names=[i.filename for i in items]
                    if len(items)>64 or len(set(names))!=len(names) or not all(MIRROR_ENTRY.match(n) for n in names):raise ConversionError('Invalid mirror package entry')
                    if 'mirror.json' not in names:raise ConversionError('Mirror package has no mirror.json')
                    if sum(i.file_size for i in items)>MAX_BYTES:raise ConversionError('Mirror package expands beyond 600 MB',413)
                    for item in items:
                        target=folder/item.filename;target.parent.mkdir(exist_ok=True);target.write_bytes(archive.read(item))
                self._run(worker,folder)
                output=folder/'model.skp'
                if not output.is_file() or not 0<output.stat().st_size<=MAX_BYTES:raise ConversionError('Mirror writer did not produce a SketchUp file',422)
                return output.read_bytes()
            (folder/'source.skp').write_bytes(data)
            self._run(worker,folder)
            output=folder/'mirror-read.json'
            if not output.is_file():raise ConversionError('Mirror reader did not produce a result',422)
            return output.read_bytes()
        finally:
            if folder:shutil.rmtree(folder,ignore_errors=True)
            self.lock.release()
    def dispatch(self,h):
        base='/api/model-conversion';path=urlsplit(h.path).path
        if path!=base and not path.startswith(base+'/'):return False
        try:
            origin=h.headers.get('Origin')
            if origin and urlsplit(origin).netloc!=h.headers.get('Host'):raise ConversionError('Use the Tiksi app on this server',403)
            if h.headers.get('Sec-Fetch-Site')=='cross-site':raise ConversionError('Cross-site conversion is refused',403)
            if path==base+'/capabilities' and h.command=='GET':self.reply(h,200,json.dumps(self.capabilities()).encode(),'application/json');return True
            if not secrets.compare_digest(h.headers.get('X-Tiksi-Token',''),self.token):raise ConversionError('Reconnect to the conversion server',403)
            if path==base+'/cancel' and h.command=='POST':self.reply(h,200,json.dumps(self.cancel()).encode(),'application/json');return True
            if path==base+'/convert' and h.command=='POST':
                try:length=int(h.headers.get('Content-Length','0'))
                except ValueError:raise ConversionError('Invalid content length')
                if not 0<length<=MAX_BYTES:raise ConversionError('Model must be smaller than 600 MB',413)
                h.connection.settimeout(60);data=h.rfile.read(length)
                if len(data)!=length:raise ConversionError('Upload was truncated')
                identifier,data,report=self.convert(data,h.headers.get('X-Model-Extension','').lower(),h.headers.get('X-Model-Target','glb'))
                mime='application/octet-stream' if report['outputFormat']!='.glb' else 'model/gltf-binary'
                self.reply(h,200,data,mime,{'X-Tiksi-Job':identifier,'X-Tiksi-Format':report['outputFormat'],'X-Tiksi-Warnings':json.dumps(report.get('warnings',[]),ensure_ascii=True)});return True
            if path==base+'/mirror' and h.command=='POST':
                try:length=int(h.headers.get('Content-Length','0'))
                except ValueError:raise ConversionError('Invalid content length')
                if not 0<length<=MAX_BYTES:raise ConversionError('Mirror must be smaller than 600 MB',413)
                h.connection.settimeout(60);data=h.rfile.read(length)
                if len(data)!=length:raise ConversionError('Upload was truncated')
                op=h.headers.get('X-Mirror-Op','');data=self.mirror(op,data)
                self.reply(h,200,data,'application/json' if op=='read' else 'application/octet-stream');return True
            if path==base+'/jobs' and h.command=='GET':
                jobs=[json.loads(p.read_text()) for p in self.root.glob('*/report.json')]
                self.reply(h,200,json.dumps({'jobs':jobs}).encode(),'application/json');return True
            parts=path[len(base):].strip('/').split('/')
            if len(parts)==2 and parts[0]=='jobs' and len(parts[1])==32 and all(c in '0123456789abcdef' for c in parts[1]):
                folder=self.root/parts[1]
                if not folder.is_dir():raise ConversionError('Conversion not found',404)
                if h.command=='DELETE':
                    if self.lock.locked():raise ConversionError('Wait for conversion to finish',409)
                    shutil.rmtree(folder);self.reply(h,200,b'{}','application/json');return True
                if h.command=='GET':
                    stream=io.BytesIO()
                    with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as z:
                        for p in folder.rglob('*'):
                            if p.is_file():z.write(p,p.relative_to(folder))
                    self.reply(h,200,stream.getvalue(),'application/zip');return True
            raise ConversionError('Conversion endpoint not found',404)
        except ConversionError as e:
            h.close_connection=True
            self.reply(h,e.status,json.dumps({'error':str(e),'jobId':getattr(e,'job_id',None)}).encode(),'application/json');return True
        except Exception:
            h.close_connection=True;self.reply(h,500,b'{"error":"Local converter failed; source and diagnostics retained."}','application/json');return True
    @staticmethod
    def reply(h,status,data,mime,extra=None):
        h.send_response(status);h.send_header('Content-Type',mime);h.send_header('Content-Length',str(len(data)));h.send_header('Cache-Control','no-store')
        for name,value in (extra or {}).items():h.send_header(name,value)
        h.end_headers();h.wfile.write(data)
