@echo off
setlocal
title Companion Desktop
echo Opening Companion desktop...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-desktop.ps1"
if errorlevel 1 (
  echo.
  echo Companion desktop could not open. Read the message above.
  pause
  exit /b 1
)
