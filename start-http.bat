@echo off
title Secure Auth Server (HTTP Mode)
where node >nul 2>nul || set "PATH=C:\Windows.old\Program Files\nodejs;%PATH%"
echo ========================================================
echo   Starting Secure Auth Server over HTTP (No SSL warnings)...
echo ========================================================
cd /d "%~dp0\server"
node server.js --http
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Server encountered an issue starting up.
    echo If port 3000 is occupied, double-click free-port.bat or change PORT in server\.env
    pause
)
