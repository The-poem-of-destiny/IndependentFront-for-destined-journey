@echo off
chcp 65001 >nul
:: ===================================================
:: Auto-update (Fated Poem independent frontend).
:: Usage: double-click update.bat
:: - pulls latest code from remote (fast-forward only)
:: - runs npm install if package files changed
:: - reminds you to restart dev.bat
::
:: KEEP EVERY COMMENT IN THIS FILE PURE ASCII.
:: `chcp 65001` desyncs cmd.exe's byte-offset batch parser against
:: multi-byte text, which makes comment fragments run as commands.
:: Same constraint as dev.bat -- see docs/reference/dev-bat-notes.md.
:: ===================================================

echo.
echo ==============================
echo   命定之诗 自动更新
echo ==============================
echo.

:: cd to the folder containing this .bat (so double-click works from anywhere)
cd /d "%~dp0"

:: Sanity check: must be inside a git repo (not a downloaded zip)
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
    echo [错误] 当前目录不是 git 仓库。
    echo        你可能是下载的 zip 而不是 git clone 的，没法自动更新。
    echo        请用: git clone https://github.com/The-poem-of-destiny/IndependentFront-for-destined-journey
    echo.
    pause
    exit /b 1
)

:: Record package-lock hash BEFORE pull to detect dep changes later
for /f "delims=" %%H in ('git rev-parse HEAD:package-lock.json 2^>nul') do set "LOCK_BEFORE=%%H"

echo [1/3] 拉取远程更新...
git fetch origin
if errorlevel 1 (
    echo.
    echo [错误] git fetch 失败 —— 网络不通或 GitHub 不可达。
    echo        检查你的网络 / VPN / 代理后重试。
    echo.
    pause
    exit /b 1
)

:: Fast-forward only. Fails cleanly if the user has local edits or history diverged,
:: rather than silently creating a merge commit or clobbering local changes.
git pull --ff-only
if errorlevel 1 (
    echo.
    echo [警告] 无法快进更新。
    echo        可能原因: 本地改过仓库里的文件，或远程历史分叉。
    echo        如果你没手动改过代码，可以跑这句强制对齐远程:
    echo            git reset --hard origin/master
    echo        （注意: 这会丢掉你对仓库内文件的修改；设置页的配置不受影响）
    echo.
    pause
    exit /b 1
)

:: Detect dep changes
for /f "delims=" %%H in ('git rev-parse HEAD:package-lock.json 2^>nul') do set "LOCK_AFTER=%%H"

echo.
echo [2/3] 检查依赖是否变化...
if defined LOCK_BEFORE if defined LOCK_AFTER (
    if not "%LOCK_BEFORE%"=="%LOCK_AFTER%" (
        echo       package-lock.json 变了，运行 npm install...
        call npm install
        if errorlevel 1 (
            echo [警告] npm install 失败，但代码已更新。可稍后手动 npm install。
        )
    ) else (
        echo       依赖没变，跳过 npm install。
    )
) else (
    echo       未检测到 package-lock.json，跳过。
)

echo.
echo [3/3] 完成。最近 3 条更新:
git --no-pager log --oneline -3
echo.
echo ==============================
echo   代码已更新。请关闭运行中的 dev.bat 窗口，
echo   然后重新双击 dev.bat 启动游戏。
echo ==============================
echo.
pause
