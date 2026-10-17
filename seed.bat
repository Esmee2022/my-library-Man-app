@echo off
title Seed Initial Administrator
where node >nul 2>nul || set "PATH=C:\Windows.old\Program Files\nodejs;%PATH%"
echo ========================================================
echo   Seeding Initial Administrator Account...
echo ========================================================
cd /d "%~dp0\server"
node scripts/seed.js
echo.
pause
