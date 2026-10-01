@echo off
rem ======================================================================
rem  Deadlift Tracker - one-click deploy (Windows). Double-click this file.
rem  1. checks   2. shows what changed   3. asks for a short message + OK
rem  4. git commit + push to GitHub (main)   5. firebase deploy (hosting)
rem  Free plan only: deploys Hosting. Never deploys Functions or rules.
rem  One-time setup: Git installed and signed in to GitHub (git push works),
rem  Firebase CLI installed (npm install -g firebase-tools) and "firebase login".
rem ======================================================================
setlocal
cd /d "%~dp0"
title Deadlift Tracker - deploy
echo.
echo === Deadlift Tracker deploy ===
echo Folder: %CD%
echo.

where git >nul 2>nul || (echo [STOP] Git is not installed or not on PATH. & goto :fail)
where firebase >nul 2>nul || (echo [STOP] Firebase CLI not found. Install once: npm install -g firebase-tools & goto :fail)
if not exist ".git" (echo [STOP] This folder is not the git repository. & goto :fail)

set "BRANCH="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD') do set "BRANCH=%%b"
if /i not "%BRANCH%"=="main" (echo [STOP] You are on branch "%BRANCH%", expected "main". & goto :fail)

rem --- safety checks: free plan, required files, correct import route ---
if exist "functions\" (echo [STOP] The "functions" folder still exists. Delete it - this app must not use Cloud Functions. & goto :fail)
findstr /c:"\"functions\"" firebase.json >nul && (echo [STOP] firebase.json still has a "functions" section. & goto :fail)
for %%f in (index.html sw.js config\app.config.js js\app.js js\views\programImport.js js\services\trainingResetService.js js\utils\trainingReset.js) do (
  if not exist "%%f" (echo [STOP] Missing file: %%f - copy the complete package first. & goto :fail)
)
findstr /c:"'/import': 'program'" config\app.config.js >nul || (echo [STOP] config\app.config.js has the wrong /import route. & goto :fail)

echo Changes to be published:
git status --short
echo.
set "MSG="
set /p "MSG=Short description (Enter = "Update app"): "
if not defined MSG set "MSG=Update app"
echo.
set "OK="
set /p "OK=Publish to GitHub and https://deadlift-tracker-app.web.app now? (y/n): "
if /i not "%OK%"=="y" (echo Cancelled - nothing was changed. & goto :end)

echo.
echo [1/3] Saving changes (git commit)...
git add -A || goto :fail
git diff --cached --quiet
if errorlevel 1 (
  setlocal EnableDelayedExpansion
  > "%TEMP%\dt-commit-message.txt" echo(!MSG!
  endlocal
  git commit -q -F "%TEMP%\dt-commit-message.txt" || goto :fail
  del "%TEMP%\dt-commit-message.txt" >nul 2>nul
) else (
  echo       Nothing new to commit - publishing the current version.
)

echo [2/3] Uploading to GitHub (git push)...
git push origin main || goto :fail

echo [3/3] Publishing the website (firebase deploy --only hosting:production)...
call firebase deploy --only hosting:production || goto :fail

echo.
echo === DONE - live at https://deadlift-tracker-app.web.app ===
echo Open the app and accept "Update available" (or reload) to get the new version.
goto :end

:fail
echo.
echo === NOT PUBLISHED - read the message above. Nothing after the failed step was run. ===
:end
echo.
pause
endlocal
