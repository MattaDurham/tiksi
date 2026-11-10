#!/usr/bin/env python3
"""Find Python names that do not exist before the code runs.

Reports, for the Python files in scripts/, tools/, server/, test/ and tests/:
  - a name used that nothing defines (not the file, not Python's built-ins);
  - `from server.x import name` (or another project file) where that file has no such name;
  - a top-level import that nothing in the file uses.
Known cases not fixed yet are listed in scripts/check-names-allow.json, as for the
JavaScript check. Only the standard library is used.
"""
import ast
import builtins
import json
from pathlib import Path
import symtable
import sys

ROOT = Path.cwd()
HERE = Path(__file__).resolve().parent
FOLDERS = ['scripts', 'tools', 'server', 'test', 'tests']
MODULE_NAMES = {'__file__', '__name__', '__doc__', '__spec__', '__builtins__', '__loader__',
                '__package__', '__path__', '__annotations__', '__dict__', '__debug__',
                '__cached__', '__conditional_annotations__', '__annotate__', '__qualname__',
                '__module__', '__class__'}
BUILTINS = set(dir(builtins))


def tables(table):
    yield table
    for child in table.get_children():
        yield from tables(child)


def top_names(tree):
    """Names a module defines at its top level, wherever in the file they are bound."""
    names = set()
    star = False
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(node.name)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                if alias.name == '*': star = True
                else: names.add((alias.asname or alias.name).split('.')[0])
        elif isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            names.add(node.id)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            names.add(node.name)
        elif isinstance(node, ast.Global):
            names.update(node.names)
        elif hasattr(ast, 'MatchAs') and isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            names.add(node.name)
        elif hasattr(ast, 'MatchMapping') and isinstance(node, ast.MatchMapping) and node.rest:
            names.add(node.rest)
    return names, star


def project_module(name):
    """A project file for an absolute module name such as server.workspace, else None."""
    path = ROOT.joinpath(*name.split('.'))
    if path.with_suffix('.py').is_file(): return path.with_suffix('.py')
    if (path / '__init__.py').is_file(): return path / '__init__.py'
    return None


def check(path, report):
    rel = path.relative_to(ROOT).as_posix()
    source = path.read_text(encoding='utf-8')
    try:
        tree = ast.parse(source, filename=rel)
        table = symtable.symtable(source, rel, 'exec')
    except SyntaxError as exc:
        report(rel, exc.lineno or 0, 'syntax', '', f'does not parse: {exc.msg}')
        return
    defined, star = top_names(tree)
    lines = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id not in lines: lines[node.id] = node.lineno
    referenced = set()
    for scope in tables(table):
        for symbol in scope.get_symbols():
            if not symbol.is_referenced(): continue
            name = symbol.get_name()
            referenced.add(name)
            local = scope.get_type() != 'module' and (symbol.is_local() or symbol.is_free() or symbol.is_parameter())
            if local and not symbol.is_global(): continue
            if scope.get_type() == 'class' and symbol.is_assigned(): continue
            if name in defined or name in BUILTINS or name in MODULE_NAMES or star: continue
            report(rel, lines.get(name, 0), 'undefined', name, f'{name} is not defined anywhere')
    # Names exported as strings, in __all__ or in attribute access through globals(), count as uses.
    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name): referenced.add(node.value.id)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value.isidentifier():
            referenced.add(node.value)
    if path.name != '__init__.py':
        for node in tree.body:
            if not isinstance(node, (ast.Import, ast.ImportFrom)): continue
            if isinstance(node, ast.ImportFrom) and node.module == '__future__': continue
            for alias in node.names:
                if alias.name == '*': continue
                bound = (alias.asname or alias.name).split('.')[0]
                if bound not in referenced:
                    report(rel, node.lineno, 'unused-import', bound, f'imports {bound} and never uses it')
    for node in ast.walk(tree):
        if not isinstance(node, ast.ImportFrom) or node.level or not node.module: continue
        target = project_module(node.module)
        if target is None: continue
        names, open_ = top_names(ast.parse(target.read_text(encoding='utf-8')))
        for alias in node.names:
            if alias.name == '*' or open_: continue
            if alias.name in names or project_module(node.module + '.' + alias.name): continue
            report(rel, node.lineno, 'missing-export', f'{node.module} {alias.name}',
                   f'imports {alias.name} from {node.module}, which does not define it')


def main():
    if sys.argv[1:]:
        print(f'Unknown argument {sys.argv[1]}', file=sys.stderr)
        return 2
    allow_file = HERE / 'check-names-allow.json'
    allowed = json.loads(allow_file.read_text(encoding='utf-8')).get('allow', []) if allow_file.exists() else []
    problems = []
    used = set()
    def report(file, line, kind, name, text):
        for index, a in enumerate(allowed):
            if a['file'] == file and a['kind'] == kind and a['name'] == name:
                used.add(index)
                return
        problems.append(f'{file}:{line}: {text}')
    count = 0
    for folder in FOLDERS:
        for path in sorted((ROOT / folder).glob('*.py')):
            count += 1
            check(path, report)
        if (ROOT / folder).is_dir():
            for path in sorted((ROOT / folder).glob('*/*.py')):
                if '__pycache__' in path.parts: continue
                count += 1
                check(path, report)
    for index, a in enumerate(allowed):
        if a['file'].endswith('.py') and index not in used:
            print(f"Warning: {a['file']} {a['kind']} {a['name']} no longer happens; remove it from scripts/check-names-allow.json")
    for problem in problems: print(problem, file=sys.stderr)
    if problems:
        print(f'check-names: {len(problems)} problem(s) in {count} Python files.', file=sys.stderr)
        return 1
    print(f'check-names: {count} Python files, every name and project import resolves.')
    return 0


if __name__ == '__main__': sys.exit(main())
