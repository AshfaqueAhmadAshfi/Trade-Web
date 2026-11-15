"""Public startup and broker isolation without installed MT5 software."""
import asyncio
import importlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from backend import config as cfg
from backend import chart_feed, market_watch, mt5_client, news_bot
from backend.engine import Engine
from backend.store import Store


class PublicRuntimeTests(unittest.TestCase):
    def test_old_desktop_modes_cannot_enable_a_terminal(self):
        for mode in ("", "mt5", "local", "desktop", "public"):
            with self.subTest(mode=mode), patch.dict(os.environ, {"SOFTRADEX_MODE": mode}):
                self.assertTrue(cfg.detect_hosted())
        self.assertTrue(cfg.PUBLIC_ONLY)

    def test_native_package_is_never_imported_even_when_installed(self):
        script = '''
import builtins
original = builtins.__import__
def guarded(name, *args, **kwargs):
    if name == "MetaTrader5":
        raise AssertionError("native terminal import attempted")
    return original(name, *args, **kwargs)
builtins.__import__ = guarded
from backend import engine, chart_feed, market_watch, news_bot
assert all(module.mt5 is None for module in (engine, chart_feed, market_watch, news_bot))
'''
        result = subprocess.run([sys.executable, "-c", script], cwd=cfg.BASE_DIR,
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_no_terminal_scan_launch_or_connection(self):
        with patch.object(mt5_client, "_scan_for_terminals", side_effect=AssertionError("scan")), \
                patch.object(mt5_client.subprocess, "Popen", side_effect=AssertionError("launch")):
            self.assertEqual(mt5_client.find_terminals(force=True), [])
            self.assertFalse(mt5_client._launch_terminal("terminal64.exe"))
            self.assertFalse(mt5_client.MT5Client().connect(123, "", "old-server")["ok"])

    def test_snapshot_opens_public_dashboard_and_execution_never_queues(self):
        with tempfile.TemporaryDirectory(prefix="softradex-api-test-") as folder:
            store = Store(Path(folder) / "test.db")
            try:
                engine = Engine(store, watch_publisher=Mock())
                with patch("backend.engine.get_all_market_watches", return_value={"watches": []}), \
                        patch("backend.engine.find_terminals", side_effect=AssertionError("scan")):
                    engine._refresh_static()
                    engine._compute()
                    engine._publish(force=True)
                snapshot = engine.snapshot()
                self.assertTrue(snapshot["connected"])
                self.assertFalse(snapshot["locked"])
                self.assertEqual(snapshot["source"], "public")
                self.assertEqual(snapshot["mode"], "public")
                self.assertIsNone(snapshot["account"])
                self.assertEqual(snapshot["terminal"], "")
                for command in ("connect", "disconnect", "ea_event", "scan_terminals", "bot_close", "bot3_recalculate"):
                    self.assertFalse(engine.submit(command, timeout=0.01)["ok"])
                self.assertFalse(engine.submit("bot5_config", {"running": True})["ok"])
                self.assertTrue(engine._commands.empty())
                engine._start_watch_stream()
                self.assertIsNone(engine._watch_thread)
            finally:
                store.close()


class PublicAnalysisTests(unittest.TestCase):
    def test_public_candles_become_closed_bar_ai_input(self):
        bot = news_bot.NewsBot()
        now = int(time.time())
        rows = [[(now - (100 - i) * 300) * 1000, 100 + i, 102 + i, 99 + i, 101 + i, 10] for i in range(100)]
        with patch.object(news_bot.public_feed, "candles", return_value=rows), \
                patch.object(news_bot.public_feed, "tick", return_value={"bid": 201}), \
                patch.object(bot, "_ai_news", return_value={}):
            bot._ai_cache_get("XAUUSDm", now)
            bot._public_ai_thread.join(timeout=5)
            self.assertFalse(bot._public_ai_thread.is_alive())
            board = bot.ai_board(now)
        self.assertEqual(board["source"], "public")
        self.assertTrue(next(r for r in board["rows"] if r["key"] == "M5")["ready"])
        self.assertEqual(bot._read_ai_bars("", "M5"), [])

    def test_slow_response_is_cached_under_its_own_market(self):
        bot = news_bot.NewsBot()
        release = threading.Event()
        def slow_bars(symbol, key):
            release.wait(timeout=3)
            return [(1000, 10, 12, 9, 11)]
        with patch.object(bot, "_read_ai_bars", side_effect=slow_bars):
            self.assertEqual(bot._ai_cache_get("XAUUSDm", time.time())["frames"], {})
            self.assertEqual(bot._ai_cache_get("BTCUSDTm", time.time())["frames"], {})
            release.set()
            bot._public_ai_thread.join(timeout=5)
        self.assertIn("XAUUSDm", bot._public_ai_cache)
        self.assertNotIn("BTCUSDTm", bot._public_ai_cache)


class PublicEndpointTests(unittest.TestCase):
    def test_broker_endpoints_are_disabled_and_config_has_no_saved_account(self):
        already_imported = "backend.app" in sys.modules
        with tempfile.TemporaryDirectory(prefix="softradex-api-routes-") as folder:
            with patch.object(cfg, "DB_FILE", Path(folder) / "test.db"), patch.object(Engine, "start"):
                app_module = importlib.import_module("backend.app")
            try:
                async def request(method, path):
                    messages = []
                    delivered = False
                    async def receive():
                        nonlocal delivered
                        if not delivered:
                            delivered = True
                            return {"type": "http.request", "body": b"", "more_body": False}
                        await asyncio.Event().wait()
                    async def send(message):
                        messages.append(message)
                    await app_module.app({"type": "http", "asgi": {"version": "3.0"},
                        "http_version": "1.1", "method": method, "scheme": "http",
                        "path": path, "raw_path": path.encode(), "query_string": b"",
                        "root_path": "", "headers": [(b"host", b"127.0.0.1")],
                        "server": ("127.0.0.1", 80), "client": ("127.0.0.1", 1000)}, receive, send)
                    status = next(m["status"] for m in messages if m["type"] == "http.response.start")
                    body = b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body")
                    return status, json.loads(body)
                with patch.object(app_module.engine, "submit", side_effect=AssertionError("broker command")):
                    for method, path, status in (("POST", "/api/connect", 410), ("POST", "/api/disconnect", 410),
                            ("POST", "/api/ea-token", 410), ("GET", "/api/ea/ping", 410),
                            ("POST", "/api/ea/event", 410), ("GET", "/api/ea/event", 410),
                            ("POST", "/api/bot/start", 403), ("POST", "/api/bot7/close", 403)):
                        self.assertEqual(asyncio.run(request(method, path))[0], status, path)
                    config = asyncio.run(request("GET", "/api/config"))[1]
                self.assertTrue(config["public_only"])
                self.assertFalse(config["bots_enabled"])
                self.assertFalse(config["live_stream"])
                self.assertEqual(config["saved_login"], "")
                self.assertEqual(config["terminals"], [])
            finally:
                if not already_imported:
                    app_module.store.close()
                    sys.modules.pop("backend.app", None)


if __name__ == "__main__":
    unittest.main()
