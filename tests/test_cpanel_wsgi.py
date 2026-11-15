"""Exercise the actual Passenger/ASGI bridge with isolated state and no providers."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent


class PassengerWSGITests(unittest.TestCase):
    def run_script(self, code):
        with tempfile.TemporaryDirectory() as folder:
            environment = dict(os.environ, SOFTRADEX_PASSENGER="1",
                               SOFTRADEX_DASHBOARD_PASSWORD="isolated-wsgi-test-password",
                               SOFTRADEX_AUTH_DB=str(Path(folder)/"auth.sqlite3"), TEST_RUNTIME=folder)
            prefix = """
import os,io,json,gzip,sys
from pathlib import Path
from unittest.mock import patch
import tests.conftest
from backend import config
config.DATA_DIR=Path(os.environ['TEST_RUNTIME'])
config.DB_FILE=config.DATA_DIR/'test.db'
config.CONFIG['require_login']=True
from backend.engine import Engine
patch.object(Engine,'start').start()
"""
            result = subprocess.run([sys.executable, "-c", prefix + code], cwd=ROOT,
                                    env=environment, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_https_login_state_thinning_assets_origins_and_logout(self):
        self.run_script("""
from passenger_wsgi import application
from backend import app as appmod
appmod.engine.snapshot=lambda:{'connected':True,'server_time':'12:00:00',
    'bot5':{'news':[{'title':'Test release','ts':2000000000}]}}
def request(method,path,payload=None,cookie='',origin='https://dashboard.example',query='',encoding=''):
    body=json.dumps(payload or {}).encode()
    result={}
    env={'REQUEST_METHOD':method,'SCRIPT_NAME':'','PATH_INFO':path,'QUERY_STRING':query,
        'SERVER_NAME':'dashboard.example','SERVER_PORT':'443','SERVER_PROTOCOL':'HTTP/1.1',
        'HTTP_HOST':'dashboard.example','HTTP_ORIGIN':origin,'HTTP_COOKIE':cookie,
        'HTTPS':'on','wsgi.url_scheme':'http','wsgi.version':(1,0),'wsgi.input':io.BytesIO(body),
        'wsgi.errors':io.StringIO(),'wsgi.multithread':True,'wsgi.multiprocess':True,
        'wsgi.run_once':False,'REMOTE_ADDR':'203.0.113.1','CONTENT_LENGTH':str(len(body)),
        'CONTENT_TYPE':'application/json','HTTP_ACCEPT_ENCODING':encoding}
    def start(status,headers,exc_info=None):result.update(status=int(status.split()[0]),headers=dict((k.lower(),v)for k,v in headers))
    response=application(env,start)
    try:result['body']=b''.join(response)
    finally:
        if hasattr(response,'close'):response.close()
    assert not env['wsgi.errors'].getvalue(),env['wsgi.errors'].getvalue()
    return result
assert json.loads(request('GET','/api/auth')['body'])['auth_required']
assert request('GET','/api/state')['status']==401
assert request('POST','/api/login',{'password':'isolated-wsgi-test-password'},origin='https://foreign.example')['status']==403
login=request('POST','/api/login',{'password':'isolated-wsgi-test-password'})
assert login['status']==200 and json.loads(login['body'])['authed']
assert 'Secure' in login['headers']['set-cookie'] and 'HttpOnly' in login['headers']['set-cookie']
cookie=login['headers']['set-cookie'].split(';',1)[0]
state=request('GET','/api/state',cookie=cookie)
assert state['status']==200 and state['headers']['cache-control']=='private, no-store'
data=json.loads(state['body'])
thin=json.loads(request('GET','/api/state',cookie=cookie,query='have='+data['bot5']['news_sig'])['body'])
assert 'news' not in thin['bot5']
asset=request('GET','/static/app.js',encoding='gzip')
assert asset['status']==200 and asset['headers']['content-encoding']=='gzip'
assert b'function startHttpPoll' in gzip.decompress(asset['body'])
assert request('GET','/dashboard')['status']==200
assert request('POST','/api/logout',cookie=cookie)['status']==200
assert request('GET','/api/state',cookie=cookie)['status']==401
appmod.store.close()
""")

    def test_startup_traceback_stays_in_private_log(self):
        self.run_script("""
from types import SimpleNamespace
def fail(*args,**kwargs):raise RuntimeError('private-startup-detail')
sys.modules['a2wsgi']=SimpleNamespace(ASGIMiddleware=fail)
from passenger_wsgi import application
result={}
def start(status,headers,exc_info=None):result['status']=status
body=b''.join(application({},start))
assert result['status'].startswith('500')
assert b'private-startup-detail' not in body and b'Traceback' not in body
assert b'Passenger error log' in body
from backend import app as appmod
appmod.store.close()
""")
