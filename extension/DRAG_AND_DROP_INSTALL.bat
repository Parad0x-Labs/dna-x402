@echo off
echo.
echo ===============================================
echo   PDX DARK - DRAG & DROP INSTALLER
echo ===============================================
echo.
echo Easiest installation ever! Just like Phantom!
echo.
echo WHY DEVELOPER MODE?
echo Chrome requires Developer Mode for extensions loaded from files
echo (not from Chrome Web Store). This is a SECURITY FEATURE, not a bug!
echo Phantom and other wallets require this too.
echo.
echo INSTALLATION STEPS:
echo ─────────────────────────────────────
echo 1. Extract PDX_Dark.zip to a folder (right-click → Extract All)
echo 2. Open Chrome/Edge extensions page (chrome://extensions/)
echo 3. Enable "Developer mode" toggle (top right)
echo 4. Click "Load unpacked" button
echo 5. Navigate to and select the EXTRACTED folder
echo 6. Click "Select Folder"
echo 7. Done! PDX Dark extension is installed!
echo.
echo IMPORTANT: Select the FOLDER, not the ZIP file!
echo.
echo Press any key to open extensions page automatically...
pause > nul

echo Opening Chrome extensions page...
start chrome "chrome://extensions/"

echo Opening Edge extensions page...
start msedge "edge://extensions/"

echo.
echo Now drag PDX_Dark.zip onto the extensions page!
echo (Enable Developer Mode first if not already enabled)
echo.
echo Need help? Check the install.html file for pictures.
echo.
pause
