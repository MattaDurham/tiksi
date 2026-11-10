#!/usr/bin/env python3
"""Find Python names that do not exist before the code runs.

Reports, for the Python files in scripts/, tools/, server/, test/ and tests/:
  - a name used that nothing defines (not the file, not Python's built-ins);
  - `from server.x import name` (or another project file) where that file has no such name;
  - a top-level import that nothing in the file uses (a string holding its name is not a use,
    except in __all__).
A file with `from x import *` gets its names from x when x is a project file; when x is a
package, the names it brings cannot be known, so that file's names are not checked for being
defined, and a note says so.
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


def module_names(source, rel, seen=None):
    """The names a module defines at module level: what its top level binds, plus what its
    functions bind after `global name`. A local of one function is not among them.
    Returns (names, unknown): unknown names the modules a `from x import *` reads that are not
    project files, whose names cannot be known without running them."""
    table = symtable.symtable(source, rel, 'exec')
    names, unknown = set(), []
    for symbol in table.get_symbols():
        if symbol.is_assigned() or symbol.is_imported() or symbol.is_namespace():
            names.add(symbol.get_name())
    for scope in tables(table):
        if scope is table: continue
        for symbol in scope.get_symbols():
            if symbol.is_declared_global() and symbol.is_assigned(): names.add(symbol.get_name())
    seen = (seen or set()) | {rel}
    for node in ast.parse(source).body:
        if isinstance(node, ast.ImportFrom) and any(a.name == '*' for a in node.names):
            target = project_module(node.module) if node.module and not node.level else None
            if target is None or target.relative_to(ROOT).as_posix() in seen:
                unknown.append(node.module or '.')
                continue
            inner, more = module_names(target.read_text(encoding='utf-8'), target.relative_to(ROOT).as_posix(), seen)
            names.update(n for n in inner if not n.startswith('_'))
            unknown += more
    return names, unknown


def project_module(name):
    """A project file for an absolute module name such as server.workspace, else None."""
    path = ROOT.joinpath(*name.split('.'))
    if path.with_suffix('.py').is_file(): return path.with_suffix('.py')
    if (path / '__init__.py').is_file(): return path / '__init__.py'
    return None


def use_line(tree, scope, name):
    """The first line where this scope reads the name."""
    owner = tree
    if scope.get_type() != 'module':
        owner = next((n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda))
                      and n.lineno == scope.get_lineno() and getattr(n, 'name', 'lambda') == scope.get_name()), tree)
    found = [n.lineno for n in ast.walk(owner) if isinstance(n, ast.Name) and n.id == name and isinstance(n.ctx, ast.Load)]
    return min(found) if found else None


def check(path, report):
    rel = path.relative_to(ROOT).as_posix()
    source = path.read_text(encoding='utf-8')
    try:
        tree = ast.parse(source, filename=rel)
        table = symtable.symtable(source, rel, 'exec')
    except SyntaxError as exc:
        report(rel, exc.lineno or 0, 'syntax', '', f'does not parse: {exc.msg}')
        return
    defined, unknown = module_names(source, rel)
    if unknown:
        print(f'note: {rel} imports * from {", ".join(unknown)}, so names it uses are not checked for being defined')
    lines = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and node.id not in lines: lines[node.id] = node.lineno
    referenced = set()
    for scope in tables(table):
        for symbol in scope.get_symbols():
            if not symbol.is_referenced(): continue
            name = symbol.get_name()
            referenced.add(name)
            # A name bound in this function, or in a function around it, is that function's.
            if scope.get_type() != 'module' and not symbol.is_global(): continue
            if name in defined or name in BUILTINS or name in MODULE_NAMES or unknown: continue
            report(rel, use_line(tree, scope, name) or lines.get(name, 0), 'undefined', name, f'{name} is not defined anywhere')
    # Only __all__ makes a name in a string a use: a string that happens to hold the name is not.
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '__all__' for t in node.targets):
            for item in ast.walk(node.value):
                if isinstance(item, ast.Constant) and isinstance(item.value, str): referenced.add(item.value)
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
        names, open_ = module_names(target.read_text(encoding='utf-8'), target.relative_to(ROOT).as_posix())
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
