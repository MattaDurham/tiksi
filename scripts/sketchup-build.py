#!/usr/bin/env python3
"""Keep the code that builds each SketchUp cloud model next to the model.

The SketchUp cloud MCP builds a model only by running Python (build_model) and
returns a download link from save_model. Its session expires and it cannot open
a .skp, so a model can only be changed by re-running the code that built it.

  archive  file a build in local-data/<project>/build/<label>/: the builder code,
           the .skp files, local post-step scripts, a README with the run steps
           and a manifest with each file's SHA-256
  hook     Claude Code hook (event JSON on stdin): journals every build_model
           call and downloads every save_model .skp into
           local-data/.sketchup-journal/<session>/, reminds the agent to file
           each save, and stops a turn once while the latest save is unfiled
  pending  list journaled saves and the archive that filed each one
  verify   recheck an archive folder against its manifest
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = Path(__file__).resolve()
JOURNAL = '.sketchup-journal'
SKP_MAGIC = b'\xff\xfe\xff\x0e' + 'SketchUp Model'.encode('utf-16-le')
LABEL = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
SESSION = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$')
TOOL = re.compile(r'^mcp__.+__(build_model|save_model)$')
SAVE_LINK = re.compile(r'/dl/([0-9A-Za-z-]{8,})/(\d+)-save/')
SKP_LINK = re.compile(r'https?://[^\s"\'<>]+?\.skp(?:\?[^\s"\'<>]*)?', re.I)
LOOPBACK = {'127.0.0.1', 'localhost', '::1'}

class BuildError(RuntimeError):
    pass

def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')

def digest(path):
    hasher = hashlib.sha256()
    with open(path, 'rb') as source:
        for block in iter(lambda: source.read(1 << 20), b''): hasher.update(block)
    return hasher.hexdigest()

def local_data():
    override = os.environ.get('TIKSI_LOCAL_DATA')
    if override: return Path(override).expanduser().resolve()
    # Linked worktrees share the live checkout's ignored local-data folder.
    result = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                            cwd=ROOT, text=True, encoding='utf-8', capture_output=True)
    base = Path(result.stdout.strip()).parent if result.returncode == 0 else ROOT
    return base / 'local-data'

def read_lines(path):
    if not path.exists(): return []
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]

def append_line(path, record):
    with path.open('a', encoding='utf-8') as output:
        output.write(json.dumps(record, ensure_ascii=False) + '\n')

def write_json(path, data):
    temp = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    temp.replace(path)

@contextmanager
def locked(folder):
    # Hooks for back-to-back tool calls can overlap; one writer numbers events.
    with (folder / '.lock').open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try: yield
        finally: fcntl.flock(handle, fcntl.LOCK_UN)

def journal(data, session):
    if not SESSION.fullmatch(str(session or '')):
        raise BuildError('A session id is letters, digits, dashes and underscores.')
    return data / JOURNAL / session

def check_skp(path, what):
    with open(path, 'rb') as source: head = source.read(len(SKP_MAGIC))
    if head != SKP_MAGIC:
        raise BuildError(f'{what} is not a SketchUp model; an expired link returns an error page instead.')

def fetch(link, destination):
    """Download a .skp link, keeping it only if it really is a SketchUp model."""
    parts = urllib.parse.urlsplit(link)
    loopback = parts.hostname in LOOPBACK
    if parts.scheme != 'https' and not (parts.scheme == 'http' and loopback):
        raise BuildError('SketchUp download links are https; refusing ' + (parts.scheme or 'that') + ' link.')
    # Loopback links (tests, local mirrors) must never go through a proxy.
    opener = urllib.request.build_opener(*([urllib.request.ProxyHandler({})] if loopback else []))
    temp = destination.with_name(f'.{destination.name}.{uuid.uuid4().hex}.part')
    try:
        with opener.open(link, timeout=60) as response, temp.open('xb') as output:
            shutil.copyfileobj(response, output)
        check_skp(temp, 'The download')
        temp.replace(destination)
    except urllib.error.HTTPError as exc:
        exc.close()
        raise BuildError(f'The link answered HTTP {exc.code}; it may have expired.') from None
    finally:
        temp.unlink(missing_ok=True)

def model_name(*candidates):
    for candidate in candidates:
        if not candidate: continue
        name = re.sub(r'[\x00-\x1f/\\:]', '-', str(candidate)).strip(' .')
        if name: return name if name.lower().endswith('.skp') else name + '.skp'
    return 'model.skp'

def walk(value):
    """Every dict and string in a tool response, with JSON text decoded too."""
    if isinstance(value, str):
        yield value
        if value.strip()[:1] in ('{', '['):
            try: yield from walk(json.loads(value))
            except ValueError: pass
    elif isinstance(value, dict):
        yield value
        for item in value.values(): yield from walk(item)
    elif isinstance(value, list):
        for item in value: yield from walk(item)

def failure(payload):
    if payload.get('hook_event_name') == 'PostToolUseFailure':
        return str(payload.get('error') or 'The call failed.')[:2000]
    for item in walk(payload.get('tool_response')):
        if not isinstance(item, dict): continue
        if 'errorType' in item:
            detail = item.get('detail') if isinstance(item.get('detail'), dict) else {}
            return str(detail.get('error') or item.get('message') or item['errorType'])[:2000]
        if item.get('isError') is True or item.get('is_error') is True:
            return 'The call reported an error.'
    return None

def save_link(payload):
    link = name = None
    ended = False
    for item in walk(payload.get('tool_response')):
        if isinstance(item, dict) and isinstance(item.get('download_url'), str):
            link, name = link or item['download_url'], name or item.get('filename')
            ended = ended or item.get('session_ended') is True
    if link is None:
        found = next((match.group(0) for item in walk(payload.get('tool_response'))
                      if isinstance(item, str) for match in [SKP_LINK.search(item)] if match), None)
        link = found
    return link, name, ended

def record_event(payload, data):
    """Journal one build_model or save_model call; return its event record."""
    tool = TOOL.fullmatch(str(payload.get('tool_name') or '')).group(1)
    folder = journal(data, payload.get('session_id'))
    for part in ('calls', 'saves'): (folder / part).mkdir(parents=True, exist_ok=True)
    request = payload.get('tool_input') or {}
    with locked(folder):
        events = read_lines(folder / 'events.jsonl')
        seq = (events[-1]['seq'] if events else 0) + 1
        if not (folder / 'session.json').exists():
            write_json(folder / 'session.json', {'session': folder.name, 'started': now(),
                       'transcript': payload.get('transcript_path'), 'cwd': payload.get('cwd'),
                       'tool': str(payload.get('tool_name')).rsplit('__', 1)[0]})
        error = failure(payload)
        record = {'seq': seq, 'time': now(), 'tool': tool, 'ok': error is None}
        if error: record['error'] = error
        if tool == 'build_model':
            path = folder / 'calls' / f'{seq:04d}.py'
            path.write_text(str(request.get('code') or ''), encoding='utf-8')
            record.update(clean=request.get('clean') is True, file=f'calls/{path.name}', sha256=digest(path))
        else:
            link, name, ended = save_link(payload)
            name = model_name(name, request.get('filename'),
                              link and urllib.parse.unquote(urllib.parse.urlsplit(link).path.rsplit('/', 1)[-1]))
            record.update(requested=request.get('filename'), name=name, url=link, session_ended=ended)
            step = SAVE_LINK.search(link or '')
            if step: record.update(cloud_session=step.group(1), cloud_step=int(step.group(2)))
            if link and error is None:
                path = folder / 'saves' / f'{seq:04d}-{name}'
                try:
                    fetch(link, path)
                    record.update(file=f'saves/{path.name}', sha256=digest(path))
                except (OSError, BuildError) as exc:
                    record['download_error'] = str(exc)[:500]
            elif error is None:
                record.update(ok=False, error='The save returned no download link.')
        append_line(folder / 'events.jsonl', record)
    return record

def replay(events, saves):
    """Order the calls that rebuild each chosen save from an empty model.

    Each save link names its cloud session and that session's step counter,
    which counts every call (failed ones too). The model a save holds was built
    from the session's first call, or from its last clean: true call."""
    position = {event['seq']: index for index, event in enumerate(events)}
    plans = []
    for save in sorted(saves, key=lambda item: item['seq']):
        index = position[save['seq']]
        clean = next((i for i in range(index - 1, -1, -1)
                      if events[i]['tool'] == 'build_model' and events[i].get('clean')), None)
        problems = []
        first = None
        if save.get('cloud_step'):
            first = index - (save['cloud_step'] - 1)
            for other in events:
                if other['tool'] != 'save_model' or other['seq'] == save['seq'] or not other.get('cloud_step'): continue
                same = other.get('cloud_session') == save.get('cloud_session')
                gap = position[other['seq']] - index
                if same and other['cloud_step'] - save['cloud_step'] != gap:
                    problems.append(f'save {other["seq"]} and this save disagree about how many calls ran')
                if not same and first <= position[other['seq']] < index:
                    problems.append(f'save {other["seq"]} came from another cloud session inside this range')
            if first < 0 and (clean is None or clean < 0):
                problems.append(f'the journal began after this cloud session; {-first} earlier call(s) are missing')
        else:
            problems.append('the save link has no step counter, so the range rests on clean: true alone')
            if clean is None: problems.append('no clean: true call precedes the save')
        if problems or first is None: start = clean if clean is not None else 0
        else: start = clean if clean is not None and clean >= first else max(first, 0)
        calls = [event for event in events[start:index] if event['tool'] == 'build_model']
        plans.append({'save': save, 'start': start, 'index': index, 'calls': calls,
                      'verified': not problems, 'problems': problems})
    return plans

