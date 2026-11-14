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

COOKIE_NAME = "sx_session"
SESSION_TTL_SEC = 12 * 3600          # a working day, then the password again
_MAX_SESSIONS = 64
_LOCK = threading.Lock()
_SESSIONS: Dict[str, float] = {}     # token -> expiry epoch

# credential stuffing guard: per client-ip failures -> (count, blocked_until)
_FAILURES: Dict[str, Tuple[int, float]] = {}
_FAIL_LIMIT = 8
_FAIL_WINDOW_SEC = 300.0
_FAIL_BLOCK_SEC = 300.0

DEFAULT_PASSWORD = "0186"            # the value the dashboard has always used

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
        return bool(flag)
    env_host = str(os.environ.get("HOST", "")).strip()
    return not _loopback(env_host or cfg_get("host", "127.0.0.1"))


def expected_password(cfg_get) -> str:
    pw = str(cfg_get("dashboard_password", "") or "").strip()
    return pw or DEFAULT_PASSWORD


def _hash(password: str) -> bytes:
    return hashlib.sha256(password.encode("utf-8")).digest()


def password_ok(candidate: str, cfg_get) -> bool:
    """Constant-time check against the dashboard password or the EA bridge
    token (so an operator who knows the bridge token can also drive the UI)."""
    supplied = str(candidate or "")
    if not supplied:
        return False
    ok = hmac.compare_digest(_hash(supplied), _hash(expected_password(cfg_get)))
    secret = str(cfg_get("ea_secret", "") or "")
    if secret and not ok:
        ok = hmac.compare_digest(_hash(supplied), _hash(secret))
    return ok


def too_many_failures(ip: str) -> bool:
    with _LOCK:
        rec = _FAILURES.get(ip)
        return bool(rec and rec[1] > time.time())


def note_failure(ip: str) -> None:
    with _LOCK:
        count, until = _FAILURES.get(ip, (0, 0.0))
        if until > time.time():
            return
        count += 1
        if count > _FAIL_LIMIT:
            _FAILURES[ip] = (0, time.time() + _FAIL_BLOCK_SEC)
        else:
            _FAILURES[ip] = (count, 0.0)


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
    """Best-effort origin address. ``forwarded_allow_ips="*"`` lets a client lie
    about X-Forwarded-For, so this is only used to rate-limit password tries and
    never to authorise anything."""
    fwd = str(request_headers.get("x-forwarded-for", "") or "").split(",")[0].strip()
    return (fwd or str(client_host or ""))[:64] or "unknown"


def token_from_cookie(cookie_header: str) -> str:
    for part in str(cookie_header or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE_NAME:
            return value.strip()[:128]
    return ""


def session_count() -> int:
    with _LOCK:
        return len(_SESSIONS)
