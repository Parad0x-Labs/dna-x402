@echo off
echo.
echo ===============================================
echo     PDX DARK - DESKTOP ICON CREATOR
echo ===============================================
echo.
echo This will create a desktop icon for easy access to:
echo ✅ PDX Dark Wallet Extension
echo ✅ Installation Guide
echo ✅ Full Wallet App
echo.
echo Press any key to create desktop icons...
pause > nul

echo.
echo Creating PDX Dark Wallet icon...
powershell -Command "& { $WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\PDX Dark Wallet.lnk'); $Shortcut.TargetPath = '%~dp0install.html'; $Shortcut.WorkingDirectory = '%~dp0'; $Shortcut.Description = 'PDX Dark Protocol - Privacy Wallet Extension'; $Shortcut.IconLocation = 'chrome.exe,0'; $Shortcut.Save() }"

echo Creating Installation Guide icon...
powershell -Command "& { $WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\Install PDX Dark.lnk'); $Shortcut.TargetPath = '%~dp0Setup_PDX_Extension.bat'; $Shortcut.WorkingDirectory = '%~dp0'; $Shortcut.Description = 'Install PDX Dark Extension'; $Shortcut.IconLocation = 'msiexec.exe,0'; $Shortcut.Save() }"

echo Creating Full Wallet App icon...
powershell -Command "& { $WshShell = New-Object -comObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut('%USERPROFILE%\Desktop\PDX Full Wallet.lnk'); $Shortcut.TargetPath = 'cmd.exe'; $Shortcut.Arguments = '/c cd /d ""%~dp0..\..\wallet"" && npm run dev'; $Shortcut.WorkingDirectory = '%~dp0..\..\wallet'; $Shortcut.Description = 'PDX Dark Full Wallet App'; $Shortcut.IconLocation = 'chrome.exe,0'; $Shortcut.Save() }"

echo.
echo ===============================================
echo         ✅ DESKTOP ICONS CREATED!
echo ===============================================
echo.
echo Your desktop now has:
echo 🕵️ "PDX Dark Wallet" - Opens extension guide
echo 📦 "Install PDX Dark" - Runs installer
echo 💻 "PDX Full Wallet" - Opens full wallet app
echo.
echo Just double-click any icon to get started!
echo.
pause
