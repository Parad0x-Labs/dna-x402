@echo off
mode con: cols=80 lines=30
color 0A
title PDX Dark Protocol - Privacy Wallet Installer

echo.
echo  ██████╗ ██████╗ ██╗  ██╗    ██████╗  █████╗ ██████╗ ██╗  ██╗
echo  ██╔══██╗██╔══██╗╚██╗██╔╝    ██╔══██╗██╔══██╗██╔══██╗██║ ██╔╝
echo  ██████╔╝██║  ██║ ╚███╔╝     ██║  ██║███████║██████╔╝█████╔╝
echo  ██╔═══╝ ██║  ██║ ██╔██╗     ██║  ██║██╔══██║██╔══██╗██╔═██╗
echo  ██║     ██████╔╝██╔╝ ██╗    ██████╔╝██║  ██║██║  ██║██║  ██╗
echo  ╚═╝     ╚═════╝ ╚═╝  ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
echo.
echo                    ZERO-KNOWLEDGE PRIVACY WALLET
echo                    ================================
echo.
echo  Installing PDX Dark Protocol...
echo.
echo  This installer will:
echo  ✓ Detect your browser automatically
echo  ✓ Open extensions page
echo  ✓ Guide you through 2-click installation
echo  ✓ Create desktop shortcuts
echo  ✓ Launch your privacy wallet
echo.
pause

cls
echo.
echo  ██████╗ ██████╗ ██╗  ██╗    ██████╗  █████╗ ██████╗ ██╗  ██╗
echo  ██╔══██╗██╔══██╗╚██╗██╔╝    ██╔══██╗██╔══██╗██╔══██╗██║ ██╔╝
echo  ██████╔╝██║  ██║ ╚███╔╝     ██║  ██║███████║██████╔╝█████╔╝
echo  ██╔═══╝ ██║  ██║ ██╔██╗     ██║  ██║██╔══██║██╔══██╗██╔═██╗
echo  ██║     ██████╔╝██╔╝ ██╗    ██████╔╝██║  ██║██║  ██║██║  ██╗
echo  ╚═╝     ╚═════╝ ╚═╝  ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
echo.
echo                    DETECTING BROWSER...
echo                    ====================
echo.

REM Browser detection
set BROWSER_FOUND=0
set BROWSER_NAME=

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
    set BROWSER_FOUND=1
    set BROWSER_NAME=Chrome
    set BROWSER_CMD=chrome
    goto :browser_found
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
    set BROWSER_FOUND=1
    set BROWSER_NAME=Chrome
    set BROWSER_CMD=chrome
    goto :browser_found
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
    set BROWSER_FOUND=1
    set BROWSER_NAME=Edge
    set BROWSER_CMD=msedge
    goto :browser_found
)

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    set BROWSER_FOUND=1
    set BROWSER_NAME=Edge
    set BROWSER_CMD=msedge
    goto :browser_found
)

echo  ❌ No compatible browser found!
echo.
echo  Please install Google Chrome or Microsoft Edge:
echo  • Chrome: https://chrome.google.com
echo  • Edge:   https://microsoft.com/edge
echo.
echo  Press any key to exit...
pause > nul
exit /b 1

:browser_found
echo  ✅ %BROWSER_NAME% detected!
echo.
echo  Press any key to open %BROWSER_NAME% extensions page...
pause > nul

cls
echo.
echo  ██████╗ ██████╗ ██╗  ██╗    ██████╗  █████╗ ██████╗ ██╗  ██╗
echo  ██╔══██╗██╔══██╗╚██╗██╔╝    ██╔══██╗██╔══██╗██╔══██╗██║ ██╔╝
echo  ██████╔╝██║  ██║ ╚███╔╝     ██║  ██║███████║██████╔╝█████╔╝
echo  ██╔═══╝ ██║  ██║ ██╔██╗     ██║  ██║██╔══██║██╔══██╗██╔═██╗
echo  ██║     ██████╔╝██╔╝ ██╗    ██████╔╝██║  ██║██║  ██║██║  ██╗
echo  ╚═╝     ╚═════╝ ╚═╝  ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
echo.
echo                    OPENING %BROWSER_NAME%...
echo                    ====================
echo.

