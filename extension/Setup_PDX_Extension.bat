@echo off
setlocal enabledelayedexpansion

echo.
echo ===============================================
echo      PDX DARK PROTOCOL EXTENSION SETUP
echo ===============================================
echo.
echo Welcome to PDX Dark - Zero-Knowledge Privacy Wallet
echo.
echo This setup will install the PDX Dark browser extension
echo for Google Chrome and Microsoft Edge.
echo.
echo Features:
echo ✅ Generate new Solana wallets
echo ✅ Import existing wallets (keys/seed phrases)
echo ✅ Send anonymous privacy transfers
echo ✅ Zero-knowledge cryptography
echo ✅ Beautiful cyberpunk UI
echo.
echo Press any key to continue...
pause > nul

cls
echo.
echo ===============================================
echo             DETECTING BROWSERS
echo ===============================================
echo.

set CHROME_FOUND=0
set EDGE_FOUND=0

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    echo ✅ Google Chrome detected
    set CHROME_FOUND=1
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    echo ✅ Google Chrome detected
    set CHROME_FOUND=1
) else (
    echo ❌ Google Chrome not found
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    echo ✅ Microsoft Edge detected
    set EDGE_FOUND=1
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    echo ✅ Microsoft Edge detected
    set EDGE_FOUND=1
) else (
    echo ❌ Microsoft Edge not found
)

if %CHROME_FOUND%==0 if %EDGE_FOUND%==0 (
    echo.
    echo ❌ No compatible browsers found!
    echo Please install Google Chrome or Microsoft Edge first.
    echo.
    echo Press any key to exit...
    pause > nul
    exit /b 1
)

echo.
echo Press any key to start installation...
pause > nul

cls
echo.
echo ===============================================
echo            CHOOSE YOUR BROWSER
echo ===============================================
echo.
if %CHROME_FOUND%==1 echo 1. Install for Google Chrome
if %EDGE_FOUND%==1 echo 2. Install for Microsoft Edge
if %CHROME_FOUND%==1 if %EDGE_FOUND%==1 echo 3. Install for Both Browsers
echo 4. Cancel Installation
echo.
set /p choice="Enter your choice (1-4): "

if "%choice%"=="4" (
    echo Installation cancelled.
    pause
    exit /b 0
)

if "%choice%"=="1" if %CHROME_FOUND%==0 (
    echo Chrome not found! Please choose a valid option.
    pause
    goto :browser_choice
)

if "%choice%"=="2" if %EDGE_FOUND%==0 (
    echo Edge not found! Please choose a valid option.
    pause
    goto :browser_choice
)

:browser_choice
if "%choice%"=="3" if %EDGE_FOUND%==1 if %CHROME_FOUND%==1 (
    call :install_chrome
    call :install_edge
    goto :finish
)

if "%choice%"=="1" call :install_chrome
if "%choice%"=="2" call :install_edge

goto :finish

:install_chrome
echo.
echo ===============================================
echo        INSTALLING FOR GOOGLE CHROME
echo ===============================================
echo.
echo Step 1: Opening Chrome Extensions page...
start chrome "chrome://extensions/"
timeout /t 3 /nobreak > nul

echo Step 2: Please enable "Developer mode" in Chrome
echo        (toggle switch in top right corner)
echo.
echo        WHY? Chrome requires Developer Mode for extensions loaded from files
echo        (not from Chrome Web Store). This is SECURITY - prevents malware!
echo        Phantom and other wallets require this too.
echo.
echo Press any key when Developer Mode is enabled...
pause > nul

echo.
echo Step 3: Installing PDX Dark extension...
echo Please click "Load unpacked" in Chrome and select:
echo %~dp0
echo.
echo Press any key when extension is loaded...
pause > nul

echo ✅ Chrome installation complete!
goto :eof

:install_edge
echo.
echo ===============================================
echo        INSTALLING FOR MICROSOFT EDGE
echo ===============================================
echo.
echo Step 1: Opening Edge Extensions page...
start msedge "edge://extensions/"
timeout /t 3 /nobreak > nul

echo Step 2: Please enable "Developer mode" in Edge
echo        (toggle switch in bottom left corner)
echo.
echo Press any key when Developer Mode is enabled...
pause > nul

echo.
echo Step 3: Installing PDX Dark extension...
echo Please click "Load unpacked" in Edge and select:
echo %~dp0
echo.
echo Press any key when extension is loaded...
pause > nul

echo ✅ Edge installation complete!
goto :eof

:finish
cls
echo.
echo ===============================================
echo         🎉 INSTALLATION COMPLETE! 🎉
echo ===============================================
echo.
echo PDX Dark Protocol extension has been installed!
echo.
echo To use your privacy wallet:
echo.
echo 1. Look for the PDX Dark icon in your browser toolbar
echo    (It might be hidden - click the puzzle piece 🧩 to show it)
echo.
echo 2. Click the icon to open your wallet
echo.
echo 3. Generate your first wallet:
echo    - Click "🎲 Generate New Wallet"
echo    - Give it a name like "My PDX Wallet"
echo    - The wallet file will download automatically
echo.
echo 4. Connect to send transfers:
echo    - Click "🔌 Connect Phantom"
echo    - Send private zero-knowledge transfers!
echo.
echo ===============================================
echo              IMPORTANT SECURITY NOTES
echo ===============================================
echo.
echo ⚠️  BACKUP YOUR WALLETS:
echo    - Never lose your downloaded .json wallet files
echo    - Store them securely (encrypted drive recommended)
echo    - Never share your private keys
echo.
echo ⚠️  SESSION SAFETY:
echo    - Always disconnect after use
echo    - Clear browser data regularly
echo    - Use incognito mode for sensitive operations
echo.
echo ⚠️  THIS IS EXPERIMENTAL:
echo    - Only use for testing on devnet
echo    - Mainnet version coming soon
echo    - Report any bugs to the developers
echo.
echo ===============================================
echo.
echo Thank you for installing PDX Dark Protocol!
echo Your privacy is now protected with zero-knowledge cryptography.
echo.
echo Happy anonymous transferring! 🛡️🔒🕵️
echo.
echo Press any key to finish setup...
pause > nul

echo.
echo Creating desktop shortcut...
echo Dim oWS, oLink > "%temp%\CreateShortcut.vbs"
echo Set oWS = WScript.CreateObject("WScript.Shell") >> "%temp%\CreateShortcut.vbs"
echo Set oLink = oWS.CreateShortcut(oWS.SpecialFolders("Desktop") ^& "\PDX Dark Wallet.lnk") >> "%temp%\CreateShortcut.vbs"
echo oLink.TargetPath = "%~dp0install.html" >> "%temp%\CreateShortcut.vbs"
echo oLink.Description = "PDX Dark Protocol - Privacy Wallet" >> "%temp%\CreateShortcut.vbs"
echo oLink.WorkingDirectory = "%~dp0" >> "%temp%\CreateShortcut.vbs"
echo oLink.IconLocation = "chrome.exe,0" >> "%temp%\CreateShortcut.vbs"
echo oLink.Save >> "%temp%\CreateShortcut.vbs"
cscript //nologo "%temp%\CreateShortcut.vbs"
del "%temp%\CreateShortcut.vbs"

echo Desktop shortcut created! Double-click "PDX Dark Wallet" to open the wallet.
echo.
pause
