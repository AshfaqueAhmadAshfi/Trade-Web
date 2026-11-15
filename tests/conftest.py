"""Keep the unit suite offline; live provider checks are separate diagnostics."""
import socket
import sys
from unittest.mock import patch

import pytest
from backend.tv_feed import TradingViewError


def _ensure_windows_proactor_self_pipe() -> None:
    if sys.platform != "win32":
        return
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    loopback_ok = False
    try:
        probe.bind(("127.0.0.1", 0))
        probe.listen(1)
        probe.settimeout(0.05)
        client.setblocking(False)
        try:
            client.connect(probe.getsockname()[:2])
        except (BlockingIOError, InterruptedError, OSError):
            pass
        try:
            conn, _ = probe.accept()
            conn.close()
            loopback_ok = True
        except OSError:
            loopback_ok = False
    except OSError:
        loopback_ok = False
    finally:
        client.close()
        probe.close()
    if loopback_ok:
        return

    import asyncio.proactor_events as pe
    import asyncio.windows_events as we
    import threading

    orig_proactor_init = we.IocpProactor.__init__
    orig_proactor_poll = we.IocpProactor._poll

    def _proactor_init(self, concurrency=0xFFFFFFFF):
        orig_proactor_init(self, concurrency)
        self._wakeup_event = threading.Event()

    def _proactor_poll(self, timeout=None):
        if not self._cache:
            if timeout is None or timeout > 0:
                self._wakeup_event.wait(timeout)
            self._wakeup_event.clear()
            for ov in self._unregistered:
                self._cache.pop(ov.address, None)
            self._unregistered.clear()
            return
        return orig_proactor_poll(self, timeout)

    def _make_self_pipe(self):
        self._ssock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._csock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._internal_fds += 1

    def _loop_self_reading(self, f=None):
        return None

    def _write_to_self(self):
        proactor = getattr(self, "_proactor", None)
        ev = getattr(proactor, "_wakeup_event", None)
        if ev is not None:
            ev.set()

    we.IocpProactor.__init__ = _proactor_init
    we.IocpProactor._poll = _proactor_poll
    pe.BaseProactorEventLoop._make_self_pipe = _make_self_pipe
    pe.BaseProactorEventLoop._loop_self_reading = _loop_self_reading
    pe.BaseProactorEventLoop._write_to_self = _write_to_self


_ensure_windows_proactor_self_pipe()


@pytest.fixture(autouse=True)
def offline_network():
    with patch("urllib.request.urlopen", side_effect=OSError("offline unit test")), \
            patch("requests.sessions.Session.request", side_effect=OSError("offline unit test")), \
            patch("backend.tv_feed.connect", side_effect=TradingViewError("offline unit test")):
        yield
