@echo off
echo Opening PDX Dark Protocol Installer...
start INSTALL_PDX.html
echo.
echo ===============================================
echo      IMPORTANT FOLDER PATH
echo ===============================================
echo.
echo When asked to select a folder, choose:
echo %~dp0extension
echo.
echo NOT the main pdx_dark_protocol folder!
echo.
echo The extension folder contains manifest.json
echo.
pause
