@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Please install Node.js first.
  pause
  exit /b 1
)

set "NODE_OPTIONS=--dns-result-order=ipv4first"

echo Starting local preview at http://localhost:8787
start "" /min cmd /c "node server.js"
timeout /t 1 /nobreak >nul
start "" http://localhost:8787
