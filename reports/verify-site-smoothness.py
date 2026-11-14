"""Focused desktop/mobile checks in an isolated, visible-to-the-renderer Chrome profile."""
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from websockets.sync.client import connect

ROOT = Path.cwd().resolve()
ORIGIN = 'http://127.0.0.1:8784'
PROFILE = Path(tempfile.mkdtemp(prefix='softradex-performance-')).resolve()
CHROME = Path(r'C:\Program Files\Google\Chrome\Application\chrome.exe')
process = subprocess.Popen([str(CHROME), '--headless=new', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--remote-debugging-port=0', '--user-data-dir=' + str(PROFILE), 'about:blank'],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
results = {'checks': [], 'samples': [], 'script_errors': [], 'invalid_requests': [], 'clicks': [], 'logout_requests': []}
REPORT = 'dashboard-profile-results-20261114.json' if '--profile' in sys.argv else 'site-smoothness-results-20261114.json'
try:
    deadline = time.monotonic() + 15
    while not (PROFILE / 'DevToolsActivePort').exists() and time.monotonic() < deadline:
        time.sleep(.1)
    port = int((PROFILE / 'DevToolsActivePort').read_text().splitlines()[0])
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=5) as response:
        target = next(x for x in json.load(response) if x['type'] == 'page')
    with connect(target['webSocketDebuggerUrl'], max_size=20_000_000) as socket:
        sequence = 0
        def call(method, params=None):
            global sequence
            sequence += 1
            socket.send(json.dumps({'id': sequence, 'method': method, 'params': params or {}}))
            response_deadline = time.monotonic() + 30
            while True:
                message = json.loads(socket.recv(timeout=max(.01, response_deadline-time.monotonic())))
                if message.get('method') == 'Runtime.exceptionThrown':
                    detail = message['params']['exceptionDetails']
                    results['script_errors'].append(detail.get('exception', {}).get('description', detail.get('text')))
                if message.get('method') == 'Network.responseReceived':
                    response = message['params']['response']
                    if response['status'] in (400, 403, 404, 422, 500):
                        results['invalid_requests'].append({'url': response['url'], 'status': response['status']})
                if message.get('method') == 'Network.requestWillBeSent' and '/api/logout' in message['params']['request']['url']:
                    results['logout_requests'].append(message['params']['request']['url'])
                if message.get('id') == sequence:
                    if 'error' in message: raise RuntimeError(message['error'])
                    return message.get('result', {})
        def evaluate(expression):
            result = call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
            if 'exceptionDetails' in result: raise RuntimeError(result['exceptionDetails'])
            return result.get('result', {}).get('value')
        def wait(expression, timeout=15):
            until = time.monotonic() + timeout
            while time.monotonic() < until:
                if evaluate(expression): return
                time.sleep(.15)
            results['failure_page'] = evaluate("({url:location.href,ready:document.readyState,visibility:document.visibilityState,hasState:typeof S!=='undefined'&&!!S,logout:document.querySelector('#dashboard-logout')?.outerHTML,clicks:window.__interactionLog,body:document.body?.innerText.slice(0,200)})")
            raise AssertionError('Timed out: ' + expression)
        def click(selector):
            point = evaluate("(async()=>{const e=document.querySelector(" + json.dumps(selector) +
                ");if(!e)throw new Error('Missing control');e.scrollIntoView({block:'center',behavior:'instant'});await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y)),text:e.innerText,disabled:e.disabled,scroll:scrollY}})()")
            results['clicks'].append({'selector': selector, **point})
            assert point['hit'] and not point.get('disabled'), ('Control obstructed', selector, point)
            call('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': point['x'], 'y': point['y']})
            for kind in ('mousePressed', 'mouseReleased'):
                call('Input.dispatchMouseEvent', {'type': kind, 'x': point['x'], 'y': point['y'], 'button': 'left', 'clickCount': 1})
        def check(name, expression):
            value = evaluate(expression)
            if not value:
                results['failure_page'] = evaluate("({url:location.href,ready:document.readyState,dash:document.querySelector('#dash')?.className,drawer:document.querySelector('#bots-drawer')?.className,body:document.body?.className,hit:document.elementFromPoint(innerWidth/2,innerHeight/2)?.outerHTML.slice(0,300)})")
            assert value, name
            results['checks'].append(name)
            print('PASS:', name, flush=True)
        def viewport(width, height):
            call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False})
            evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
        def navigate(path):
            call('Page.navigate', {'url': ORIGIN + path})
            # External fonts and chart frames can load after the controls are usable.
            wait("location.pathname===" + json.dumps(path) + " && document.readyState!=='loading'")
            if path == '/access':
                wait("document.querySelector('.orbit-card')?.style.transform.includes('translate3d')")
        def sample(name):
            value = evaluate("""(async()=>{const durations=[],frames=[];let last=null;
                const observer=new PerformanceObserver(list=>durations.push(...list.getEntries().map(e=>e.duration)));
                observer.observe({type:'longtask'});let active=true;
                function frame(t){if(last!==null)frames.push(t-last);last=t;if(active)requestAnimationFrame(frame)}
                requestAnimationFrame(frame);await new Promise(r=>setTimeout(r,5000));active=false;observer.disconnect();
                frames.sort((a,b)=>a-b);return{visibility:document.visibilityState,frames:frames.length,
                    frameP95Ms:frames[Math.floor(frames.length*.95)]||0,longTasks:durations.length,
                    longestTaskMs:Math.max(0,...durations),longTaskTotalMs:durations.reduce((a,b)=>a+b,0)}})()""")
            results['samples'].append({'page': name, **value})
            print('SAMPLE:', name, json.dumps(value), flush=True)

        if '--logout-only' in sys.argv:
            call('Page.enable');call('Runtime.enable');call('Network.enable')
            viewport(390,844);call('Page.navigate',{'url':ORIGIN+'/dashboard'})
            wait("typeof S!=='undefined'&&!!S&&!!window.ChartIndicators&&!!window.TvChartHost",30)
            evaluate("window.__interactionLog=[];document.addEventListener('click',e=>__interactionLog.push({target:e.target.closest('button')?.id,time:performance.now()}),true)")
            obj=call('Runtime.evaluate',{'expression':"document.querySelector('#dashboard-logout')"})['result']['objectId']
            results['logout_listeners']=call('DOMDebugger.getEventListeners',{'objectId':obj})
            viewport(1280,900);click('#dashboard-logout')
            wait("location.pathname==='/access'",30)
            check('Logout returns to access after a mobile/desktop resize',"!!document.querySelector('.access-button')")
            call('Browser.close');sys.exit(0)

        if '--profile' in sys.argv:
            call('Page.enable'); call('Runtime.enable'); call('Network.enable')
            viewport(1280, 900); call('Page.navigate', {'url': ORIGIN + '/dashboard'})
            wait("typeof S!=='undefined' && !!S && !!window.ChartIndicators && !!window.TvChartHost", 30)
            evaluate('Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1500))])'); time.sleep(2)
            results['dashboard_state'] = evaluate("({ready:document.readyState,visibility:document.visibilityState,nodes:document.querySelectorAll('*').length,indicators:ChartIndicators.state(),animations:document.getAnimations().map(a=>({name:a.animationName,el:a.effect?.target?.id||a.effect?.target?.className}))})")
            call('Profiler.enable'); call('Profiler.start')
            sample('settled desktop dashboard')
            profile = call('Profiler.stop')['profile']
            (ROOT / 'reports' / 'dashboard-cpu-profile.json').write_text(json.dumps(profile), encoding='utf-8')
            evaluate("window.__profileStyle=document.createElement('style');__profileStyle.textContent='*,*::before,*::after{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}';document.head.append(__profileStyle)")
            sample('diagnostic: all blur removed')
            evaluate('__profileStyle.remove()')
            evaluate("document.querySelector('#binance-terminal-section').scrollIntoView({behavior:'instant'})")
            sample('dashboard after chart scroll')
            call('Browser.close')
            sys.exit(0)

        call('Page.enable'); call('Runtime.enable'); call('Network.enable')
        call('Network.setCacheDisabled', {'cacheDisabled': True})
        viewport(1280, 900); navigate('/access')
        check('access page has English content and a centred access button',
            "document.documentElement.lang==='en' && Math.abs(document.querySelector('.access-button').getBoundingClientRect().x+document.querySelector('.access-button').getBoundingClientRect().width/2-innerWidth/2)<10")
        wait("document.querySelector('.orbit-card').style.transform.includes('translate3d')")
        sample('desktop access')
        click('#orbit-toggle')
        first = evaluate("document.querySelector('.orbit-card').style.transform")
        time.sleep(.3)
        assert evaluate("document.querySelector('.orbit-card').style.transform") == first
        results['checks'].append('orbit pause keeps cards still'); print('PASS: orbit pause keeps cards still', flush=True)
        click('#orbit-toggle')
        viewport(390, 844); time.sleep(.3)
        check('mobile access page has no horizontal overflow', 'document.documentElement.scrollWidth<=innerWidth+1')
        sample('mobile access')
        viewport(1280, 900); click('.access-button')
        wait("location.pathname==='/dashboard' && typeof S!=='undefined' && !!S", 30)
        wait("!!window.ChartIndicators && !!window.TvChartHost && !!document.querySelector('#dashboard-logout')", 30)
        evaluate("window.__interactionLog=[];document.addEventListener('click',e=>__interactionLog.push({target:e.target.closest('button')?.id,time:performance.now()}),true)")
        evaluate("Promise.race([document.fonts.ready,new Promise(r=>setTimeout(r,1500))])")
        time.sleep(2)
        check('dashboard defers the closed News list', "document.querySelectorAll('#bot5-news .news-row').length===0")
        results['initial_dashboard_nodes'] = evaluate("document.querySelectorAll('*').length")
        check('live tapes preserve unchanged rows, remove expired rows and reset market keys', """(()=>{
            const el=document.createElement('div'),row=t=>'<div>'+t.value+'</div>',key=t=>t.market+'|'+t.id;
            const a={market:'gold',id:'a',value:'first'},b={market:'gold',id:'b',value:'second'};
            LiveTapeRenderer.render(el,[a,b],key,row,'Empty');const retained=el.firstElementChild;
            LiveTapeRenderer.render(el,[{market:'gold',id:'c',value:'latest'},a],key,row,'Empty');
            if(el.children.length!==2||el.lastElementChild!==retained||el.textContent!=='latestfirst')return false;
            LiveTapeRenderer.render(el,[{market:'btc',id:'a',value:'different market'}],key,row,'Empty');
            if(el.firstElementChild===retained||el.textContent!=='different market')return false;
            LiveTapeRenderer.render(el,[],key,row,'Empty');return el.textContent==='Empty';})()""")
        sample('desktop dashboard')
        click('#rail-bots')
        wait("document.querySelector('#dash').classList.contains('drawer-right-open')")
        wait("!!document.querySelector('#bot5-news').__renderer && document.querySelectorAll('#bot5-news .news-row').length===S.bot5.news.filter(n=>Number(n.expire_ts||n.ts)>Date.now()/1000).length", 20)
        results['loaded_news_rows'] = evaluate("document.querySelectorAll('#bot5-news .news-row').length")
        check('all current economic News rows remain available', "document.querySelectorAll('#bot5-news .news-row').length>0")
        click('#bots-fs-toggle')
        check('News enters fullscreen', "document.querySelector('#bots-drawer').classList.contains('fullscreen')")
        click('#bots-drawer [data-drawer-close]'); time.sleep(.5)
        check('closing fullscreen News restores scrolling and releases the overlay',
            "!document.querySelector('#dash').classList.contains('drawer-right-open') && !document.querySelector('#bots-drawer').classList.contains('fullscreen') && !document.body.classList.contains('no-scroll') && !document.elementFromPoint(innerWidth/2,innerHeight/2).closest('#bots-drawer')")
        viewport(390, 844); time.sleep(.5)
        check('mobile dashboard header keeps Logout in the viewport',
            "(()=>{const r=document.querySelector('#dashboard-logout').getBoundingClientRect();return r.x>=0&&r.right<=innerWidth+1})()")
        sample('mobile dashboard')
        click('#rail-bots'); wait("document.querySelector('#dash').classList.contains('drawer-right-open')")
        click('#bots-fs-toggle')
        call('Input.dispatchKeyEvent', {'type': 'keyDown', 'key': 'Escape', 'code': 'Escape', 'windowsVirtualKeyCode': 27})
        call('Input.dispatchKeyEvent', {'type': 'keyUp', 'key': 'Escape', 'code': 'Escape', 'windowsVirtualKeyCode': 27})
        check('mobile Escape closes fullscreen News', "!document.querySelector('#bots-drawer').classList.contains('fullscreen') && !document.querySelector('#dash').classList.contains('drawer-right-open')")
        viewport(1280, 900); click('#dashboard-logout')
        wait("location.pathname==='/access'")
        wait("!!document.querySelector('.access-button')")
        check('Logout returns to the access page', "location.pathname==='/access' && !!document.querySelector('.access-button')")
        assert not results['script_errors'], results['script_errors']
        results['checks'].append('no uncaught page-script errors')
        call('Browser.close')
except Exception as error:
    results['failure'] = str(error)
    raise
finally:
    (ROOT / 'reports' / REPORT).write_text(json.dumps(results, indent=2), encoding='utf-8')
    if process.poll() is None:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True)
    # Delete only this explicitly created temporary Chrome profile.
    if PROFILE.parent == Path(tempfile.gettempdir()).resolve() and PROFILE.name.startswith('softradex-performance-'):
        shutil.rmtree(PROFILE, ignore_errors=True)
