$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "Starting NexusCrypto on http://127.0.0.1:8000/" -ForegroundColor Cyan
python manage.py migrate
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Migration failed." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host ""
python manage.py runserver 127.0.0.1:8000 --noreload
Write-Host ""
Read-Host "Server stopped. Press Enter to close"
