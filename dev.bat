@echo off
chcp 65001 >nul
:: ===================================================
:: Dev launcher (narrative engine frontend).
:: Usage: npm run dev   (or double-click dev.bat)
:: - reports occupied ports without terminating other processes
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
echo   叙事引擎 开发启动器
echo ==============================
echo.

:: ------------------------------------------------------------------
:: Content-repo mode (content-engine split wave 4, D14).
:: Points /data/* reads AND the "save as default" UI write at the real
:: content repo (sibling dir ..\fated_poem_independent_assets\data)
:: instead of the public/data placeholder. This also makes the
:: "save as default" button appear (it is hidden unless the
:: __POEM_CONTENT_DIR__ define is true).
::
:: Default: AUTO-ENABLED -- if the sibling content repo exists, dev
:: starts in content mode with no extra args. Pass --no-content to
:: force placeholder mode (read-only, button hidden). --content is
:: accepted for compatibility. A pre-set POEM_CONTENT_DIR env var
:: always wins (no override).
:: --no-content wins: skip auto-detect even if the sibling repo exists.
if /i "%~1"=="--no-content" set "NO_CONTENT=1"
if /i "%~2"=="--no-content" set "NO_CONTENT=1"
if not defined POEM_CONTENT_DIR if not defined NO_CONTENT (
    if exist "%~dp0..\fated_poem_independent_assets\data" set "POEM_CONTENT_DIR=%~dp0..\fated_poem_independent_assets\data"
)
if defined POEM_CONTENT_DIR echo [dev] content repo: %POEM_CONTENT_DIR%


:: A busy port fails safely via --strictPort; never kill unknown listeners.
echo [dev] 启动 Vite: http://localhost:5173/
echo.
call npx vite --port 5173 --strictPort
