#!/usr/bin/env python3
"""Tiksi branch/worktree previews and owner-approved PR landing."""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{0,63}$')
PORT_MIN, PORT_MAX = 8643, 8699

class WorkflowError(RuntimeError):
    pass

def run(args, cwd, *, capture=True, check=True):
    result = subprocess.run([str(x) for x in args], cwd=cwd, text=True,
                            encoding='utf-8', capture_output=capture)
    if check and result.returncode:
        raise WorkflowError((result.stderr or result.stdout or f'Command failed: {args[0]}').strip())
    return result.stdout.strip() if capture else result.returncode

def atomic_json(path, data):
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temp.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)

def read_json(path):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None

class Workflow:
    def __init__(self, cwd=None):
        self.cwd = Path(cwd or os.getcwd()).resolve()
        self.common = Path(run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], self.cwd))
        self.records = self.common / 'tiksi-workflow'
        self.live = next((item['path'] for item in self.worktrees() if item.get('branch') == 'main'), None)
        if self.live is None:
            raise WorkflowError('A checked-out local main branch is required.')
        self.home = self.live / '.worktrees'
        self.processes = {}

    def git(self, *args, cwd=None):
        return run(['git', *args], cwd or self.cwd)

    def worktrees(self):
        items = []
        for block in run(['git', 'worktree', 'list', '--porcelain'], self.cwd).split('\n\n'):
            item = {}
            for line in block.splitlines():
                key, _, value = line.partition(' ')
                if key == 'worktree': item['path'] = Path(value).resolve()
                elif key == 'branch': item['branch'] = value.removeprefix('refs/heads/')
            if item: items.append(item)
        return items

    @contextmanager
    def lock(self):
        self.records.mkdir(exist_ok=True)
        lock = self.records / 'lock'
        try:
            lock.mkdir()
        except FileExistsError:
            raise WorkflowError('Another workflow command owns the lock. Inspect it; never clear a live lock.')
        try:
            (lock / 'owner.json').write_text(json.dumps({'pid': os.getpid(), 'created': time.time()}), encoding='utf-8')
            yield
        finally:
            shutil.rmtree(lock)

    def validate(self, slug):
        if not SLUG.fullmatch(slug):
            raise WorkflowError('Slug must be lowercase kebab-case, at most 64 characters.')
        return 'codex/' + slug

    def target(self, slug):
        branch = self.validate(slug)
        for item in self.worktrees():
            if item.get('branch') == branch:
                if item['path'] == self.live:
                    raise WorkflowError('Refusing to operate a preview on the live checkout.')
                return item['path']
        raise WorkflowError(f'{branch} has no worktree. Start or adopt it first.')

    def record(self, slug):
        return self.records / (slug + '.json')

    def provision(self, target, slug):
        # A copy belongs to this branch until the owner's live private file exists.
        local = target / 'AGENTS.local.md'
        if not local.exists() and not local.is_symlink():
            source = self.live / 'AGENTS.local.md'
            if source.exists(): local.symlink_to(source)
            else:
                template = target / 'AGENTS.local.example.md'
                if template.exists(): shutil.copyfile(template, local)
        if not (target / 'node_modules').exists() and (self.live / 'node_modules').exists():
            (target / 'node_modules').symlink_to(self.live / 'node_modules', target_is_directory=True)
        if not self.record(slug).exists():
            atomic_json(self.record(slug), {'slug': slug, 'base': self.git('rev-parse', 'main'), 'path': str(target)})

    def start(self, slug):
        branch = self.validate(slug)
        with self.lock():
            target = self.home / slug
            self.home.mkdir(exist_ok=True)
            self.git('worktree', 'add', '-b', branch, str(target), 'main')
            self.provision(target, slug)
        print(f'{branch}\n{target}')
        return target

    def adopt(self, slug=None):
        branch = self.git('branch', '--show-current')
        slug = slug or branch.removeprefix('codex/')
        target = self.target(slug)
        with self.lock(): self.provision(target, slug)
        print(f'Adopted codex/{slug}: {target}')
        return target

    def metadata(self, target):
        return read_json(target / '.tiksi-instance.json')

    def probe(self, metadata):
        if not metadata: return None
        try:
            # Never send requests through a configured HTTP proxy.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(f'http://localhost:{metadata["port"]}/api/instance', timeout=1) as response:
                result = json.load(response)
            return result if result.get('instanceId') == metadata.get('instanceId') and result.get('pid') == metadata.get('pid') else None
        except urllib.error.HTTPError as exc:
            exc.close()
            return None
        except (OSError, ValueError, KeyError): return None

    def stopping_safe(self, metadata):
        if not self.probe(metadata):
            # A dead or reused process id must never be killed from stale metadata.
            raise WorkflowError('Preview identity is not verified. Preserving process and metadata; inspect it manually.')
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(f'http://localhost:{metadata["port"]}/api/instance', timeout=1) as response:
                result = json.load(response)
            if result.get('activeJobs', 0):
                raise WorkflowError('Preview has active reconstruction or research jobs; let them finish or cancel them in the app.')
        except urllib.error.URLError as exc:
            raise WorkflowError(f'Cannot verify preview shutdown safety: {exc}')

    def stop(self, slug):
        target = self.target(slug)
        metadata = self.metadata(target)
        if metadata is None:
            print(f'No managed preview for codex/{slug}')
            return
        self.stopping_safe(metadata)
        pid = metadata.get('pid')
        if not isinstance(pid, int) or pid <= 1 or metadata['port'] == 8642:
            raise WorkflowError('Invalid preview process identity; stop refused.')
        # Endpoint identity is verified immediately before signalling. PID was
        # created by this manager and the process publishes the same random ID.
        os.kill(pid, signal.SIGTERM)
        for _ in range(50):
            if not self.probe(metadata): break
            time.sleep(.1)
        else: raise WorkflowError('Preview is still stopping; no kill escalation. Retry later.')
        child = self.processes.pop(pid, None)
        if child is not None:
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                raise WorkflowError('Preview process is still exiting; metadata preserved.')
        (target / '.tiksi-instance.json').unlink(missing_ok=True)
        print(f'Stopped codex/{slug} preview')

    def free_port(self, preferred=None):
        ports = ([preferred] if preferred and PORT_MIN <= preferred <= PORT_MAX else [])
        ports += [port for port in range(PORT_MIN, PORT_MAX + 1) if port not in ports]
        for port in ports:
            try:
                with socket.socket() as candidate:
                    candidate.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    candidate.bind(('127.0.0.1', port))
                return port
            except OSError: pass
        raise WorkflowError('No available preview port in 8643-8699.')

    def serve(self, slug, *, fresh=False, host='127.0.0.1'):
        target = self.target(slug)
        with self.lock():
            self.provision(target, slug)
            previous = self.metadata(target)
            if previous:
                running = self.probe(previous)
                if running and not fresh:
                    if previous.get('host') != host:
                        raise WorkflowError('Existing preview uses a different interface; use --fresh to change binding safely.')
                    print(f'http://localhost:{previous["port"]}/ (existing codex/{slug} preview)')
                    return previous
                if running: self.stop(slug)
                else:
                    # Never duplicate a starting/hung instance or trust a reused PID.
                    try:
                        os.kill(int(previous.get('pid', 0)), 0)
                    except (ProcessLookupError, ValueError, TypeError): pass
                    except PermissionError:
                        raise WorkflowError('Previous preview PID is inaccessible; preserving it.')
                    else:
                        raise WorkflowError('Previous preview PID is still alive but identity is unavailable. Inspect it; no duplicate start attempted.')
                    print('Previous preview is unavailable; preserving its metadata in the archive.')
            state = target / '.tiksi-state'
            archive = target / '.tiksi-state-archive'
            if fresh and state.exists():
                archive.mkdir(exist_ok=True)
                state.rename(archive / (str(time.time_ns())))
            state.mkdir(exist_ok=True)
            if previous and not self.probe(previous):
                archive.mkdir(exist_ok=True)
                atomic_json(archive / (str(time.time_ns()) + '-instance.json'), previous)
            record = read_json(self.record(slug)) or {}
            port = self.free_port(previous.get('port') if previous else record.get('port'))
            atomic_json(self.record(slug), {**record, 'port': port})
            metadata = {'slug': slug, 'branch': self.validate(slug), 'port': port,
                        'host': host, 'instanceId': uuid.uuid4().hex,
                        'head': self.git('rev-parse', 'HEAD', cwd=target), 'live': False}
            path = target / '.tiksi-instance.json'
            atomic_json(path, metadata)
            args = [sys.executable, str(target / 'tools/serve.py'), '--host', host,
                    '--port', str(port), '--instance-file', str(path), '--state-dir', str(state)]
            with (target / '.tiksi-preview.log').open('ab') as log:
                child = subprocess.Popen(args, cwd=target, stdout=log, stderr=log,
                                         start_new_session=True)
            self.processes[child.pid] = child
            metadata['pid'] = child.pid
            atomic_json(path, metadata)
            for _ in range(100):
                if child.poll() is not None:
                    raise WorkflowError(f'Preview exited; inspect {target / ".tiksi-preview.log"}')
                if self.probe(metadata):
                    print(f'http://localhost:{port}/ (codex/{slug}, {metadata["head"][:8]})')
                    return metadata
                time.sleep(.05)
            raise WorkflowError('Preview health check timed out; inspect its log. No duplicate start attempted.')

    def listing(self):
        for item in self.worktrees():
            branch = item.get('branch', '(detached)')
            if not branch.startswith('codex/'): continue
            data = self.metadata(item['path'])
            running = self.probe(data)
            dirty = bool(self.git('status', '--porcelain', cwd=item['path']))
            status = f'http://localhost:{data["port"]}/' if running else 'stopped'
            print(f'{branch}  {"dirty" if dirty else "clean"}  {status}\n  {item["path"]}')

    def gh(self, *args):
        return run(['gh', *args], self.live)

    def pr_info(self, slug, strict=False):
        try:
            return json.loads(self.gh('pr', 'view', self.validate(slug), '--json',
                                     'number,state,isDraft,headRefOid,url,statusCheckRollup,baseRefName'))
        except WorkflowError as exc:
            if strict and "no pull requests found" not in str(exc).lower(): raise
            return None

    def pr(self, slug, *, title=None, body_file=None, ready=False, base='main'):
        target = self.target(slug)
        if self.git('status', '--porcelain', cwd=target):
            raise WorkflowError('Commit all branch work before pushing or opening a PR.')
        branch = self.validate(slug)
        self.git('show-ref', '--verify', 'refs/heads/' + base)
        if body_file and not Path(body_file).is_file():
            raise WorkflowError('PR body file does not exist; no push attempted.')
        if self.git('rev-list', '--count', base + '..' + branch) == '0':
            raise WorkflowError('Branch has no commits beyond its base; nothing to publish as a PR.')
        self.gh('auth', 'status')
        self.git('push', '-u', 'origin', branch, cwd=target)
        info = self.pr_info(slug)
        if info and info['state'] == 'OPEN':
            if info.get('baseRefName') != base: self.gh('pr', 'edit', branch, '--base', base)
            if title: self.gh('pr', 'edit', branch, '--title', title)
            if body_file: self.gh('pr', 'edit', branch, '--body-file', str(Path(body_file).resolve()))
            if ready and info['isDraft']: self.gh('pr', 'ready', branch)
            print(info['url'])
            return
        title = title or self.git('log', '--reverse', '--format=%s', base + '..' + branch).split('\n')[0]
        args = ['pr', 'create', '--head', branch, '--base', base, '--title', title or branch]
        if body_file: args += ['--body-file', str(Path(body_file).resolve())]
        else: args += ['--body', f'Changes on `{branch}`. Review and validation details will be added before landing.']
        if not ready: args += ['--draft']
        print(self.gh(*args))

    def gate(self, slug, info=None):
        target = self.target(slug)
        branch = self.validate(slug)
        if self.git('branch', '--show-current', cwd=self.live) != 'main':
            raise WorkflowError('Live checkout must be on main.')
        if self.git('status', '--porcelain', '--untracked-files=no', cwd=self.live):
            raise WorkflowError('Live tracked files have uncommitted changes; preserve them and stop.')
        if self.git('status', '--porcelain', cwd=target):
            raise WorkflowError('Branch worktree is dirty; commit or preserve work before landing.')
        if subprocess.run(['git', 'merge-base', '--is-ancestor', 'main', branch], cwd=self.live).returncode:
            raise WorkflowError('Update/rebase onto current local main in the branch worktree, then retest.')
        record = read_json(self.record(slug))
        if record and subprocess.run(['git', 'merge-base', '--is-ancestor', record['base'], 'main'], cwd=self.live).returncode:
            raise WorkflowError(f'Main history changed. Rebase with --onto main {record["base"]} in the worktree.')
        info = info or self.pr_info(slug)
        if not info or info['state'] != 'OPEN' or info['isDraft']:
            raise WorkflowError('An open, ready PR is required before merging.')
        if info.get('baseRefName', 'main') != 'main':
            raise WorkflowError('Retarget the PR to main and wait for fresh CI before landing.')
        if info['headRefOid'] != self.git('rev-parse', branch):
            raise WorkflowError('PR head differs from local head; push the branch and wait for its CI.')
        checks = info.get('statusCheckRollup') or []
        if not checks:
            raise WorkflowError('PR has no completed CI checks; merge refused.')
        required = {'Regression (ubuntu-latest)', 'Regression (macos-latest)'}
        names = {check.get('name') or check.get('context') for check in checks}
        if not required.issubset(names):
            raise WorkflowError('Both Linux and macOS regression CI checks are required before merging.')
        for check in checks:
            status = check.get('status') or check.get('state')
            conclusion = check.get('conclusion') or check.get('state')
            if status not in ('COMPLETED', 'SUCCESS') or conclusion != 'SUCCESS':
                raise WorkflowError('All PR checks must finish successfully; merge refused.')
        return target

    def merge(self, slug, owner_approved=False, keep=False):
        if not owner_approved: raise WorkflowError('Merge requires the owner\'s instruction and --owner-approved.')
        target = self.gate(slug)
        # Use the live gate if present so a branch cannot weaken its own landing gate.
        gate = self.live / 'scripts/preflight.sh'
        if not gate.exists(): gate = target / 'scripts/preflight.sh'
        run(['sh', str(gate)], target, capture=False)
        with self.lock():
            self.gate(slug)
            if self.metadata(target): self.stop(slug)
            branch = self.validate(slug)
            try: self.git('merge', '--no-ff', branch, '-m', f'Merge branch {branch}', cwd=self.live)
            except WorkflowError:
                run(['git', 'merge', '--abort'], self.live, check=False)
                raise WorkflowError('Merge conflict; aborted. Resolve in the branch worktree and retest.')
            self.git('push', 'origin', 'main', cwd=self.live)
        print(f'Merged and pushed {branch}. Live server was not restarted.')
        if not keep:
            info = self.pr_info(slug)
            if info and info['state'] == 'MERGED': self.discard(slug, owner_approved=True)
            else: print('Keeping branch and worktree until GitHub confirms Merged. Run discard then.')

    def discard(self, slug, owner_approved=False):
        if not owner_approved: raise WorkflowError('Discard requires the owner\'s instruction and --owner-approved.')
        target = self.target(slug)
        if self.git('status', '--porcelain', cwd=target):
            raise WorkflowError('Dirty worktree preserved. Commit or explicitly save changes before discard.')
        branch = self.validate(slug)
        has_origin = bool(run(['git', 'remote', 'get-url', 'origin'], self.live, check=False))
        if has_origin: self.gh('auth', 'status')
        info = self.pr_info(slug, strict=has_origin) if has_origin else None
        if info and info['state'] == 'OPEN':
            head = info['headRefOid']
            if subprocess.run(['git', 'merge-base', '--is-ancestor', head, 'main'], cwd=self.live).returncode == 0:
                raise WorkflowError('PR head is already in main. Keep it open until GitHub confirms Merged; never close it.')
            self.gh('pr', 'close', branch)
        # Archive ignored runtime before deletion; dirty source has already blocked.
        with self.lock():
            if self.metadata(target): self.stop(slug)
            archive = self.records / 'archives' / (slug + '-' + str(time.time_ns()))
            for name in ('.tiksi-state', '.tiksi-state-archive', '.tiksi-preview.log', 'AGENTS.local.md'):
                source = target / name
                if source.exists():
                    archive.mkdir(parents=True, exist_ok=True)
                    if source.is_dir(): shutil.copytree(source, archive / name)
                    else: shutil.copyfile(source, archive / name)
            self.git('worktree', 'remove', '--force', str(target), cwd=self.live)
            self.git('branch', '-D', branch, cwd=self.live)
            if has_origin:
                exists = subprocess.run(['git', 'show-ref', '--verify', '--quiet', 'refs/remotes/origin/' + branch], cwd=self.live).returncode == 0
                if exists: self.git('push', 'origin', '--delete', branch, cwd=self.live)
            self.record(slug).unlink(missing_ok=True)
        print(f'Discarded {branch}; private runtime, if present, preserved in {archive}')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for command in ['start', 'serve', 'stop', 'pr', 'merge', 'discard']:
        child = commands.add_parser(command)
        child.add_argument('slug')
        if command == 'serve':
            child.add_argument('--fresh', action='store_true')
            binding = child.add_mutually_exclusive_group()
            binding.add_argument('--local', action='store_true', help='loopback only (default)')
            binding.add_argument('--host', default='127.0.0.1', help='explicit preview interface')
        if command == 'pr':
            child.add_argument('--title'); child.add_argument('--body-file'); child.add_argument('--base', default='main')
            child.add_argument('--ready', action='store_true')
        if command in ['merge', 'discard']:
            child.add_argument('--owner-approved', action='store_true')
        if command == 'merge': child.add_argument('--keep', action='store_true')
    commands.add_parser('adopt').add_argument('slug', nargs='?')
    commands.add_parser('list')
    args = vars(parser.parse_args())
    command = args.pop('command')
    args.pop('local', None)
    try: getattr(Workflow(), 'listing' if command == 'list' else command)(**args)
    except (WorkflowError, OSError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
