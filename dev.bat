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
::
:: 三个细节都是踩出来的，改之前先读完：
:: 1. **不写死 127.0.0.1** —— Vite 在 Windows 上默认监听的是 IPv6 回环 `[::1]:5173`，
::    只匹配 IPv4 会一个都杀不掉；接着 --strictPort 撞上占用直接退出，
::    表现就是"dev.bat 一闪就崩"。
:: 2. **先筛 LISTENING 再匹配端口** —— 监听行的外部地址恒为 0.0.0.0:0 / [::]:0，
::    所以不会误伤"远端端口恰好是 %%P"的 ESTABLISHED/TIME_WAIT 连接。
:: 3. **端口号后面那个空格是必需的** —— netstat 的本地地址列左对齐补空格，
::    没有它 ":5173" 会顺带匹配 :51730 / :51739，杀掉毫不相干的进程。
for %%P in (5173,5174,5175,5176,5177,5178,5179) do (
    for /f "tokens=5" %%A in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr ":%%P "') do (
        echo [clean] 杀掉端口 %%P 上的进程 PID=%%A ...
        taskkill /PID %%A /F >nul 2>&1
    )
)

:: 给 taskkill 一点落地时间。**不要用 `timeout /t`** —— 它在 stdin 被重定向时
:: （npm run dev、CI、任何把输出接管道的调用）会直接报
:: "ERROR: Input redirection is not supported, exiting the process immediately."
:: ping 回环是没有这个毛病的等价写法。
ping -n 2 127.0.0.1 >nul

echo [dev] 启动 Vite: http://localhost:5173/
echo.
call npx vite --port 5173 --strictPort
