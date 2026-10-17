@echo off
title Run All Security and Auth Test Suites
where node >nul 2>nul || set "PATH=C:\Windows.old\Program Files\nodejs;%PATH%"
echo ========================================================
echo   Running Complete Security and Auth Test Suites...
echo ========================================================
echo [1/3] Running Core Security, 2FA, and RBAC Tests...
node server/tests/test_flow.js
if %errorlevel% neq 0 pause && exit /b %errorlevel%

echo.
echo [2/3] Running End-to-End API Integration Tests...
node server/tests/test_api_endpoints.js
if %errorlevel% neq 0 pause && exit /b %errorlevel%

echo.
echo [3/3] Running Supabase Backup and CIA Triad Tests...
node server/tests/test_supabase_backup.js
echo.
pause
