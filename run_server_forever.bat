@echo off
setlocal
cd /d "%~dp0"
title NexusCrypto Stable Server

if not exist logs mkdir logs

echo.
echo NexusCrypto stable mode started.
echo URL: http://127.0.0.1:8000/
echo This window must stay open.
echo.

:loop
echo [%date% %time%] Running migrations...
python manage.py migrate >> logs\server_forever.log 2>&1
if errorlevel 1 (
  echo [%date% %time%] Migration failed. Retrying in 10 seconds...
  timeout /t 10 /nobreak >nul
  goto loop
)

echo [%date% %time%] Starting Django server... >> logs\server_forever.log
python manage.py runserver 127.0.0.1:8000 --noreload >> logs\server_forever.log 2>&1
echo [%date% %time%] Server stopped unexpectedly. Restarting in 3 seconds... >> logs\server_forever.log
timeout /t 3 /nobreak >nul
goto loop
