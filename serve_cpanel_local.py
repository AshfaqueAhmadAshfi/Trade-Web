"""Run the dashboard exactly the way cPanel/Passenger will run it.

    python serve_cpanel_local.py        # then open http://127.0.0.1:8799/

Passenger speaks WSGI and never upgrades a WebSocket, so this is the honest
local check before uploading to cPanel: the browser falls back to HTTP polling,
the gzip middleware and the news-thinning state feed all behave there the same
way they will on the shared host (uvicorn, by contrast, would serve WebSockets
and hide those problems).
"""
import os
import argparse
import sys
from pathlib import Path
from socketserver import ThreadingMixIn
from wsgiref.simple_server import WSGIServer, make_server, WSGIRequestHandler

parser = argparse.ArgumentParser(description="Serve the actual Passenger entry point locally")
parser.add_argument("--port", type=int, default=8799)
parser.add_argument("--app-root", type=Path, default=Path(__file__).resolve().parent)
args = parser.parse_args()
if not 1 <= args.port <= 65535:
    parser.error("Port must be between 1 and 65535")
ROOT = args.app_root.resolve()
if not (ROOT / "passenger_wsgi.py").is_file():
    parser.error("Application root must contain passenger_wsgi.py")
sys.path.insert(0, str(ROOT))
os.chdir(str(ROOT))

os.environ.setdefault("SOFTRADEX_MODE", "public")

from passenger_wsgi import application  # noqa: E402


class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
    daemon_threads = True


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


httpd = make_server(
    "127.0.0.1", args.port, application,
    server_class=ThreadingWSGIServer, handler_class=QuietHandler,
)
print(f"Passenger WSGI preview: http://127.0.0.1:{args.port}/dashboard", flush=True)
httpd.serve_forever()
