@echo off
chcp 65001 >nul
title NAI Factory - Hinchil
cd /d "%~dp0"
rem Make (or refresh) a shortcut with an icon next to this file. Runs in the background; errors are ignored.
if not exist "%~dp0icon.ico" goto noicon
set "HERE=%~dp0"
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "try{$h=$env:HERE;$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $h 'NAI Factory.lnk'));$s.TargetPath=(Join-Path $h 'Start NAI Factory.bat');$s.WorkingDirectory=$h;$s.IconLocation=(Join-Path $h 'icon.ico');$s.Description='NAI Factory - Hinchil';$s.Save()}catch{}" >nul 2>nul
:noicon
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
