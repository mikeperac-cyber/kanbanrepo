@echo off
cd C:\Users\MIKE\Documents\repos\kanban-desktop-app
set NODE_PATH=C:\Program Files\nodejs\node.exe
"%NODE_PATH%" "%USERPROFILE%\AppData\Local\Programs\nodejs\node_modules\electron-builder\bin\electron-builder.js" --win nsis --config electron-builder.config.js --publish never
echo.
echo Build complete.
timeout /t 3 /nobreak >nul