"""Build a clean Passenger upload ZIP without local configuration or runtime data."""
import argparse
import ast
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
WEB_TYPES = {".html", ".htm", ".js", ".css", ".svg", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".ico", ".woff", ".woff2"}


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.errors = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "id" in attrs:
            if attrs["id"] in self.ids:
                self.errors.append("Duplicate HTML id: " + attrs["id"])
            self.ids.add(attrs["id"])


def release_files(root):
    root = Path(root).resolve()
    files = {"passenger_wsgi.py": (root / "passenger_wsgi.py").read_bytes(),
             "requirements.txt": (root / "requirements-cpanel.txt").read_bytes(),
             "DEPLOY-CPANEL.md": (root / "DEPLOY-CPANEL.md").read_bytes()}
    for path in sorted((root / "backend").glob("*.py")):
        ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        files[path.relative_to(root).as_posix()] = path.read_bytes()
    ast.parse(files["passenger_wsgi.py"].decode("utf-8-sig"))
    for path in sorted((root / "web").rglob("*")):
        if path.is_file() and path.suffix.lower() in WEB_TYPES and not any(p.startswith((".", "_shot")) for p in path.relative_to(root / "web").parts):
            files[path.relative_to(root).as_posix()] = path.read_bytes()
    for name in list(files):
        if not name.endswith((".html", ".htm")):
            continue
        def version(match):
            url = urlsplit(match[2])
            asset = "web/" + unquote(url.path[len("/static/"):])
            if asset not in files:
                raise ValueError("Missing release asset: " + match[2])
            query = [(k, v) for k, v in parse_qsl(url.query) if k != "v"]
            query.append(("v", hashlib.sha256(files[asset]).hexdigest()[:12]))
            return match[1] + url.path + "?" + urlencode(query) + match[3]
        text = re.sub(r'((?:src|href)=["\'])(/static/[^"\']+)(["\'])', version, files[name].decode("utf-8-sig"))
        page = Page()
        page.feed(text)
        if page.errors:
            raise ValueError("; ".join(page.errors))
        files[name] = text.encode("utf-8")
    files["UPLOAD-README.txt"] = (
        "SoftradeX cPanel upload\n\n"
        "Extract into the private Python application root, e.g. /home/USER/softradex.\n"
        "Do not put backend, config or data in public_html.\n"
        "Use a domain/subdomain root URL, Python 3.11+, passenger_wsgi.py, entry point application.\n"
        "Install requirements.txt in the cPanel app virtual environment.\n"
        "Set SOFTRADEX_DASHBOARD_PASSWORD in cPanel Environment Variables before restart.\n"
        "Enable SSL and permit outbound HTTPS/WSS to public market providers.\n"
        "The app creates private data/config folders on first startup.\n"
        "Retain existing data/config folders when updating a live site.\n"
        "Full instructions: DEPLOY-CPANEL.md.\n"
    ).encode("utf-8")
    manifest = {"format": 1, "python": "3.11+", "startup": "passenger_wsgi.py", "entry_point": "application",
                "files": {name: {"bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()}
                          for name, body in sorted(files.items())}}
    files["release-manifest.json"] = json.dumps(manifest, indent=2).encode("utf-8")
    return files


def build(root=ROOT, destination=None):
    root = Path(root).resolve()
    destination = Path(destination or root / "dist" / "softradex-cpanel-ready.zip").resolve()
    if not destination.is_relative_to(root / "dist"):
        raise ValueError("Release output must stay inside the workspace dist directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    files = release_files(root)
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name, body in sorted(files.items()):
            entry = ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = ZIP_DEFLATED
            archive.writestr(entry, body)
    return {"archive": str(destination), "files": len(files), "bytes": destination.stat().st_size,
            "sha256": hashlib.sha256(destination.read_bytes()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    print(json.dumps(build(destination=args.output), indent=2))


if __name__ == "__main__":
    main()
