@echo off
title Run Supabase and CIA Triad Tests
where node >nul 2>nul || set "PATH=C:\Windows.old\Program Files\nodejs;%PATH%"
echo ========================================================
echo   Running Supabase Backup and CIA Triad Test Suite...
echo ========================================================
node server/tests/test_supabase_backup.js
echo.
pause
