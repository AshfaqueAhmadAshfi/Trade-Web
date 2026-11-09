@echo off
REM ============================================================
REM  SoftradeX Trade - one click launcher
REM  Double-click to run. The very first time it will call
REM  setup.bat automatically (needs internet, a few minutes),
REM  then starts the dashboard and opens your browser.
REM  Stop the app by closing this window (Ctrl+C also works).
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"
title SoftradeX Trade

set "VPY=%~dp0.venv\Scripts\python.exe"

REM ---------- first run: set the app up automatically ----------
if not exist "%VPY%" (
  echo   First run detected - preparing the app, one moment...
  echo.
  call setup.bat auto
  if errorlevel 1 (
    echo.
    echo   [X] Setup failed. Open setup.bat to see the reason.
    pause
    exit /b 1
  )
  echo.
)

REM ---------- read the dashboard port from config ----------
set "PORT=8777"
for /f "usebackq delims=" %%P in (`"%VPY%" -c "import json;print(json.load(open(r'config\config.json',encoding='utf-8')).get('port',8777))" 2^>nul`) do set "PORT=%%P"

REM ---------- already running? just open the browser ----------
"%VPY%" -c "import socket;socket.create_connection(('127.0.0.1',%PORT%),1).close()" >nul 2>nul
if not errorlevel 1 (
  echo   SoftradeX Trade is already running on port %PORT%.
  start "" "http://127.0.0.1:%PORT%/"
  pause
  exit /b 0
)

REM ---------- open the browser as soon as the server is up ----------
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=%PORT%;for($i=0;$i -lt 60;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',$p);$c.Close();break}catch{Start-Sleep -Milliseconds 500}};Start-Process ('http://127.0.0.1:'+$p+'/')"

echo   Starting SoftradeX Trade on http://127.0.0.1:%PORT%/ ...
echo   Keep this window open while the app runs; close it to stop.
echo.
"%VPY%" "backend\app.py"

echo.
echo   Dashboard stopped.
pause
