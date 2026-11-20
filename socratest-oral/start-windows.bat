@echo off
chcp 65001 >nul
title 국어 구술 수행평가 도우미
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0runtime\node.exe" set "NODE=%~dp0runtime\node.exe"
"%NODE%" -v >nul 2>&1
if errorlevel 1 (
  echo [오류] Node.js를 찾을 수 없습니다. runtime 폴더가 있는 완전판을 받거나 https://nodejs.org 에서 Node.js를 설치하세요.
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo 처음 실행: 필요한 구성 요소를 설치합니다...
  call npm install --omit=dev
)
set OPEN_BROWSER=1
echo 잠시 후 교사 화면이 브라우저에서 열립니다. 이 창을 닫으면 프로그램이 꺼집니다.
echo Windows 방화벽 창이 뜨면 [개인 네트워크]를 체크하고 [허용]을 누르세요.
"%NODE%" server.js
pause
