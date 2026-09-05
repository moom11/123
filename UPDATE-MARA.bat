@echo off
chcp 65001 >nul
title MARA Lounge - Update
cd /d "%~dp0"

echo.
echo   ============================================
echo      MARA Lounge - Getting the latest changes
echo   ============================================
echo.

where git >nul 2>nul
if errorlevel 1 goto no_git

if not exist ".git" goto not_a_clone

echo   Fetching...
call git pull --ff-only
if errorlevel 1 goto pull_failed

echo.
echo   Updating dependencies...
call npm install
if errorlevel 1 goto install_failed

echo.
echo   Up to date. Run START-MARA.bat to start the system.
echo.
pause
exit /b 0

:no_git
echo   [X] Git is not installed.
echo.
echo       Install it from https://git-scm.com/download/win
echo       then run this file again.
echo.
pause
exit /b 1

:not_a_clone
echo   [X] This folder is not connected to the repository.
echo.
echo       It looks like it came from a zip file. To get updates,
echo       clone it instead - once - into a new folder:
echo.
echo         git clone -b claude/mara-lounge-management-system-tlrc2b https://github.com/moom11/123.git mara
echo         cd mara
echo         npm install
echo.
echo       After that, this file will work.
echo.
pause
exit /b 1

:pull_failed
echo.
echo   [X] Could not pull. If you have edited files here, your changes
echo       conflict with the new ones. Copy your edits aside, then run:
echo         git reset --hard origin/claude/mara-lounge-management-system-tlrc2b
echo.
pause
exit /b 1

:install_failed
echo.
echo   [X] npm install failed. Check your internet connection.
echo.
pause
exit /b 1
