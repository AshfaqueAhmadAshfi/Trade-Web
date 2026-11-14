"""Dashboard access control (audit findings C1 / C2).

``POST /api/bot3/start`` places a real order on the connected Exness account.
Before this module the only gate on that route was a string inside
``web/app.js``, which ships to every visitor, so anyone who could reach the
host could drive the live account.

Policy:

* Local desktop stays friction-free - bound to 127.0.0.1 the gate is only used
  when ``require_login`` is set explicitly in config/config.json.
* Anything reachable from outside is gated automatically: a non-loopback
  ``HOST`` env or ``host`` config (docker sets 0.0.0.0, a cPanel vhost is
  public) turns it on.
* Only mutating requests need a session. The read-only snapshot endpoints stay
  open; the two GET routes that mutate anyway are treated as mutating.
* The EA bridge keeps its own token - MQL5 cannot hold a browser session, so
  ``/api/ea/*`` still authenticates with ``X-EA-Token``.
* Fail closed: an empty password denies, comparison is constant-time, and
  sessions are random, expiring and memory-only.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
import time
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

COOKIE_NAME = "sx_session"
SESSION_TTL_SEC = 12 * 3600          # a working day, then the password again
_MAX_SESSIONS = 64
_LOCK = threading.Lock()
_SESSIONS: Dict[str, float] = {}     # token -> expiry epoch

# credential stuffing guard: per client-ip failures -> (count, blocked_until)
_FAILURES: Dict[str, Tuple[int, float, float]] = {}
_MAX_FAILURE_CLIENTS = 2048
_FAIL_LIMIT = 8
_FAIL_WINDOW_SEC = 300.0
_FAIL_BLOCK_SEC = 300.0

# Paths that change something. POST covers everything except the two routes
# below, which the frontend calls with GET and which still mutate.
_MUTATING_GETS = frozenset({
    "/api/bot3/recalculate",
    "/api/bot5/refresh",
})
# Never gated: the gate itself, and the health probe the docker HEALTHCHECK and
# the deploy docs use.
_EXEMPT = frozenset({
    "/api/login", "/api/logout", "/api/auth", "/api/health", "/favicon.ico",
})
# The EA bridge authenticates with its own header token inside the handlers.
_EA_PREFIX = "/api/ea/"


def _loopback(host: str) -> bool:
    h = str(host or "").strip().lower()
    if h in ("", "127.0.0.1", "localhost", "::1", "[::1]"):
        return True
    return h.startswith("127.")


def auth_required(cfg_get) -> bool:
    """True when mutating API calls must carry a dashboard session.

    ``cfg_get`` is ``backend.config.CONFIG.get`` - taken as a callable so the
    live (editable) config is always consulted.
    """
    flag = cfg_get("require_login", None)
    if flag is not None and str(flag) not in ("", "None"):
        return str(flag).strip().lower() not in ("0", "false", "no", "off")
    return os.environ.get("SOFTRADEX_PASSENGER") == "1" or not _loopback(effective_host(cfg_get))


def effective_host(cfg_get) -> str:
    """The same bind address used by the application launcher."""
    return (str(os.environ.get("HOST", "")).strip()
            or ("0.0.0.0" if str(os.environ.get("PORT", "")).strip() else "")
            or str(cfg_get("host", "127.0.0.1")))


def effective_port(cfg_get) -> int:
    """Choose a usable configured port instead of an accidental random bind."""
    for value in (os.environ.get("PORT", ""), cfg_get("port", 8777), 8777):
        try:
            port = int(str(value).strip())
        except (ValueError, TypeError):
            continue
        if 1 <= port <= 65535:
            return port
    return 8777


def expected_password(cfg_get) -> str:
    return str(os.environ.get("SOFTRADEX_DASHBOARD_PASSWORD")
               or cfg_get("dashboard_password", "") or "")


def _hash(password: str) -> bytes:
    return hashlib.sha256(password.encode("utf-8")).digest()


def password_ok(candidate: str, cfg_get) -> bool:
    """Constant-time check; an unset dashboard password always denies."""
    supplied = str(candidate or "")
    expected = expected_password(cfg_get)
    if not supplied or not expected:
        return False
    return hmac.compare_digest(_hash(supplied), _hash(expected))


def too_many_failures(ip: str) -> bool:
    with _LOCK:
        rec = _FAILURES.get(ip)
        return bool(rec and rec[1] > time.time())


def note_failure(ip: str) -> None:
    with _LOCK:
        now = time.time()
        for key in [key for key, (_, until, first) in _FAILURES.items()
                    if max(until, first + _FAIL_WINDOW_SEC) <= now]:
            _FAILURES.pop(key, None)
        count, until, first = _FAILURES.get(ip, (0, 0.0, now))
        if until > now:
            return
        if now - first >= _FAIL_WINDOW_SEC:
            count, first = 0, now
        if ip not in _FAILURES and len(_FAILURES) >= _MAX_FAILURE_CLIENTS:
            _FAILURES.pop(next(iter(_FAILURES)))
        count += 1
        if count >= _FAIL_LIMIT:
            _FAILURES[ip] = (0, now + _FAIL_BLOCK_SEC, first)
        else:
            _FAILURES[ip] = (count, 0.0, first)


def note_success(ip: str) -> None:
    with _LOCK:
        _FAILURES.pop(ip, None)


def login(cfg_get) -> Optional[str]:
    token = secrets.token_urlsafe(32)
    now = time.time()
    with _LOCK:
        for dead in [t for t, exp in _SESSIONS.items() if exp <= now]:
            _SESSIONS.pop(dead, None)
        while len(_SESSIONS) >= _MAX_SESSIONS:
            _SESSIONS.pop(next(iter(_SESSIONS)), None)
        _SESSIONS[token] = now + SESSION_TTL_SEC
    return token


def logout(token: str) -> None:
    if not token:
        return
    with _LOCK:
        _SESSIONS.pop(token, None)


def session_valid(token: str) -> bool:
    if not token:
        return False
    now = time.time()
    with _LOCK:
        exp = _SESSIONS.get(token)
        if exp is None:
            return False
        if exp <= now:
            _SESSIONS.pop(token, None)
            return False
        # sliding expiry, but never past TTL from the original login
        return True


def is_mutating(method: str, path: str) -> bool:
    m = str(method or "").upper()
    if path in _EXEMPT or path.startswith(_EA_PREFIX):
        return False
    if m in ("POST", "PUT", "PATCH", "DELETE"):
        return True
    return m == "GET" and path in _MUTATING_GETS


def client_ip(request_headers, client_host: str = "") -> str:
    """Use the peer resolved by the server's configured trusted proxies."""
    return str(client_host or "")[:64] or "unknown"


def requires_session(method: str, path: str) -> bool:
    return is_mutating(method, path) or path in {
        "/api/state", "/api/history", "/api/export.csv", "/api/events", "/api/terminals"
    } or path.startswith("/api/bot")


def origin_allowed(headers, scheme: str, host: str) -> bool:
    """Allow same-origin browser traffic and clients without an Origin header."""
    origin = headers.get("origin")
    if origin is None:
        return True
    scheme = {"ws": "http", "wss": "https"}.get(scheme, scheme)
    try:
        supplied = urlsplit(origin)
        expected = urlsplit(scheme + "://" + host)
        def authority(url):
            return (url.scheme.lower(), url.hostname,
                    url.port or (443 if url.scheme == "https" else 80))
        return (not supplied.username and not supplied.password
                and supplied.path in ("", "/") and not supplied.query and not supplied.fragment
                and authority(supplied) == authority(expected))
    except (ValueError, TypeError):
        return False


def token_from_cookie(cookie_header: str) -> str:
    for part in str(cookie_header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE_NAME:
            return value.strip()[:128]
    return ""


def session_count() -> int:
    with _LOCK:
        return len(_SESSIONS)
