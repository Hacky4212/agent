@echo off
chcp 936 >nul 2>&1
title DeepSeek CLI 一键安装
cd /d "%~dp0"

echo ===============================================
echo            DeepSeek CLI  一键安装向导
echo ===============================================
echo.
echo  本脚本会自动帮你完成：
echo    - 检查 / 安装 Node.js 运行环境
echo    - 安装项目依赖
echo    - 编译并注册全局命令  dsk
echo.
echo  过程中若弹出 "是否允许此应用更改" ，请点【是】。
echo.
pause
echo.

REM ---- 0. 确认在项目目录里 ----
if not exist "package.json" (
    echo [错误] 当前文件夹里没找到 package.json
    echo        请把本脚本放在项目文件夹里 ^(和 package.json 同一层^) 再运行。
    echo.
    pause
    exit /b 1
)

REM ---- 1. 检查 Node.js ----
echo [1/5] 检查 Node.js 运行环境 ...
where node >nul 2>&1
if %errorlevel% equ 0 goto NODE_READY

echo       未检测到 Node.js，开始自动安装（需要联网）...
echo.

where winget >nul 2>&1
if %errorlevel% neq 0 goto INSTALL_MSI

echo       正在通过 winget 安装 Node.js LTS（弹窗请点【是】）...
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
goto NODE_INSTALLED

:INSTALL_MSI
echo       winget 不可用，改为下载官方安装包 ...
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; try { $idx = Invoke-RestMethod 'https://nodejs.org/dist/index.json'; $lts = ($idx | Where-Object { $_.lts } | Select-Object -First 1).version; $arch = if([Environment]::Is64BitOperatingSystem){'x64'}else{'x86'}; $url = 'https://nodejs.org/dist/' + $lts + '/node-' + $lts + '-' + $arch + '.msi'; Write-Host ('       Node version: ' + $lts); Invoke-WebRequest $url -OutFile ($env:TEMP + '\nodejs-lts.msi') } catch { Write-Host 'download failed'; exit 1 }"
if %errorlevel% neq 0 goto NODE_FAIL
echo       正在安装（弹窗请点【是】）...
msiexec /i "%TEMP%\nodejs-lts.msi" /qb

:NODE_INSTALLED
REM 刷新当前窗口的 PATH，让本次就能用上 node / npm / 全局命令
set "PATH=%ProgramFiles%\nodejs\;%APPDATA%\npm;%PATH%"
where node >nul 2>&1
if %errorlevel% equ 0 goto NODE_READY
echo.
echo       Node.js 已安装完成，但当前窗口还认不到它。
echo       请【关闭本窗口】，然后【重新双击】本脚本，就能继续了。
echo.
pause
exit /b 0

:NODE_READY
for /f "delims=" %%v in ('node -v') do echo       Node.js 已就绪 ^(%%v^)
echo.

REM 确保全局命令目录在 PATH 中（供后面的 dsk 使用）
set "PATH=%APPDATA%\npm;%PATH%"

REM ---- 2. 安装依赖 ----
echo [2/5] 安装项目依赖 (npm install)，第一次会比较慢，请耐心等待 ...
call npm install
if %errorlevel% neq 0 goto BUILD_FAIL
echo.

REM ---- 3. 编译 ----
echo [3/5] 编译项目 (npm run build) ...
call npm run build
if %errorlevel% neq 0 goto BUILD_FAIL
echo.

REM ---- 4. 注册全局命令 ----
echo [4/5] 注册全局命令 dsk (npm link) ...
call npm link
if %errorlevel% neq 0 goto BUILD_FAIL
echo.

REM ---- 5. 配置 API Key（可选）----
echo [5/5] 配置 DeepSeek API Key
echo       去 https://platform.deepseek.com 申请，没有可直接回车跳过。
set "APIKEY="
set /p APIKEY=       请粘贴 API Key 后回车:
if not "%APIKEY%"=="" (
    call dsk config set api-key "%APIKEY%"
    echo       API Key 已保存。
)
echo.

echo ===============================================
echo                 安装完成！
echo.
echo   现在打开任意命令行窗口，输入下面这个命令即可开始：
echo.
echo        dsk
echo.
echo   以后想改 API Key:  dsk config set api-key 你的key
echo ===============================================
echo.
pause
exit /b 0

:NODE_FAIL
echo.
echo [失败] Node.js 自动安装没成功（多半是网络问题）。
echo        请手动到  https://nodejs.org  下载 LTS 版本安装，
echo        装好后重新双击本脚本即可。
echo.
pause
exit /b 1

:BUILD_FAIL
echo.
echo [失败] 安装过程中出错了（上面有报错信息）。
echo        可以把窗口截图发给朋友帮忙看看，或重新运行本脚本重试。
echo.
pause
exit /b 1
