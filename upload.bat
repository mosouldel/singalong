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
echo   Repo:     https://github.com/mosouldel/singalong
echo   Username: mosouldel
echo.
echo   Paste your Personal Access Token and press Enter.
echo   (The token is shown on screen so you can check it is complete.)
echo.
set /p TOKEN=Token: 

if "%TOKEN%"=="" (
  echo.
  echo   No token entered. Exiting.
  pause
  exit /b 1
)

"%GIT%" init >nul 2>nul
"%GIT%" config user.name "singalong" >nul 2>nul
"%GIT%" config user.email "singalong@local" >nul 2>nul
"%GIT%" add . >nul 2>nul
"%GIT%" commit -m "first commit" >nul 2>nul
"%GIT%" branch -M main

echo.
echo   Uploading...
set "GIT_TERMINAL_PROMPT=0"
"%GIT%" -c credential.helper= push "https://mosouldel:%TOKEN%@github.com/mosouldel/singalong.git" main

if %errorlevel%==0 (
  echo.
  echo   UPLOAD OK.
  echo   Next: open https://github.com/mosouldel/singalong - Actions tab.
  echo   Click Build Android APK, wait, then download the APK.
) else (
  echo.
  echo   Upload failed. Please send me the red error text above.
)
echo.
pause
