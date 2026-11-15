"""Regressions for deployment access, quote freshness and instrument identity."""
import asyncio
import importlib
import json
import os
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from backend import config, public_feed as pf, tv_feed, webauth
from backend.chart_feed import ChartFeed
from backend.store import Store
from backend import market_watch


class AccessTests(unittest.TestCase):
    def test_launch_port_uses_valid_environment_then_config_and_never_zero(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(webauth.effective_port({"port": 8799}.get), 8799)
            for invalid in ("0", "-1", "65536", "invalid", "3.14", ""):
                os.environ["PORT"] = invalid
                self.assertEqual(webauth.effective_port({"port": 8799}.get), 8799)
                self.assertEqual(webauth.effective_port({"port": invalid}.get), 8777)
            os.environ["PORT"] = "8080"
            self.assertEqual(webauth.effective_port({"port": 8799}.get), 8080)
            os.environ["PORT"] = "65535"
            self.assertEqual(webauth.effective_port({}.get), 65535)

    def test_public_bind_and_passenger_require_auth_but_loopback_does_not(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(webauth.auth_required({}.get))
            os.environ['PORT'] = '8080'
            self.assertTrue(webauth.auth_required({}.get))
            os.environ['HOST'] = '127.0.0.1'
            self.assertFalse(webauth.auth_required({}.get))
            os.environ['SOFTRADEX_PASSENGER'] = '1'
            self.assertTrue(webauth.auth_required({}.get))
            self.assertFalse(webauth.auth_required({'require_login': 'false'}.get))

    def test_empty_password_never_accepts_bridge_token(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(webauth.password_ok('bridge-secret', {'ea_secret': 'bridge-secret'}.get))

    def test_foreign_and_malformed_origins_are_rejected(self):
        self.assertTrue(webauth.origin_allowed({}, 'http', 'localhost:8777'))
        self.assertTrue(webauth.origin_allowed({'origin': 'http://localhost:8777'}, 'ws', 'localhost:8777'))
        for origin in ('null', 'https://evil.example', 'http://localhost:8778',
                       'http://user@localhost:8777', 'http://localhost:8777/path'):
            self.assertFalse(webauth.origin_allowed({'origin': origin}, 'http', 'localhost:8777'), origin)

    def test_spoofed_forwarded_headers_do_not_bypass_rate_limit(self):
        with patch.object(webauth, '_FAILURES', {}), patch('backend.webauth.time.time', return_value=1000):
            for attempt in range(8):
                ip = webauth.client_ip({'x-forwarded-for': str(attempt)}, '203.0.113.7')
                webauth.note_failure(ip)
            self.assertTrue(webauth.too_many_failures('203.0.113.7'))
        with patch.object(webauth, '_FAILURES', {}):
            with patch('backend.webauth.time.time', return_value=1000):
                webauth.note_failure('peer')
            with patch('backend.webauth.time.time', return_value=1400):
                webauth.note_failure('peer')
                self.assertEqual(webauth._FAILURES['peer'][0], 1)


class QuoteTests(unittest.TestCase):
    def setUp(self):
        pf.reset_cache()
        self.addCleanup(pf.reset_cache)

    def test_outage_preserves_timestamp_and_rejects_hour_old_quotes(self):
        now = time.time()
        row = {'price': 100, 'open24': 99, 'high': 101, 'low': 98, 'vol': 5,
               'change': 1, 'updated_at': int((now - 20) * 1000)}
        pf._TICKERS['BTCUSDTm'] = (now - 5, row)
        with patch.object(pf, '_http_json', side_effect=OSError('offline')):
            raw = pf.ticker('BTCUSDTm')
            self.assertTrue(raw['stale'])
            self.assertEqual(raw['updated_at'], row['updated_at'])
            feed = ChartFeed(public_fallback=True)
            payload = feed.ticker('BTCUSDTm')
            self.assertEqual(payload['updated_at'], row['updated_at'])
            self.assertTrue(payload['stale'])
            pf._TICKERS['BTCUSDTm'] = (now - 3600, row)
            with self.assertRaises(pf.PublicFeedError):
                pf.ticker('BTCUSDTm')
            pf._TICKS['BTCUSDTm'] = (now - 3600, {'bid': 100})
            with self.assertRaises(pf.PublicFeedError):
                pf.tick('BTCUSDTm')

    def test_tv_cache_labels_each_request_with_its_own_alias(self):
        with patch.object(tv_feed, '_QUOTES', {}), patch.object(tv_feed, '_http_json', return_value={'close': 100}):
            first = tv_feed.quote('XAUUSDm')
            second = tv_feed.quote('XAUUSD')
        self.assertEqual(first['symbol'], 'XAUUSDm')
        self.assertEqual(second['symbol'], 'XAUUSD')

    def test_all_explicit_frontend_instruments_match_backend(self):
        source = (config.WEB_DIR / 'tv-chart.js').read_text(encoding='utf-8')
        block = source.split('var EXPLICIT = {', 1)[1].split('};', 1)[0]
        for symbol, instrument in re.findall(r"(\w+):\s*'([^']+)'", block):
            self.assertEqual(tv_feed.tv_symbol(symbol), instrument, symbol)
        self.assertEqual(tv_feed.tv_symbol('ADAUSDm'), 'BINANCE:ADAUSDT')
        self.assertEqual(tv_feed.tv_symbol('USDTRYm'), 'FX_IDC:USDTRY')

    def test_config_load_does_not_share_nested_defaults(self):
        with patch.object(config, 'CONFIG_FILE', Path('does-not-exist.json')), patch.object(config, 'save_config'):
            loaded = config.load_config()
        self.assertIsNot(loaded['bot'], config.DEFAULTS['bot'])

    def test_market_watch_never_invents_a_quote_or_spread(self):
        with patch.object(market_watch, '_PUBLIC_QUOTES', {}), patch.object(market_watch, 'mt5', None):
            row = market_watch._fallback_symbol_watch('USDCHFm')
            self.assertEqual(row['bid'], 0)
            self.assertEqual(row['price_source'], 'unavailable')
            self.assertEqual(row['digits'], 5)
            market_watch._PUBLIC_QUOTES['USDCHFm'] = {'until': time.time()+30, 'price': 0.90012}
            row = market_watch._fallback_symbol_watch('USDCHFm')
            self.assertEqual(row['bid'], 0.90012)
            self.assertEqual(row['ask'], row['bid'])
            self.assertEqual(row['spread'], 0)


class EndpointAccessTests(unittest.TestCase):
    def test_private_state_login_origin_and_websocket_gates(self):
        already_loaded = 'backend.app' in sys.modules
        with tempfile.TemporaryDirectory() as bootstrap:
            with patch.object(config, 'DB_FILE', Path(bootstrap) / 'bootstrap.db'), \
                    patch('backend.engine.Engine.start'):
                appmod = importlib.import_module('backend.app')
            if not already_loaded:
                appmod.store.close()
        async def request(method, path, body=None, headers=()):
            messages = []
            delivered = False
            async def receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {'type': 'http.request', 'body': json.dumps(body or {}).encode(), 'more_body': False}
                await asyncio.Event().wait()
            async def send(message):
                messages.append(message)
            await appmod.app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                'method': method, 'scheme': 'http', 'path': path, 'raw_path': path.encode(),
                'query_string': b'', 'root_path': '', 'headers': [(b'host', b'localhost:8777'),
                    (b'content-type', b'application/json'), *headers],
                'server': ('localhost', 8777), 'client': ('203.0.113.7', 1000)}, receive, send)
            start = next(m for m in messages if m['type'] == 'http.response.start')
            return start['status'], dict(start['headers'])
        with tempfile.TemporaryDirectory() as folder:
            isolated_store = Store(Path(folder) / 'test.db')
            try:
                with patch.object(appmod, 'store', isolated_store), \
                        patch.dict(config.CONFIG, {'require_login': True, 'dashboard_password': 'test-password'}), \
                        patch.dict(os.environ, {'SOFTRADEX_DASHBOARD_PASSWORD': ''}), \
                        patch.object(appmod.engine, 'snapshot', return_value={'account': {'login': 'fake'}}), \
                        patch.object(webauth, '_SESSIONS', {}), patch.object(webauth, '_FAILURES', {}):
                    self.assertEqual(asyncio.run(request('GET', '/api/state'))[0], 401)
                    self.assertEqual(asyncio.run(request('POST', '/api/login', {'password': 'test-password'},
                        [(b'origin', b'https://evil.example')]))[0], 403)
                    status, headers = asyncio.run(request('POST', '/api/login', {'password': 'test-password'}))
                    self.assertEqual(status, 200)
                    cookie = headers[b'set-cookie'].split(b';', 1)[0]
                    status, headers = asyncio.run(request('GET', '/api/state', headers=[(b'cookie', cookie)]))
                    self.assertEqual(status, 200)
                    self.assertEqual(headers[b'cache-control'], b'private, no-store')
                    self.assertEqual(asyncio.run(appmod.api_history(all_accounts=True))['trades'], [])
                    for ws_headers in ({'host': 'localhost:8777'},
                                       {'host': 'localhost:8777', 'origin': 'https://evil.example', 'cookie': cookie.decode()}):
                        ws = SimpleNamespace(headers=ws_headers, url=SimpleNamespace(scheme='ws'), close=AsyncMock())
                        self.assertFalse(asyncio.run(appmod.authorize_websocket(ws)))
                        ws.close.assert_awaited_once_with(code=1008)
            finally:
                isolated_store.close()
                if not already_loaded:
                    sys.modules.pop('backend.app', None)
