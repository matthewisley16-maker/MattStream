@echo off
setlocal
cd /d "%~dp0"
title MattStream - share

rem Shares this PC's library on a public https address. No admin rights and no
rem firewall or router changes: the tunnel connects outwards and Cloudflare
rem forwards requests back to the server running here.

if not exist ".tools\cloudflared.exe" (
    echo.
    echo   The tunnel program is missing. Download it once:
    echo     curl -L -o .tools\cloudflared.exe https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
    echo.
    pause
    exit /b 1
)

rem Start the media server unless something is already answering on 8096.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8096/api/status | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
    set "ELECTRON_RUN_AS_NODE=1"
    start "MattStream server" "node_modules\electron\dist\electron.exe" server\index.js
    timeout /t 3 >nul
)

echo.
echo   Sharing this PC's library. The public address is printed below -
echo   send it to anyone. Keep this window open while people are watching;
echo   close it to stop sharing.
echo.
".tools\cloudflared.exe" tunnel --url http://127.0.0.1:8096 --no-autoupdate

echo.
echo   Sharing stopped - that address no longer works.
pause
endlocal
