"""Check every source file and local HTML asset without starting the app.

Run with the project Python environment. Results include the per-file inventory.
Runtime market data, virtual environments, binaries and generated output are
excluded; provider availability is checked separately against the running app.
"""
import ast
import json
import subprocess
import tempfile
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent


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
    args = ['rg', '--files', '--hidden']
    for folder in ('.git', '.venv', '.freebuff', '.cloud-attachments', 'data', 'dist', 'outputs', 'verify', '.pytest_cache'):
        args += ['-g', '!' + folder + '/**']
    listed = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, check=True)
    paths = sorted(ROOT / line for line in listed.stdout.splitlines())
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
    with tempfile.TemporaryDirectory(prefix='softradex-static-audit-') as tmp:
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
    report = ROOT / 'reports' / 'codex-audit-static-results.json'
    report.parent.mkdir(exist_ok=True)
    report.write_text(json.dumps(output, indent=2), encoding='utf-8')
    print(json.dumps({'checks': output['summary'], 'failures': failures}, indent=2))
    return bool(failures)


if __name__ == '__main__':
    raise SystemExit(main())
