"""Check every source file and local HTML asset without starting the app.

Run with the project Python environment. Results include the per-file inventory.
Runtime market data, virtual environments, binaries and generated output are
excluded; provider availability is checked separately against the running app.
"""
import ast
import json
import os
import subprocess
import tempfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
EXCLUDED_DIRS = (
    '.git',
    '.venv',
    '.freebuff',
    '.cloud-attachments',
    'data',
    'dist',
    'outputs',
    'verify',
    'reports',
    '.pytest_cache',
    '__pycache__',
    '.ruff_cache',
    'node_modules',
)


def _list_project_files():
    args = ['rg', '--files', '--hidden']
    for folder in EXCLUDED_DIRS:
        args += ['-g', '!' + folder + '/**']
    try:
        listed = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=True)
        return sorted(ROOT / line for line in listed.stdout.splitlines() if line.strip())
    except (FileNotFoundError, subprocess.CalledProcessError):
        pass
    excluded = set(EXCLUDED_DIRS)
    try:
        listed = subprocess.run(
            ['git', 'ls-files', '--cached', '--others', '--exclude-standard'],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        found = []
        for line in listed.stdout.splitlines():
            if not line.strip():
                continue
            candidate = ROOT / line
            rel_parts = candidate.relative_to(ROOT).parts
            if any(part in excluded for part in rel_parts):
                continue
            if candidate.is_file():
                found.append(candidate)
        return sorted(found)
    except (FileNotFoundError, subprocess.CalledProcessError):
        found = []
        for dirpath, dirnames, filenames in os.walk(ROOT):
            dirnames[:] = [d for d in dirnames if d not in excluded]
            base = Path(dirpath)
            for name in filenames:
                if name.startswith('_shot_') and name.endswith('.html'):
                    continue
                found.append(base / name)
        return sorted(found)


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids, self.assets, self.scripts = [], [], []
        self.inline = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            self.ids.append(attrs['id'])
        if tag in ('script', 'img', 'link'):
            url = attrs.get('src') or attrs.get('href')
            if url:
                self.assets.append(url)
        if tag == 'script' and not attrs.get('src') and attrs.get('type', '') not in ('application/json', 'application/ld+json'):
            self.inline = ''

    def handle_data(self, data):
        if self.inline is not None:
            self.inline += data

    def handle_endtag(self, tag):
        if tag == 'script' and self.inline is not None:
            if self.inline.strip():
                self.scripts.append(self.inline)
            self.inline = None


def main():
    paths = _list_project_files()
    results, failures = [], []
    def record(path, check, errors):
        row = {'file': path.relative_to(ROOT).as_posix(), 'check': check, 'ok': not errors}
        if errors:
            row['errors'] = errors
            failures.append(row)
        results.append(row)
    def js_check(path):
        proc = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
        return [] if proc.returncode == 0 else [proc.stderr[-1500:]]
    report = ROOT / 'reports' / 'codex-audit-static-results.json'
    report.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='softradex-static-audit-', dir=report.parent) as tmp:
        for path in paths:
            suffix = path.suffix.lower()
            if suffix == '.py':
                try:
                    ast.parse(path.read_text(encoding='utf-8-sig'), filename=str(path))
                    record(path, 'python-syntax', [])
                except (SyntaxError, UnicodeError) as exc:
                    record(path, 'python-syntax', [str(exc)])
            elif suffix in ('.js', '.cjs', '.mjs'):
                record(path, 'javascript-syntax', js_check(path))
            elif suffix == '.json':
                try:
                    json.loads(path.read_text(encoding='utf-8-sig'))
                    record(path, 'json-syntax', [])
                except (ValueError, UnicodeError) as exc:
                    record(path, 'json-syntax', [str(exc)])
            elif suffix in ('.html', '.htm'):
                page = Page()
                page.feed(path.read_text(encoding='utf-8-sig'))
                errors = ['duplicate id: ' + key for key, count in Counter(page.ids).items() if count > 1]
                for url in page.assets:
                    parsed = urlsplit(url)
                    if parsed.scheme or parsed.netloc or not parsed.path:
                        continue
                    asset = unquote(parsed.path)
                    target = ROOT / 'web' / asset[len('/static/'):] if asset.startswith('/static/') else (
                        ROOT / asset.lstrip('/') if asset.startswith('/') else path.parent / asset)
                    if not target.is_file():
                        errors.append('missing asset: ' + url)
                for idx, script in enumerate(page.scripts):
                    target = Path(tmp) / ('inline-' + str(idx) + '.js')
                    target.write_text(script, encoding='utf-8')
                    errors += js_check(target)
                record(path, 'html-assets-ids-inline-syntax', errors)
    output = {'summary': dict(Counter(row['check'] for row in results)),
              'failures': len(failures), 'files': results}
    report.write_text(json.dumps(output, indent=2), encoding='utf-8')
    print(json.dumps({'checks': output['summary'], 'failures': failures}, indent=2))
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
