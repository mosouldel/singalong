@echo off
setlocal
set "GIT=git"
where git >nul 2>nul
if errorlevel 1 set "GIT=E:\Git\cmd\git.exe"

cd /d "%~dp0"

"%GIT%" config --global --add safe.directory "%CD%" >nul 2>nul

echo.
echo ================================================
echo   Singalong - Upload to GitHub (build APK online)
echo ================================================
echo.
echo   Step 1: open github.com, create a NEW empty repo named singalong.
echo   Step 2: copy its URL, for example:
echo           https://github.com/YOURNAME/singalong
echo.
set /p REPO=Paste the repo URL and press Enter: 

if "%REPO%"=="" (
  echo.
  echo   No URL entered. Exiting.
  pause
  exit /b 1
)

set "REPO=%REPO:github.com/=mosouldel@github.com/%"

"%GIT%" init >nul 2>nul
"%GIT%" config user.name "singalong" >nul 2>nul
"%GIT%" config user.email "singalong@local" >nul 2>nul
"%GIT%" add . >nul 2>nul
"%GIT%" commit -m "first commit" >nul 2>nul
"%GIT%" branch -M main
"%GIT%" remote remove origin >nul 2>nul
"%GIT%" remote add origin "%REPO%"

echo.
echo   Username is set automatically (mosouldel).
echo   When asked for PASSWORD, paste your Personal Access Token.
echo   The token will NOT be visible while typing - that is normal.
echo.
"%GIT%" -c credential.helper= push -u origin main

if %errorlevel%==0 (
  echo.
  echo   UPLOAD OK.
  echo   Next: open your repo on github.com - Actions tab.
  echo   Click Build Android APK, wait a few minutes,
  echo   then download singalong-debug-apk from the Artifacts section.
) else (
  echo.
  echo   Upload failed. Please send me the red error text above.
)
echo.
pause