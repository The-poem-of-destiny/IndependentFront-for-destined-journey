@echo off
chcp 65001 >nul
:: ===================================================
:: Portable launcher (Windows zip build).
:: Layout next to this file: runtime\node.exe, app\server.mjs, app\web\
:: server.mjs serves the game on a fixed local origin, opens the default
:: browser itself, and exits 0 if a copy is already running.
::
:: KEEP THIS WHOLE FILE PURE ASCII, comments AND echo text.
:: chcp 65001 makes cmd.exe misparse multi-byte text; a smoke run of an
:: earlier draft showed Chinese echo fragments executed as commands.
:: User-facing Chinese help lives in the readme shipped next to this file.
:: See docs/reference/dev-bat-notes.md.
:: Rules: CRLF line endings, no cd (UNC-safe, use %~dp0 paths),
:: goto-style flow with no parenthesized blocks; never kill processes
:: and never sleep via the timeout command (breaks with redirected stdin).
:: ===================================================
title Game Server - keep this window open

if not exist "%~dp0runtime\node.exe" goto :missing_runtime

"%~dp0runtime\node.exe" "%~dp0app\server.mjs" %*
set "EXIT_CODE=%errorlevel%"
if errorlevel 1 pause
exit /b %EXIT_CODE%

:missing_runtime
echo.
echo [ERROR] runtime\node.exe was not found next to Start.bat.
echo Please fully extract the whole zip into a folder first,
echo then double-click Start.bat inside the extracted folder.
echo Do not run it from inside the zip viewer.
echo.
pause
exit /b 1
