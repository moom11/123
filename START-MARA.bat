@echo off
chcp 65001 >nul
title MARA Lounge
cd /d "%~dp0"

echo.
echo   ============================================
echo      MARA Lounge - Starting
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto no_node
where npm >nul 2>nul
if errorlevel 1 goto no_node

where psql >nul 2>nul
if errorlevel 1 goto no_psql

if exist "node_modules" goto run

echo   Installing dependencies. This happens once and takes a few minutes.
echo.
call npm install
if errorlevel 1 goto install_failed

:run
echo.
echo   Starting. The browser opens by itself in a moment.
echo   Leave this window open. Close it to stop the system.
echo.
start "" http://localhost:4173
call npm start
echo.
echo   MARA has stopped.
pause
exit /b 0

:no_node
echo   [X] Node.js is not installed, or npm is missing from it.
echo.
echo       Install it from https://nodejs.org  - choose LTS -
echo       then close this window and run this file again.
echo.
pause
exit /b 1

:no_psql
echo   [X] PostgreSQL was not found on PATH.
echo.
echo       1. Install PostgreSQL 16 from postgresql.org/download
echo       2. During install, set the password to:  postgres
echo       3. Add this folder to your PATH:
echo            C:\Program Files\PostgreSQL\16\bin
echo       4. Close this window and run this file again.
echo.
pause
exit /b 1

:install_failed
echo.
echo   [X] npm install failed. Check your internet connection.
echo.
pause
exit /b 1