echo  Opening %BROWSER_NAME% extensions page...
start %BROWSER_CMD% "%BROWSER_CMD%://extensions/"

echo.
echo  IMPORTANT: In %BROWSER_NAME%, please:
echo.
if "%BROWSER_NAME%"=="Chrome" (
    echo  1. Click "Developer mode" toggle (TOP RIGHT)
    echo  2. Click "Load unpacked" button
) else (
    echo  1. Click "Developer mode" toggle (BOTTOM LEFT)
    echo  2. Click "Load unpacked" button
)
echo  3. Navigate to: %~dp0extension
echo  4. IMPORTANT: Select the "extension" FOLDER (not a file!)
echo  5. Click "Select Folder"
echo.
echo  Press any key when extension is loaded...
pause > nul

cls
echo.
echo  ██████╗ ██████╗ ██╗  ██╗    ██████╗  █████╗ ██████╗ ██╗  ██╗
echo  ██╔══██╗██╔══██╗╚██╗██╔╝    ██╔══██╗██╔══██╗██╔══██╗██║ ██╔╝
echo  ██████╔╝██║  ██║ ╚███╔╝     ██║  ██║███████║██████╔╝█████╔╝
echo  ██╔═══╝ ██║  ██║ ██╔██╗     ██║  ██║██╔══██║██╔══██╗██╔═██╗
echo  ██║     ██████╔╝██╔╝ ██╗    ██████╔╝██║  ██║██║  ██║██║  ██╗
echo  ╚═╝     ╚═════╝ ╚═╝  ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
echo.
echo                    CREATING SHORTCUTS...
echo                    ===================
echo.

echo  Creating desktop shortcuts...
powershell -Command "& { $WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\PDX Dark Wallet.lnk'); $Shortcut.TargetPath = '%~dp0extension\install.html'; $Shortcut.WorkingDirectory = '%~dp0extension'; $Shortcut.Description = 'PDX Dark Protocol - Privacy Wallet'; $Shortcut.IconLocation = 'chrome.exe,0'; $Shortcut.Save() }" 2> nul

powershell -Command "& { $WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\PDX Full Wallet.lnk'); $Shortcut.TargetPath = 'cmd.exe'; $Shortcut.Arguments = '/c cd /d ""%~dp0wallet"" && echo Starting PDX Wallet... && npm run dev'; $Shortcut.WorkingDirectory = '%~dp0wallet'; $Shortcut.Description = 'PDX Dark Full Wallet App'; $Shortcut.IconLocation = 'chrome.exe,0'; $Shortcut.Save() }" 2> nul

cls
echo.
echo  ██████╗ ██████╗ ██╗  ██╗    ██████╗  █████╗ ██████╗ ██╗  ██╗
echo  ██╔══██╗██╔══██╗╚██╗██╔╝    ██╔══██╗██╔══██╗██╔══██╗██║ ██╔╝
echo  ██████╔╝██║  ██║ ╚███╔╝     ██║  ██║███████║██████╔╝█████╔╝
echo  ██╔═══╝ ██║  ██║ ██╔██╗     ██║  ██║██╔══██║██╔══██╗██╔═██╗
echo  ██║     ██████╔╝██╔╝ ██╗    ██████╔╝██║  ██║██║  ██║██║  ██╗
echo  ╚═╝     ╚═════╝ ╚═╝  ╚═╝    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝
echo.
echo                    🎉 INSTALLATION COMPLETE! 🎉
echo                    ============================
echo.
echo  PDX Dark Privacy Wallet is now installed!
echo.
echo  Desktop shortcuts created:
echo  • PDX Dark Wallet    - Extension guide & wallet
echo  • PDX Full Wallet    - Full web wallet app
echo.
echo  To use PDX Dark:
echo  1. Find PDX icon in browser toolbar
echo  2. Click to open privacy wallet
echo  3. Generate wallets & send private transfers!
echo.
echo  ===============================================
echo  Welcome to zero-knowledge privacy on Solana!
echo  ===============================================
echo.
echo  Press any key to finish...
pause > nul

exit /b 0