def steps_for(plans):
    """Run steps across saves: continue the live model where a save builds on the last."""
    steps, previous = [], None
    for plan in plans:
        fresh = previous is None or plan['start'] > previous['index']
        calls = plan['calls'] if fresh else [c for c in plan['calls'] if c['seq'] > previous['save']['seq']]
        for number, call in enumerate(calls):
            steps.append({'call': call, 'clean': fresh and number == 0})
        if fresh and not calls: steps.append({'note': 'Start from an empty model (build_model with clean: true).'})
        steps.append({'save': plan['save']})
        previous = plan
    return steps

def ensure_private(path):
    probe = path
    while not probe.exists(): probe = probe.parent
    inside = subprocess.run(['git', '-C', str(probe), 'rev-parse', '--show-toplevel'],
                            capture_output=True, text=True)
    if inside.returncode: return
    ignored = subprocess.run(['git', '-C', str(probe), 'check-ignore', '-q', str(path)])
    if ignored.returncode:
        raise BuildError(f'{path} would be tracked by Git; builds belong in ignored local-data.')

def project_folder(value, data):
    given = Path(value).expanduser()
    folder = given.resolve() if given.is_absolute() or '/' in value else data / value
    if not folder.is_dir():
        raise BuildError(f'No project folder at {folder}; pass a folder name in {data} or a path.')
    return folder

