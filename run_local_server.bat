@echo off
cd /d "%~dp0"
title NexusCrypto Local Server
echo Starting NexusCrypto on http://127.0.0.1:8000/
python manage.py migrate
if errorlevel 1 (
  echo.
  echo Migration failed. Press any key to close.
  pause >nul
  exit /b 1
)
echo.
python manage.py runserver 127.0.0.1:8000 --noreload
echo.
echo Server stopped. Press any key to close.
pause >nul
