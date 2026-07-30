@echo off
chcp 65001 >nul
:: ===================================================
:: Dev launcher (Fated Poem independent frontend).
:: Usage: npm run dev   (or double-click dev.bat)
:: - kills stale Vite listeners on ports 5173-5179
:: - starts Vite on the fixed port 5173
::
:: KEEP EVERY COMMENT IN THIS FILE PURE ASCII.
:: `chcp 65001` desyncs cmd.exe's byte-offset batch parser against
:: multi-byte text, which makes comment fragments run as commands
:: (a previous revision really did execute netstat/findstr out of a
:: comment, next to a live `taskkill /F`).
:: Full Chinese rationale: docs/reference/dev-bat-notes.md
:: ===================================================

echo.
echo ==============================
echo   命定之诗 开发启动器
echo ==============================
echo.

:: Kill leftover listeners on the dev port range.
:: Three details are load-bearing -- read docs/reference/dev-bat-notes.md
:: before touching the netstat/findstr pipeline:
::   1. Do NOT hardcode 127.0.0.1. Vite listens on the IPv6 loopback
::      [::1]:5173 by default on Windows, so an IPv4-only match kills
::      nothing and --strictPort then aborts on the still-busy port.
::   2. Filter LISTENING first, then match the port. Listening rows always
::      carry 0.0.0.0:0 / [::]:0 as the foreign address, so this cannot
::      hit an ESTABLISHED/TIME_WAIT row whose remote port happens to match.
::   3. The trailing space after the port number only works together with
::      /C: -- without /C: findstr splits the argument into a
::      space-separated pattern list, the trailing space is dropped, and
::      the bare substring ":5173" then also matches :51730 .. :51799,
::      which taskkill /F would happily kill.
for %%P in (5173,5174,5175,5176,5177,5178,5179) do (
    for /f "tokens=5" %%A in ('netstat -ano 2^>nul ^| findstr "LISTENING" ^| findstr /C:":%%P "') do (
        echo [clean] 杀掉端口 %%P 上的进程 PID=%%A ...
        taskkill /PID %%A /F >nul 2>&1
    )
)

:: Give taskkill a moment to land. Do NOT use `timeout /t` -- it aborts with
:: "Input redirection is not supported" whenever stdin is redirected
:: (npm run dev, CI, any piped invocation). ping loopback is the equivalent.
ping -n 2 127.0.0.1 >nul

echo [dev] 启动 Vite: http://localhost:5173/
echo.
call npx vite --port 5173 --strictPort
