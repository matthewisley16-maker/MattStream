@echo off
setlocal
cd /d "%~dp0"
title MattStream

rem Preferred: the desktop app (its own window, no browser, no console left behind).
if exist "node_modules\electron\dist\electron.exe" (
    start "" "node_modules\electron\dist\electron.exe" .
    goto :done
)

rem Fallback: run the server and open the web app in the default browser.
where node >nul 2>nul
if %errorlevel%==0 (
    node server\index.js --open %*
    goto :done
)

if exist "..\.tools\node\node.exe" (
    "..\.tools\node\node.exe" server\index.js --open %*
    goto :done
)

echo.
echo   MattStream needs Node.js to run, and it could not find it.
echo   Install the LTS build from https://nodejs.org and run this file again.
echo.
pause
exit /b 1

:done
if errorlevel 1 (
    echo.
    echo   MattStream stopped.
    pause
)
endlocal
