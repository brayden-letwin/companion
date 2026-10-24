@echo off
setlocal
title Companion
echo Opening Companion...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-shared.ps1"
if errorlevel 1 (
  echo.
  echo Companion could not open. Read the message above, or see START_HERE.txt.
  pause
  exit /b 1
)
