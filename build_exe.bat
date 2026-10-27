@echo off
set NODE_PATH="C:\Program Files\nodejs\node.exe"
cd C:\Users\MIKE\Documents\repos\kanban-desktop-app
"%NODE_PATH%" C:\Users\MIKE\Documents\repos\kanban-desktop-app\node_modules\.bin\electron-builder.cmd --win nsis --config electron-builder.config.js --publish never
echo.
echo Build complete.
timeout /t 5 /nobreak >nul