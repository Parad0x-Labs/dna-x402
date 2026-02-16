@echo off
echo.
echo ===============================================
echo    PDX DARK PROTOCOL - ONE-CLICK INSTALLER
echo ===============================================
echo.
echo Installing PDX Dark privacy wallet extension...
echo.
echo This will:
echo 1. Open Chrome extensions page
echo 2. Enable developer mode
echo 3. Load PDX Dark extension
echo.
echo Press any key to start installation...
pause > nul

echo.
echo Step 1: Opening Chrome extensions page...
start chrome "chrome://extensions/"

echo Step 2: Waiting for you to enable Developer Mode...
echo.
echo IMPORTANT: In the Chrome window that opened:
echo 1. Look for "Developer mode" toggle (top right)
echo 2. Click it to turn ON developer mode
echo 3. Press any key here when done...
echo.
pause > nul

echo.
echo Step 3: Loading PDX Dark extension...
powershell -Command "& { $extensionPath = '%~dp0'; $chromeExtensionsPath = 'chrome://extensions/'; $loadCommand = 'document.querySelector(''extensions-manager'').shadowRoot.querySelector(''extensions-toolbar'').shadowRoot.querySelector(''#loadUnpacked'').click();'; start chrome ('chrome://extensions/') }"

echo.
echo Almost done! Now you need to:
echo 1. In Chrome, click the "Load unpacked" button
echo 2. Navigate to: %~dp0
echo 3. Click "Select Folder"
echo.
echo Press any key when extension is loaded...
pause > nul

echo.
echo ===============================================
echo         INSTALLATION COMPLETE!
echo ===============================================
echo.
echo PDX Dark extension is now installed!
echo.
echo To use it:
echo 1. Look for PDX icon in Chrome toolbar
echo 2. Click to open privacy wallet
echo 3. Generate wallets, send private transfers!
echo.
echo Happy privacy transferring! 🛡️🔒
echo.
pause
