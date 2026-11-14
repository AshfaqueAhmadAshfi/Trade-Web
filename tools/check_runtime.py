"""Read-only HTTP smoke checks of every dashboard API group."""
import argparse
import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

PATHS = [
    '/', '/access', '/dashboard', '/dashboard/', '/favicon.ico', '/logo.jpg', '/api/health', '/api/config', '/api/auth',
    '/api/state', '/api/market-watch', '/api/history', '/api/export.csv', '/api/events',
    '/api/bot', '/api/bot2', '/api/bot3', '/api/bot4', '/api/bot5', '/api/bot6', '/api/bot7',
    '/api/chart/symbols', '/api/terminals', '/api/docs', '/openapi.json',
    '/api/orderflow/venues', '/api/orderflow/trades?venue=binance&market=BTC&limit=10',
    '/api/news/market?symbol=XAUUSDm', '/api/news/market?symbol=BTCUSDTm',
    '/api/tv/setups?symbol=XAUUSDm', '/api/tv/setups?symbol=BTCUSDTm',
    '/api/whales/positions?symbol=XAUUSDm', '/api/whales/positions?symbol=BTCUSDTm',
    '/api/chart/candles?symbol=BTCUSDTm&tf=5m&count=50',
    '/api/chart/ticker?symbol=BTCUSDTm', '/api/chart/tape?symbol=BTCUSDTm&limit=10',
    '/api/chart/tvquote?symbol=AAPLm', '/api/chart/tvquote?symbol=USDTRYm',
    '/api/chart/tvquote?symbol=ADAUSDm',
    '/api/chart/tvcandles?symbol=XAUUSDm&tf=5m&count=50&tv_symbol=OANDA%3AXAUUSD',
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='http://127.0.0.1:8777')
    args = parser.parse_args()
    def probe(path):
        start = time.monotonic()
        try:
            response = urllib.request.urlopen(args.base_url.rstrip('/') + path, timeout=35)
        except urllib.error.HTTPError as exc:
            response = exc
        except Exception as exc:
            return {'path': path, 'status': 0, 'error': str(exc)[:150]}
        with response:
            body = response.read()
            row = {'path': path, 'status': response.status, 'seconds': round(time.monotonic()-start, 2),
                   'type': response.headers.get('Content-Type'), 'bytes': len(body)}
            if 'json' in row['type']:
                data = json.loads(body)
                row['keys'] = list(data)[:20]
                if isinstance(data.get('sources'), list):
                    row['providers'] = [{'name': p.get('name'), 'state': p.get('state'),
                                         'count': p.get('count')} for p in data['sources']]
                if isinstance(data.get('events'), list):
                    row['events'] = len(data['events'])
                if data.get('source'):
                    row['source'] = data['source']
            return row
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(probe, PATHS))
    report = Path(__file__).resolve().parent.parent / 'reports' / 'codex-audit-runtime-results.json'
    report.write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps({'requests': len(results), 'http_200': sum(r['status'] == 200 for r in results),
                      'other_results': [r for r in results if r['status'] != 200]}, indent=2))
    return any(row['status'] not in (200, 401, 503) for row in results)


if __name__ == '__main__':
    raise SystemExit(main())