def place(source, folder, name, files, role):
    destination = folder / name
    if destination.exists():
        raise BuildError(f'Two files would both be {name}; rename one.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)
    files.append({'path': destination.relative_to(folder).as_posix(), 'role': role})
    return destination

def archive(args, data=None):
    data = data or local_data()
    if not LABEL.fullmatch(args.label):
        raise BuildError('A label is letters, digits, dots, dashes and underscores, e.g. draft-8.')
    if not args.code and not args.session:
        raise BuildError('Give the build code: --code FILE (in run order) and/or --session ID.')
    if args.save and not args.session:
        raise BuildError('--save numbers refer to a session journal; add --session.')
    for path in [*args.code, *args.post]:
        if not path.is_file(): raise BuildError(f'No file at {path}.')
    project = project_folder(args.project, data)
    target = project / 'build' / args.label
    if target.exists(): raise BuildError(f'{target} exists; choose a new label.')
    ensure_private(target)

    plans, session, events, folder = [], None, [], None
    if args.session:
        folder = journal(data, args.session)
        events = read_lines(folder / 'events.jsonl')
        session = json.loads((folder / 'session.json').read_text(encoding='utf-8')) if events else None
        saves = {event['seq']: event for event in events if event['tool'] == 'save_model' and event.get('ok')}
        if not saves: raise BuildError(f'The journal for session {args.session} holds no saved model.')
        chosen = args.save or [max(saves)]
        missing = [seq for seq in chosen if seq not in saves]
        if missing: raise BuildError(f'No saved model numbered {missing[0]}; `pending --session {args.session}` lists them.')
        plans = replay(events, [saves[seq] for seq in sorted(set(chosen))])

    (project / 'build').mkdir(exist_ok=True)
    staging = project / 'build' / f'.{args.label}.{uuid.uuid4().hex}.tmp'
    staging.mkdir()
    files, models = [], {}
    try:
        for path in args.code: place(path, staging, f'code/{path.name}', files, 'code')
        for plan in plans:
            for call in plan['calls']:
                if not (staging / call['file']).exists():
                    place(folder / call['file'], staging, call['file'], files, 'call')
            save = plan['save']
            name = save['name'] if not (staging / 'models' / save['name']).exists() else f'{save["seq"]:04d}-{save["name"]}'
            source = folder / save['file'] if save.get('file') else None
            if source is None or not source.is_file():
                if not save.get('url'): raise BuildError(f'Save {save["seq"]} has no .skp and no link.')
                (staging / 'models').mkdir(exist_ok=True)
                try: fetch(save['url'], staging / 'models' / name)
                except (OSError, BuildError) as exc:
                    raise BuildError(f'Save {save["seq"]} was never downloaded and its link failed ({exc}). '
                                     'Download the .skp, pass it with --skp and leave this --save out.')
                files.append({'path': f'models/{name}', 'role': 'model'})
            else:
                place(source, staging, f'models/{name}', files, 'model')
            models[save['seq']] = f'models/{name}'
        for item in args.skp:
            if re.match(r'^https?://', item, re.I):
                name = model_name(urllib.parse.unquote(urllib.parse.urlsplit(item).path.rsplit('/', 1)[-1]))
                if (staging / 'models' / name).exists(): raise BuildError(f'Two models would both be models/{name}.')
                (staging / 'models').mkdir(exist_ok=True)
                fetch(item, staging / 'models' / name)
                files.append({'path': f'models/{name}', 'role': 'model', 'url': item.split('?', 1)[0]})
            else:
                path = Path(item).expanduser()
                if not path.is_file(): raise BuildError(f'No .skp at {path}.')
                check_skp(path, str(path))
                place(path, staging, f'models/{path.name}', files, 'model')
        for path in args.post: place(path, staging, f'post/{path.name}', files, 'post')
        if not any(entry['role'] == 'model' for entry in files):
            raise BuildError('No model to keep: pass --skp or --session with a saved model.')
        for entry in files:
            path = staging / entry['path']
            entry.update(bytes=path.stat().st_size, sha256=digest(path))
        when = now()
        steps = steps_for(plans)
        readme = render_readme(project.name, args, when, session, plans, steps, models, files)
        (staging / 'README.md').write_text(readme, encoding='utf-8')
        files.append({'path': 'README.md', 'role': 'readme', 'bytes': (staging / 'README.md').stat().st_size,
                      'sha256': digest(staging / 'README.md')})
        manifest = {
            'schema': 1, 'project': project.name, 'label': args.label, 'created': when,
            'source': args.source, 'tool': 'scripts/sketchup-build.py',
            'session': session and {'id': session['session'], 'transcript': session.get('transcript')},
            'code': [f'code/{path.name}' for path in args.code],
            'replay': [{'save': plan['save']['seq'], 'model': models[plan['save']['seq']],
                        'calls': [call['file'] for call in plan['calls']], 'verified': plan['verified'],
                        'problems': plan['problems'], 'cloud_session': plan['save'].get('cloud_session'),
                        'link': (plan['save'].get('url') or '').split('?', 1)[0] or None} for plan in plans],
            'steps': args.step, 'notes': args.note, 'files': files}
        write_json(staging / 'manifest.json', manifest)
        staging.rename(target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    if folder is not None:
        with locked(folder):
            append_line(folder / 'filed.jsonl', {'time': when, 'saves': [plan['save']['seq'] for plan in plans],
                                                 'archive': str(target)})
    return target, plans

def render_readme(project, args, when, session, plans, steps, models, files):
    lines = [f'# {project} / {args.label}: SketchUp build', '',
             f'Archived {when} with `scripts/sketchup-build.py`.']
    if args.source: lines.append(f'Source: {args.source}.')
    if session: lines.append(f'Claude Code session `{session["session"]}`.')
    lines += ['', 'The SketchUp cloud MCP cannot open a .skp and its session expires. To change',
              'this model, edit the code here and rebuild it; do not start over.', '',
              '## Rebuild', '', 'Before the first `build_model`, call `list_skills`, then `read_skill` for',
              'every baseline skill.', '']
    if args.code:
        lines += ['### From the builder code', '']
        for number, path in enumerate(args.code, 1):
            clean = ' with `clean: true`' if number == 1 else ''
            lines.append(f'{number}. `build_model`{clean} and the code in `code/{path.name}`.')
        lines += [f'{len(args.code) + 1}. `save_model`, then download the .skp.', '']
    if plans:
        lines += ['### Exact replay of the recorded calls', '',
                  'Every `build_model` call is kept unchanged, failed ones included: a failed',
                  'call ran up to its error, so replay it as it is.', '']
        for plan in plans:
            if not plan['verified']:
                lines.append(f'Check save {plan["save"]["seq"]} by hand: ' + '; '.join(plan['problems']) + '.')
        if any(not plan['verified'] for plan in plans): lines.append('')
        for number, step in enumerate(steps, 1):
            if 'call' in step:
                call = step['call']
                clean = ' with `clean: true`' if step['clean'] else ''
                failed = ' (failed when recorded)' if not call.get('ok') else ''
                lines.append(f'{number}. `build_model`{clean} and the code in `{call["file"]}`{failed}.')
            elif 'save' in step:
                save = step['save']
                lines.append(f'{number}. `save_model` with filename "{save["name"]}"; '
                             f'the result is `{models[save["seq"]]}`.')
            else:
                lines.append(f'{number}. {step["note"]}')
        lines.append('')
    if args.step:
        lines += ['## After the cloud build', '']
        lines += [f'{number}. {text}' for number, text in enumerate(args.step, 1)]
        lines.append('')
    if args.note:
        lines += ['## Notes', '', *[f'- {text}' for text in args.note], '']
    lines += ['## Files', '', '| File | Bytes | SHA-256 |', '| --- | ---: | --- |']
    lines += [f'| `{entry["path"]}` | {entry["bytes"]} | `{entry["sha256"]}` |' for entry in files]
    lines += ['', '`python3 scripts/sketchup-build.py verify <this folder>` rechecks these checksums.', '']
    return '\n'.join(lines)

def range_text(plan):
    calls = plan['calls']
    if not calls: return 'no build_model calls'
    text = f'calls {calls[0]["seq"]}-{calls[-1]["seq"]}' if len(calls) > 1 else f'call {calls[0]["seq"]}'
    return text if plan['verified'] else text + ' (unverified: ' + '; '.join(plan['problems']) + ')'

def reminder(record, data, session):
    events = read_lines(journal(data, session) / 'events.jsonl')
    plan = replay(events, [record])[0]
    model = (f'.skp kept at {journal(data, session) / record["file"]}' if record.get('file')
             else f'.skp NOT downloaded ({record.get("download_error", "no link")}); download it yourself')
    return (f'Tiksi journaled this SketchUp save as #{record["seq"]} ("{record["name"]}"; {model}). '
            f'Its build code is {range_text(plan)} in {journal(data, session)}. '
            'Every saved model keeps the code that built it (AGENTS.md). When this model goes into a '
            f'project, file it: python3 "{SCRIPT}" archive --project <folder in local-data> '
            f'--label <draft-N> --session {session} --save {record["seq"]} '
            '(repeat --save for other options; add --code for a cleaned-up builder, --post and '
            '--step for local post-processing, --skp for the post-processed .skp).')

def stop_gate(payload, data):
    """Hold the end of a turn once while the session's latest save is unfiled."""
    session = str(payload.get('session_id') or '')
    if payload.get('stop_hook_active') or not SESSION.fullmatch(session): return None
    folder = data / JOURNAL / session
    if not (folder / 'events.jsonl').exists(): return None
    with locked(folder):
        saves = [event for event in read_lines(folder / 'events.jsonl')
                 if event['tool'] == 'save_model' and event.get('ok')]
        if not saves: return None
        latest = saves[-1]
        filed = {seq for record in read_lines(folder / 'filed.jsonl') for seq in record['saves']}
        gate = json.loads((folder / 'gate.json').read_text(encoding='utf-8')) if (folder / 'gate.json').exists() else {}
        if latest['seq'] in filed or latest['seq'] <= gate.get('reminded', 0): return None
        write_json(folder / 'gate.json', {'reminded': latest['seq']})
    return {'decision': 'block', 'reason': (
        f'SketchUp save #{latest["seq"]} ("{latest["name"]}") is not filed with the code that built it. '
        f'If it belongs to a project, file it before you finish: python3 "{SCRIPT}" archive --project '
        f'<folder in local-data> --label <draft-N> --session {session} --save {latest["seq"]}. '
        '`pending` lists every save. If it was a throwaway probe, say so and finish; '
        'this save will not stop you again.')}

def run_hook(payload, data=None):
    event = payload.get('hook_event_name')
    data = data or local_data()
    if event == 'Stop': return stop_gate(payload, data)
    if not TOOL.fullmatch(str(payload.get('tool_name') or '')): return None
    record = record_event(payload, data)
    if record['tool'] != 'save_model' or not record['ok']: return None
    return {'hookSpecificOutput': {'hookEventName': event or 'PostToolUse',
                                   'additionalContext': reminder(record, data, payload['session_id'])}}

def pending(data, session=None):
    rows = []
    root = data / JOURNAL
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        if session and folder.name != session or not folder.is_dir(): continue
        filed = {}
        for record in read_lines(folder / 'filed.jsonl'):
            for seq in record['saves']: filed[seq] = record['archive']
        for event in read_lines(folder / 'events.jsonl'):
            if event['tool'] != 'save_model' or not event.get('ok'): continue
            kept = 'skp kept' if event.get('file') else 'skp missing'
            rows.append(f'{folder.name}  #{event["seq"]}  {event["time"]}  {event["name"]}  {kept}  '
                        + (f'filed in {filed[event["seq"]]}' if event['seq'] in filed else 'not filed'))
    return rows

def verify(folder):
    manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
    problems, listed = [], {'manifest.json'}
    for entry in manifest['files']:
        path = folder / entry['path']
        listed.add(entry['path'])
        if not path.is_file(): problems.append(f'missing {entry["path"]}')
        elif digest(path) != entry['sha256']: problems.append(f'changed {entry["path"]}')
    for path in sorted(folder.rglob('*')):
        relative = path.relative_to(folder).as_posix()
        if path.is_file() and relative not in listed: problems.append(f'not in manifest {relative}')
    return problems

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest='command', required=True)
    archive_parser = commands.add_parser('archive', help='file a build next to its model')
    archive_parser.add_argument('--project', required=True, help='project folder name in local-data, or a path')
    archive_parser.add_argument('--label', required=True, help='build folder name, e.g. draft-8')
    archive_parser.add_argument('--code', action='append', default=[], type=Path,
                                help='builder code; one build_model call per file, in run order')
    archive_parser.add_argument('--session', help='Claude Code session whose journaled calls rebuild the saves')
    archive_parser.add_argument('--save', action='append', default=[], type=int,
                                help='journal number of a save to file (default: the latest)')
    archive_parser.add_argument('--skp', action='append', default=[], help='a .skp file or https link to keep')
    archive_parser.add_argument('--post', action='append', default=[], type=Path, help='a local post-step script')
    archive_parser.add_argument('--step', action='append', default=[], help='a step after the cloud build, in order')
    archive_parser.add_argument('--note', action='append', default=[], help='a note for the README')
    archive_parser.add_argument('--source', help='where the build came from, e.g. a conversation')
    commands.add_parser('hook', help='Claude Code hook; reads the event JSON on stdin')
    pending_parser = commands.add_parser('pending', help='list journaled saves')
    pending_parser.add_argument('--session')
    verify_parser = commands.add_parser('verify', help='recheck an archive against its manifest')
    verify_parser.add_argument('folder', type=Path)
    args = parser.parse_args(argv)

    if args.command == 'hook':
        payload = {}
        try:
            payload = json.load(sys.stdin)
            result = run_hook(payload)
        except Exception as exc:  # A hook reports trouble; it never blocks the session.
            event = payload.get('hook_event_name') if isinstance(payload, dict) else None
            if event not in ('PostToolUse', 'PostToolUseFailure'):
                print(f'sketchup-build hook: {exc}', file=sys.stderr)
                return 0
            result = {'hookSpecificOutput': {'hookEventName': event, 'additionalContext': (
                f'Tiksi could not journal this SketchUp call ({exc}). Keep its build code yourself: '
                f'write the code you ran to files and run python3 "{SCRIPT}" archive --code <file> ...')}}
        if result: print(json.dumps(result))
        return 0
    try:
        if args.command == 'archive':
            target, plans = archive(args)
            print(target)
            for plan in plans:
                if not plan['verified']:
                    print(f'Check save {plan["save"]["seq"]}: ' + '; '.join(plan['problems']), file=sys.stderr)
        elif args.command == 'pending':
            rows = pending(local_data(), args.session)
            print('\n'.join(rows) if rows else 'No journaled saves.')
        else:
            problems = verify(args.folder)
            for problem in problems: print(problem, file=sys.stderr)
            if problems: return 1
            print(f'{args.folder}: every file matches its manifest.')
    except (BuildError, OSError, ValueError) as exc:
        print(f'sketchup-build: {exc}', file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__': sys.exit(main())
