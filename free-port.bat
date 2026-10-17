@echo off
title Free Port 3000
echo Finding and terminating any existing process listening on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    taskkill /f /pid %%a >nul 2>&1
    echo Terminated process with PID %%a
)
echo.
echo Port 3000 is now free! You can now start the server with start.bat or start-http.bat.
pause
