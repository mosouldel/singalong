@echo off
chcp 65001 >nul
setlocal
set "GIT=git"
where git >nul 2>nul
if errorlevel 1 set "GIT=E:\Git\cmd\git.exe"

cd /d "%~dp0"

echo.
echo ================================================
echo   我会唱 · 一键上传到 GitHub（云端自动打包 APK）
echo ================================================
echo.
echo   第 1 步：浏览器打开 github.com 登录，点右上角 + 号
echo           选 New repository，仓库名填 singalong，点 Create。
echo   第 2 步：复制仓库地址，例如：
echo            https://github.com/你的用户名/singalong.git
echo.
set /p REPO=   把仓库地址粘贴到这里后按回车: 

if "%REPO%"=="" (
  echo.
  echo   未输入地址，已退出。
  pause
  exit /b 1
)

"%GIT%" init >nul 2>nul
"%GIT%" config user.name "singalong" >nul 2>nul
"%GIT%" config user.email "singalong@local" >nul 2>nul
"%GIT%" add . >nul 2>nul
"%GIT%" commit -m "first commit" >nul 2>nul
"%GIT%" branch -M main
"%GIT%" remote remove origin >nul 2>nul
"%GIT%" remote add origin "%REPO%"

echo.
echo   正在上传，第一次会让你登录 GitHub（账号/密码或浏览器授权）...
echo.
"%GIT%" push -u origin main

if %errorlevel%==0 (
  echo.
  echo   ！！！上传成功！！！
  echo   现在去浏览器打开你的仓库页面：
  echo     1) 点顶部 Actions 标签
  echo     2) 左侧点 Build Android APK，右侧点 Run workflow
  echo     3) 等 3-6 分钟，点进这次运行，最下面下载 singalong-debug-apk
  echo     4) 解压后把 app-debug.apk 发到手机安装即可
) else (
  echo.
  echo   上传失败，请把上面的英文红字报错发给我，我来处理。
)
echo.
pause