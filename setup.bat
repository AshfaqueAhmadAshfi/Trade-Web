@echo off
REM ============================================================
REM  SoftradeX Trade - one-time setup
REM  Creates a private Python environment (.venv) inside this
REM  folder and installs every required package.
REM  Internet is needed for the first run only.
REM  Safe to run again any time - it repairs a broken install.
REM  Run with the argument "auto" to skip all pauses
REM  (used by start.bat on first run).
REM ============================================================
setlocal EnableExtensions
cd /d "%~dp0"
title SoftradeX Trade - Setup

set "NOPAUSE="
if /i "%~1"=="auto" set "NOPAUSE=1"

echo.
echo   SoftradeX Trade - Setup
echo   -----------------------
echo.

REM ---------- 1. find a usable Python 3 ----------
set "PY="
for %%P in (
  "C:\Python312\python.exe"
  "C:\Python311\python.exe"
  "C:\Python310\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
  "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
) do (
  if not defined PY if exist %%P set PY=%%P
)
if not defined PY ( py -3.12 -c "import sys" >nul 2>nul && set "PY=py -3.12" )
if not defined PY ( py -3.11 -c "import sys" >nul 2>nul && set "PY=py -3.11" )
if not defined PY ( py -3.10 -c "import sys" >nul 2>nul && set "PY=py -3.10" )
if not defined PY ( py -3    -c "import sys" >nul 2>nul && set "PY=py -3" )
if not defined PY ( python   -c "import sys" >nul 2>nul && set "PY=python" )

if not defined PY (
  echo   [X] Python 3 was not found on this PC.
  echo.
  echo       1. Open   https://www.python.org/downloads/
  echo       2. Install Python 3.12  64-bit
  echo          and tick "Add python.exe to PATH" during install.
  echo       3. Run this file again.
  echo.
  if not defined NOPAUSE pause
  exit /b 1
)

echo   [OK] Using Python: %PY%

REM ---------- 2. create the private environment ----------
if not exist ".venv\Scripts\python.exe" (
  echo        Creating private environment .venv ...
  %PY% -m venv .venv >nul 2>nul
)
if not exist ".venv\Scripts\python.exe" (
  echo   [X] Could not create the private Python environment.
  echo       Reinstall Python 3.12 keeping the default options.
  echo.
  if not defined NOPAUSE pause
  exit /b 1
)
set "VPY=%~dp0.venv\Scripts\python.exe"

REM ---------- 3. install the required packages ----------
echo        Installing packages - first run can take a few minutes...
"%VPY%" -m pip install --disable-pip-version-check --quiet --upgrade pip setuptools wheel
"%VPY%" -m pip install --disable-pip-version-check -r requirements.txt
if errorlevel 1 (
  echo.
  echo   [X] Package installation failed.
  echo       Check the internet connection and run this file again.
  echo.
  if not defined NOPAUSE pause
  exit /b 1
)

REM ---------- 4. verify ----------
"%VPY%" -c "import fastapi, uvicorn, requests, a2wsgi; from websockets.sync.client import connect" >nul 2>nul
if errorlevel 1 (
  echo   [X] The web engine did not install correctly. Run this file again.
  if not defined NOPAUSE pause
  exit /b 1
)
echo   [OK] Web engine installed

echo   [OK] Public API data mode - no trading terminal required

echo.
echo   Setup complete. Double-click start.bat any time to run the app.
echo.
if not defined NOPAUSE pause
exit /b 0
