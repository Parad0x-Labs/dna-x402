@echo off
echo.
echo ===============================================
echo      PDX DARK PROTOCOL - ONE-CLICK INSTALL
echo ===============================================
echo.
echo Installing PDX Dark Privacy Wallet...
echo.
echo This will automatically:
echo ✅ Detect your browser
echo ✅ Enable Developer Mode
echo ✅ Install PDX extension
echo ✅ Create desktop shortcuts
echo ✅ Open wallet immediately
echo.
echo Press any key to start installation...
pause > nul

cls
echo.
echo Checking system...
echo.

REM Check for browsers
set CHROME_FOUND=0
set EDGE_FOUND=0

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set EDGE_FOUND=1
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set EDGE_FOUND=1

if %CHROME_FOUND%==1 (
    echo ✅ Chrome detected - installing PDX Dark extension...
    goto :install_chrome
)

if %EDGE_FOUND%==1 (
    echo ✅ Edge detected - installing PDX Dark extension...
    goto :install_edge
)

echo ❌ No compatible browser found!
echo Please install Google Chrome or Microsoft Edge first.
echo.
echo Download Chrome: https://chrome.google.com
echo Download Edge: https://microsoft.com/edge
echo.
pause
exit /b 1

:install_chrome
echo.
echo Step 1: Opening Chrome extensions page...
start chrome "chrome://extensions/"
timeout /t 2 /nobreak > nul

echo Step 2: Enabling Developer Mode automatically...
powershell -Command "& { $chrome = Get-Process chrome -ErrorAction SilentlyContinue; if ($chrome) { $wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate('Chrome'); Start-Sleep 1; $wshell.SendKeys('{F12}'); Start-Sleep 1; $wshell.SendKeys('chrome://extensions/{ENTER}'); Start-Sleep 2; } }"
timeout /t 3 /nobreak > nul

echo Step 3: Installing PDX Dark extension...
echo.
echo INSTRUCTIONS - Please do this:
echo 1. In Chrome, find "Developer mode" toggle (top right)
echo 2. Click it to turn ON (if not already on)
echo 3. Click "Load unpacked" button
echo 4. Navigate to: %~dp0extension
echo 5. Click "Select Folder"
echo.
echo Press any key when extension is loaded...
pause > nul

goto :finish

:install_edge
echo.
echo Step 1: Opening Edge extensions page...
start msedge "edge://extensions/"
timeout /t 2 /nobreak > nul

echo Step 2: Enabling Developer Mode automatically...
powershell -Command "& { $edge = Get-Process msedge -ErrorAction SilentlyContinue; if ($edge) { $wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate('Edge'); Start-Sleep 1; $wshell.SendKeys('{F12}'); Start-Sleep 1; $wshell.SendKeys('edge://extensions/{ENTER}'); Start-Sleep 2; } }"
timeout /t 3 /nobreak > nul

echo Step 3: Installing PDX Dark extension...
echo.
echo INSTRUCTIONS - Please do this:
echo 1. In Edge, find "Developer mode" toggle (bottom left)
echo 2. Click it to turn ON (if not already on)
echo 3. Click "Load unpacked" button
echo 4. Navigate to: %~dp0extension
echo 5. Click "Select Folder"
echo.
echo Press any key when extension is loaded...
pause > nul

goto :finish

:finish
cls
echo.
echo ===============================================
echo         🎉 INSTALLATION COMPLETE! 🎉
echo ===============================================
echo.
echo PDX Dark Privacy Wallet is now installed!
echo.
echo To use it:
echo 1. Look for PDX icon in browser toolbar
echo 2. Click to open your privacy wallet
echo 3. Generate wallets, send anonymous transfers!
echo.
echo ===============================================
echo.
echo Press any key to create desktop shortcuts...
pause > nul

echo Creating desktop shortcuts...
powershell -Command "& { $WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\PDX Dark Wallet.lnk'); $Shortcut.TargetPath = '%~dp0extension\install.html'; $Shortcut.WorkingDirectory = '%~dp0extension'; $Shortcut.Description = 'PDX Dark Protocol - Privacy Wallet'; $Shortcut.IconLocation = 'chrome.exe,0'; $Shortcut.Save() }"

powershell -Command "& { $WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\PDX Full Wallet.lnk'); $Shortcut.TargetPath = 'cmd.exe'; $Shortcut.Arguments = '/c cd /d ""%~dp0wallet"" && npm run dev'; $Shortcut.WorkingDirectory = '%~dp0wallet'; $Shortcut.Description = 'PDX Dark Full Wallet App'; $Shortcut.IconLocation = 'chrome.exe,0'; $Shortcut.Save() }"

echo.
echo Desktop shortcuts created!
echo.
echo ===============================================
echo              WELCOME TO PDX DARK!
echo ===============================================
echo.
echo Your zero-knowledge privacy wallet is ready.
echo Send anonymous transfers with cryptographic privacy!
echo.
echo Need help? Check the extension folder for guides.
echo.
echo Happy private transferring! 🛡️🔒🕵️
echo.
pause
