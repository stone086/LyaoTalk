@echo off
cd /d %~dp0
echo Installing web dependencies...
call npm run install:web
echo Starting LyaoTalk 2.0 web (apps/web)...
call npm run dev
pause
