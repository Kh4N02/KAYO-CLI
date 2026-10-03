@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing Node dependencies...
  call npm install
  echo Installing Playwright Chrome ^(first run only^)...
  call npx playwright install chrome
)
node "%~dp0scripts\install-python-deps.js" --check-only
if errorlevel 1 (
  echo.
  echo Python setup failed. See SETUP.md — install Python 3.10+ and add it to PATH.
  pause
  exit /b 1
)
node "%~dp0scripts\ensure-cmd-devices.js"
node kayo_cmd.js %*
