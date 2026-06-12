@echo off
setlocal EnableExtensions DisableDelayedExpansion
title DeepSeek CLI Easy Install
cd /d "%~dp0"

echo ===============================================
echo            DeepSeek CLI Easy Installer
echo ===============================================
echo.
echo  This script will:
echo    - Check or install Node.js
echo    - Install project dependencies
echo    - Build the project
echo    - Register the global command: dsk
echo.
echo  If Windows asks for permission, click Yes.
echo.
pause
echo.

REM ---- 0. Make sure this script is in the project directory. ----
if not exist "package.json" (
    echo [ERROR] package.json was not found in this folder.
    echo         Put this script in the project root, next to package.json.
    echo.
    pause
    exit /b 1
)

REM ---- 1. Check Node.js. ----
echo [1/5] Checking Node.js ...
where node >nul 2>&1
if not errorlevel 1 goto NODE_READY

echo       Node.js was not found. Starting automatic install.
echo       Internet access is required.
echo.

where winget >nul 2>&1
if errorlevel 1 goto INSTALL_MSI

echo       Installing Node.js LTS with winget ...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto NODE_FAIL
goto NODE_INSTALLED

:INSTALL_MSI
echo       winget was not found. Downloading the official Node.js installer ...
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; try { $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'; $lts = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version; $arch = if([Environment]::Is64BitOperatingSystem){'x64'}else{'x86'}; $url = 'https://nodejs.org/dist/' + $lts + '/node-' + $lts + '-' + $arch + '.msi'; Write-Host ('       Node version: ' + $lts); Invoke-WebRequest $url -OutFile ($env:TEMP + '\nodejs-lts.msi') } catch { Write-Host 'download failed'; exit 1 }"
if errorlevel 1 goto NODE_FAIL
echo       Installing Node.js ...
msiexec /i "%TEMP%\nodejs-lts.msi" /qb
if errorlevel 1 goto NODE_FAIL

:NODE_INSTALLED
REM Refresh PATH for this window so node, npm, and global commands are available.
set "PATH=%ProgramFiles%\nodejs\;%APPDATA%\npm;%PATH%"
where node >nul 2>&1
if not errorlevel 1 goto NODE_READY
echo.
echo       Node.js was installed, but this window cannot see it yet.
echo       Close this window, then run eazy.bat again.
echo.
pause
exit /b 0

:NODE_READY
for /f "delims=" %%v in ('node -v') do echo       Node.js is ready ^(%%v^)
where npm >nul 2>&1
if errorlevel 1 goto NPM_FAIL
echo.

REM Make sure the npm global command folder is available for dsk.
set "PATH=%APPDATA%\npm;%PATH%"

REM ---- 2. Install dependencies. ----
echo [2/5] Installing dependencies with npm install ...
echo       This can take a while on first run.
call npm install
if errorlevel 1 goto BUILD_FAIL
echo.

REM ---- 3. Build. ----
echo [3/5] Building project with npm run build ...
call npm run build
if errorlevel 1 goto BUILD_FAIL
echo.

REM ---- 4. Register global command. ----
echo [4/5] Registering global command dsk with npm link ...
call npm link
if errorlevel 1 goto BUILD_FAIL
echo.

REM ---- 5. Configure API key. This step is optional. ----
echo [5/5] Configure DeepSeek API Key
echo       Create one at https://platform.deepseek.com.
echo       Press Enter to skip this step.
set "APIKEY="
set /p APIKEY=       Paste API Key, then press Enter: 
if not "%APIKEY%"=="" (
    call dsk config set api-key "%APIKEY%"
    echo       API Key saved.
)
echo.

echo ===============================================
echo                 Install complete
echo.
echo   Open any command window and run:
echo.
echo        dsk
echo.
echo   To change API Key later:
echo        dsk config set api-key YOUR_KEY
echo ===============================================
echo.
pause
exit /b 0

:NPM_FAIL
echo.
echo [ERROR] Node.js was found, but npm was not found.
echo         Reinstall Node.js LTS, then run this script again.
echo.
pause
exit /b 1

:NODE_FAIL
echo.
echo [ERROR] Node.js automatic install failed.
echo         This is usually a network or permission problem.
echo         Install Node.js LTS manually from https://nodejs.org.
echo         Then run this script again.
echo.
pause
exit /b 1

:BUILD_FAIL
echo.
echo [ERROR] Install failed.
echo         Check the error message above.
echo         You can run this script again after fixing the problem.
echo.
pause
exit /b 1
