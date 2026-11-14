"""Check Passenger routes and a complete dashboard login/logout using an environment password."""
import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_runtime import PATHS


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url',required=True)
    parser.add_argument('--password-env',default='SOFTRADEX_CHECK_PASSWORD')
    parser.add_argument('--output',type=Path,default=Path('reports/cpanel-live-results.json'))
    args=parser.parse_args()
    base=args.base_url.rstrip('/')
    parsed=urlsplit(base)
    if parsed.scheme not in ('http','https') or not parsed.hostname or parsed.path not in ('','/'):
        parser.error('Use a domain/subdomain root URL')
    password=os.environ.get(args.password_env)
    if not password:
        parser.error('Set the password in the named environment variable; never pass it on the command line')
    session=requests.Session()
    headers={'Origin':base}
    checks={}
    checks['signed_out_state_401']=session.get(base+'/api/state',timeout=15).status_code==401
    checks['foreign_origin_403']=session.post(base+'/api/login',json={'password':password},
        headers={'Origin':'https://foreign.invalid'},timeout=15).status_code==403
    login=session.post(base+'/api/login',json={'password':password},headers=headers,timeout=15)
    checks['login_accepted']=login.ok and login.json().get('authed') is True
    if not checks['login_accepted']:
        raise SystemExit('Dashboard login was rejected; verify the hosting password environment variable')
    checks['http_only_cookie']='httponly' in login.headers.get('set-cookie','').lower()
    if parsed.scheme=='https':
        checks['secure_cookie']='secure' in login.headers.get('set-cookie','').lower()
    cookies=session.cookies.get_dict()
    def probe(path):
        start=time.monotonic()
        try:
            response=requests.get(base+path,cookies=cookies,timeout=35)
            row={'path':path,'status':response.status_code,'seconds':round(time.monotonic()-start,2),
                 'type':response.headers.get('content-type'),'decoded_bytes':len(response.content),
                 'encoding':response.headers.get('content-encoding')}
            if 'json' in row['type']:
                data=response.json()
                row['keys']=list(data)[:20]
                if isinstance(data.get('events'),list):row['events']=len(data['events'])
                if isinstance(data.get('sources'),list):
                    row['providers']=[{'name':p.get('name'),'state':p.get('state'),'count':p.get('count')}for p in data['sources']]
            return row
        except Exception as exc:
            return {'path':path,'status':0,'error':type(exc).__name__}
    paths=[p.replace('/api/whales/positions?symbol=','/api/whales/positions?market=')for p in PATHS]
    with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(probe,paths))
    full=session.get(base+'/api/state',timeout=15)
    data=full.json()
    signature=(data.get('bot5')or{}).get('news_sig')
    if signature:
        thin=session.get(base+'/api/state',params={'have':signature},timeout=15)
        checks['unchanged_calendar_omitted']='news' not in (thin.json().get('bot5')or{})
        checks['private_no_store']=thin.headers.get('cache-control')=='private, no-store'
    checks['logout_accepted']=session.post(base+'/api/logout',headers=headers,timeout=15).ok
    checks['revoked_state_401']=session.get(base+'/api/state',cookies=cookies,timeout=15).status_code==401
    report={'base_url':base,'checks':checks,'routes':results}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2),encoding='utf-8')
    failures=[r for r in results if r['status']not in(200,503)]
    print(json.dumps({'checks':checks,'statuses':dict(Counter(r['status']for r in results)),
                      'route_failures':failures,'report':str(args.output)},indent=2))
    return bool(failures or not all(checks.values()))


if __name__=='__main__':
    raise SystemExit(main())
