@echo off
chcp 65001 >nul
rem ---------------------------------------------------------------
rem  build-portable.bat : makes a no-install zip (node.exe + packages + model)
rem  Run this on YOUR PC, in the same folder as gui-server.js.
rem  Needs: Node.js installed on your PC, internet (first time).
rem  Result: dist\NAI-Factory-Hinchil-v(version)-win-x64.zip
rem ---------------------------------------------------------------
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Node.js is not installed. & goto fail)
where npm >nul 2>nul
if errorlevel 1 (echo npm not found. & goto fail)

set "VER=0"
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set "VER=%%v"
set "ZIP=NAI-Factory-Hinchil-v%VER%-win-x64.zip"

echo [1/6] Checking model file...
if not exist models mkdir models
node -e "require('./hinchil.js').ensureModel('anime').then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})"
if errorlevel 1 goto fail

echo [2/6] Cleaning dist...
if exist dist rmdir /s /q dist
mkdir dist\NAI-Factory-Hinchil\models

echo [3/6] Copying files...
copy /y "Start NAI Factory.bat" "dist\NAI-Factory-Hinchil\" >nul
if errorlevel 1 (echo "Start NAI Factory.bat" is missing. & goto fail)
for %%f in (core.js hinchil.js gui-server.js gui.html scan.js gen-api.js generate.html generate.js package.json icon.ico README.txt LICENSE NOTICE-anime-censor.txt NOTICE-third-party.txt) do (
  if exist "%%f" copy /y "%%f" "dist\NAI-Factory-Hinchil\" >nul
)
rem Ship a shortcut with a relative path (best effort; the launcher refreshes it on first run)
if exist shortcut-template.lnk copy /y shortcut-template.lnk "dist\NAI-Factory-Hinchil\NAI Factory.lnk" >nul
if exist LICENSE.txt copy /y LICENSE.txt "dist\NAI-Factory-Hinchil\" >nul
copy /y "models\censor_detect_v1.0_s.onnx" "dist\NAI-Factory-Hinchil\models\" >nul
if errorlevel 1 goto fail

echo [4/6] Installing packages for Windows (a few minutes)...
pushd dist\NAI-Factory-Hinchil
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 (popd & goto fail)
popd

echo Removing binaries for other systems (macOS, Linux, Windows ARM) to keep the zip small...
if exist "dist\NAI-Factory-Hinchil\node_modules\onnxruntime-node\bin" (
  pushd "dist\NAI-Factory-Hinchil\node_modules\onnxruntime-node\bin"
  for /d %%v in (napi-v*) do (
    if exist "%%v\darwin" rmdir /s /q "%%v\darwin"
    if exist "%%v\linux" rmdir /s /q "%%v\linux"
    if exist "%%v\win32\arm64" rmdir /s /q "%%v\win32\arm64"
  )
  popd
)

echo [5/6] Copying node.exe...
set "NODEEXE="
for /f "delims=" %%i in ('where node') do if not defined NODEEXE set "NODEEXE=%%i"
copy /y "%NODEEXE%" "dist\NAI-Factory-Hinchil\node.exe" >nul
if errorlevel 1 goto fail

echo [6/6] Making zip...
tar -a -c -f dist\%ZIP% -C dist NAI-Factory-Hinchil
if errorlevel 1 (
  powershell -NoProfile -Command "Compress-Archive -Path 'dist\NAI-Factory-Hinchil' -DestinationPath 'dist\%ZIP%' -Force"
  if errorlevel 1 goto fail
)

echo.
echo DONE: dist\%ZIP%
echo Test it: unzip somewhere else and double-click "Start NAI Factory.bat"
pause
exit /b 0
:fail
echo.
echo Build failed. Check the messages above.
pause
exit /b 1
