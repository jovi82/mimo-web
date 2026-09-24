@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ============================================================
rem  MiMoCode 局域网/手机网页端 启动脚本
rem  改下面这一行 = 你要打开的本地项目文件夹
rem ============================================================
set "PROJECT_DIR=G:\website\StockTrading"
rem ============================================================

set "PORT=7681"
set "HOST=0.0.0.0"

rem ---- 1. 检查项目目录 ----
if not exist "%PROJECT_DIR%" (
  echo [错误] 项目目录不存在: %PROJECT_DIR%
  echo        请修改本 bat 里的 PROJECT_DIR 后重试。
  echo.
  pause
  exit /b 1
)

rem ---- 2. 自动识别局域网 IP ----
set "LANIP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "TMPIP=%%a"
  set "TMPIP=!TMPIP: =!"
  if not "!TMPIP:~0,4!"=="127." if not "!TMPIP:~0,8!"=="169.254." (
    if "!LANIP!"=="" set "LANIP=!TMPIP!"
  )
)
if "!LANIP!"=="" set "LANIP=127.0.0.1"

rem ---- 3. 端口占用处理 ----
set "OLDPID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /c:"LISTENING" ^| findstr /c:":%PORT% "') do set "OLDPID=%%p"
if not "!OLDPID!"=="" (
  echo [提示] 端口 %PORT% 已被占用 ^(PID !OLDPID!^)，可能是上次的窗口没关。
  set /p "KILL=是否结束它以便重新启动? [Y/N]: "
  if /i "!KILL!"=="Y" (
    taskkill /f /pid !OLDPID! >nul 2>&1
    timeout /t 1 /nobreak >nul
  ) else (
    echo 已取消。
    pause
    exit /b 1
  )
)

rem ---- 4. 防火墙放行（所有网络类型）----
netsh advfirewall firewall delete rule name="MimoWebTerminal" >nul 2>&1
netsh advfirewall firewall add rule name="MimoWebTerminal" dir=in action=allow protocol=TCP localport=%PORT% profile=any >nul 2>&1
if errorlevel 1 (
  echo [警告] 添加防火墙规则失败，请用“以管理员身份运行”重试。
  echo        否则其它电脑可能打不开本机网页端。
) else (
  echo [OK] 已放行防火墙 TCP %PORT% ^(域/专用/公用^)
)

echo.
echo ============================================================
echo   MiMoCode 网页端正在启动...
echo.
echo   本机访问:    http://127.0.0.1:%PORT%
echo   局域网/手机: http://!LANIP!:%PORT%
echo.
echo   项目目录:    %PROJECT_DIR%
echo   上传目录:    %PROJECT_DIR%\uploads
echo   停止服务:    本窗口按 Ctrl+C，或直接关闭窗口
echo ============================================================
echo.
echo 浏览器将在 2 秒后自动打开 ^(本机^)...
echo.

rem ---- 5. 延迟 2 秒自动打开浏览器（后台，不阻塞服务）----
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:%PORT%'"

rem ---- 6. 启动服务（阻塞在此窗口）----
node server.js

echo.
echo [服务已退出]
pause
