@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0node.exe" goto portable
set "NODE=node"
if exist node_modules goto run
echo Installing packages - first time only, please wait...
call npm install --omit=dev
if errorlevel 1 goto fail
goto run
:portable
set "NODE=%~dp0node.exe"
:run
"%NODE%" gui-server.js
if errorlevel 1 pause
exit /b
:fail
echo Install failed. Check the messages above.
pause
