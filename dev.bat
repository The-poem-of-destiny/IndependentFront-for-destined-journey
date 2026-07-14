@echo off
chcp 65001 >nul
:: ===================================================
:: 命定之诗 开发启动器
:: 用法: npm run dev  或  双击 dev.bat
:: - 自动杀掉旧 Vite 进程（端口 5173-5179）
:: - 固定端口 5173 启动
:: ===================================================

echo.
echo ==============================
echo   命定之诗 开发启动器
echo ==============================
echo.

:: 杀掉旧端口上的残留进程
for %%P in (5173,5174,5175,5176,5177,5178,5179) do (
    for /f "tokens=5" %%A in ('netstat -ano 2^>nul ^| findstr "127.0.0.1:%%P" ^| findstr "LISTENING"') do (
        echo [clean] 杀掉端口 %%P 上的进程 PID=%%A ...
        taskkill /PID %%A /F >nul 2>&1
    )
)

timeout /t 1 /nobreak >nul

echo [dev] 启动 Vite: http://localhost:5173/
echo.
call npx vite --port 5173 --strictPort
