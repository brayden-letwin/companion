@echo off
setlocal
title Stop Companion
echo Stopping Companion service...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-shared.ps1"
if errorlevel 1 (
  echo.
  echo Companion shutdown could not be confirmed. Read the message above before restarting.
  pause
  exit /b 1
)
