@echo off
cd /d D:\DISCORD\bullyland-bot
echo Installing/verifying dependencies...
call npm install --silent
echo Starting Bullyland Bot...
:loop
node bot.js
echo.
echo [!] Bot stopped. Restarting in 5 seconds... (Ctrl+C to quit)
timeout /t 5 /nobreak >nul
goto loop
