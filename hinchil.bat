@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist node_modules goto run
echo Installing packages - first time only, please wait...
call npm install
if errorlevel 1 goto fail
:run
node hinchil.js %*
pause
exit /b
:fail
echo Install failed. Check the messages above.
pause
