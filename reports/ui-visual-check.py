"""Render the affected workspace in an isolated headless Chrome profile.

Freebuff's preview cannot capture pixels while its window is covered/minimized.
This helper uses the existing local server, without touching the user's tabs.
"""
import base64
import json
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from websockets.sync.client import connect

root = Path.cwd().resolve()
profile = Path(tempfile.mkdtemp(prefix="softradex-ui-preview-")).resolve()
chrome = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
process = subprocess.Popen(
    [str(chrome), "--headless=new", "--disable-gpu", "--no-first-run",
     "--no-default-browser-check", "--remote-debugging-port=0",
     "--user-data-dir=" + str(profile), "about:blank"],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    creationflags=subprocess.CREATE_NO_WINDOW,
)
try:
    port_file = profile / "DevToolsActivePort"
    deadline = time.monotonic() + 15
    while not port_file.exists() and time.monotonic() < deadline:
        time.sleep(0.1)
    port = int(port_file.read_text().splitlines()[0])
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list") as response:
        target = next(x for x in json.load(response) if x["type"] == "page")
    with connect(target["webSocketDebuggerUrl"], max_size=20_000_000) as socket:
        sequence = 0

        def call(method, params=None):
            global sequence
            sequence += 1
            socket.send(json.dumps({"id": sequence, "method": method, "params": params or {}}))
            while True:
                result = json.loads(socket.recv(timeout=35))
                if result.get("id") == sequence:
                    if "error" in result:
                        raise RuntimeError(result["error"])
                    return result.get("result", {})

        def evaluate(expression):
            result = call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
            if result.get("exceptionDetails"):
                raise RuntimeError(result["exceptionDetails"])
            return result.get("result", {}).get("value")

        def screenshot(name):
            data = call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
            (root / "reports" / name).write_bytes(base64.b64decode(data["data"]))

        metrics = """(() => {
          const nodes = ['#binance-terminal-section','#binance-term-workspace',
            '.binance-chart-wrapper','#tv-chart-box','.tv-chart-frame',
            '#binance-book-sidebar','#market-news-terminal','#swing-ai-board'];
          return {viewport:[innerWidth,innerHeight], overflow:document.documentElement.scrollWidth-innerWidth,
            nodes:nodes.map(s=>{const e=document.querySelector(s),r=e.getBoundingClientRect();
              return {s,x:r.x,y:r.y,w:r.width,h:r.height,scrollHeight:e.scrollHeight};})};
        })()"""
        call("Page.enable")
        call("Runtime.enable")
        call("Emulation.setDeviceMetricsOverride", {"width":1600,"height":900,"deviceScaleFactor":1,"mobile":False})
        call("Page.addScriptToEvaluateOnNewDocument", {"source": "try { localStorage.setItem('softradex.chart.ind2','[]'); } catch(e) {}"})
        call("Page.navigate", {"url":"http://127.0.0.1:8799/"})
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            if evaluate("!!(window.TvChartHost?.current().ready && document.querySelector('#dash')?.offsetHeight)"):
                break
            time.sleep(0.25)
        time.sleep(5)
        evaluate("document.querySelector('.binance-ticker-strip').scrollIntoView({block:'start'}); true")
        normal = evaluate(metrics)
        screenshot("ui-fixed-desktop-20261113.png")
        evaluate("window.ChartWorkspace.expand(); true")
        time.sleep(2)
        expanded = evaluate(metrics)
        screenshot("ui-fixed-expanded-20261113.png")
        evaluate("window.ChartWorkspace.close(); true")
        call("Emulation.setDeviceMetricsOverride", {"width":375,"height":812,"deviceScaleFactor":1,"mobile":True})
        time.sleep(2)
        mobile = evaluate(metrics)
        result = {"normal":normal,"expanded":expanded,"mobile":mobile}
        (root / "reports/ui-layout-results-20261113.json").write_text(json.dumps(result,indent=2),encoding="utf-8")
        print(json.dumps(result))
finally:
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)
