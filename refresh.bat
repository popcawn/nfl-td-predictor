@echo off
REM ---------------------------------------------------------------------------
REM Local rebuild of the NFL anytime-TD snapshot (works from wherever the repo is cloned).
REM You usually don't need this: GitHub Actions rebuilds the data every Tuesday + Friday and
REM the app refreshes lines / injuries / weather live. Use it after changing the model code.
REM ---------------------------------------------------------------------------
cd /d "%~dp0"
echo ================ %DATE% %TIME% ================ >> refresh.log
git pull --ff-only >> refresh.log 2>&1
node --max-old-space-size=4096 build-nfl-td-snapshot.mjs >> refresh.log 2>&1
echo exit code %ERRORLEVEL% >> refresh.log
