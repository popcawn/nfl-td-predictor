@echo off
REM ---------------------------------------------------------------------------
REM Weekly refresh of the NFL anytime-TD snapshot from nflverse.
REM Run manually by double-clicking, or automatically via Windows Task Scheduler.
REM It re-pulls the current season's play-by-play + rosters (so defense-vs-position
REM and every rate reflect the games played so far) and rewrites nfl-td-predictor.html.
REM ---------------------------------------------------------------------------
cd /d "C:\Users\User\nfl-td-predictor"
echo ================ %DATE% %TIME% ================ >> refresh.log
"C:\Program Files\nodejs\node.exe" --max-old-space-size=4096 build-nfl-td-snapshot.mjs >> refresh.log 2>&1
echo exit code %ERRORLEVEL% >> refresh.log
