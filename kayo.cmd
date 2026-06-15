@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install
  echo Installing Playwright Chrome ^(first run only^)...
  call npx playwright install chrome
)
where py >nul 2>&1 && py -3.12 -m pip show pyplayready >nul 2>&1 || (
  echo Installing Python DRM libs...
  py -3.12 -m pip install -r requirements.txt
)
node kayo_cmd.js %*
