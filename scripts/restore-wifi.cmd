@echo off
REM Right-click this file and choose "Run as administrator".
REM Puts the Wi-Fi adapter back on automatic addressing (DHCP) and DNS, which is
REM what MattStream had been left switched away from.
setlocal
echo Current Wi-Fi address:
netsh interface ip show config name="Wi-Fi"
echo.
echo Switching Wi-Fi to automatic (DHCP)...
netsh interface ip set address name="Wi-Fi" source=dhcp
netsh interface ip set dns name="Wi-Fi" source=dhcp
echo Renewing the lease...
ipconfig /renew "Wi-Fi"
ipconfig /flushdns
echo.
echo Now:
netsh interface ip show config name="Wi-Fi"
echo.
echo Done. If this window is on a network you want to keep a fixed address on,
echo ask the router for a DHCP reservation for this PC instead.
pause
