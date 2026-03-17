if (-not (Test-Path ".env.local")) {
  Write-Host "Falta .env.local. Copia .env.example y completa las credenciales." -ForegroundColor Yellow
  exit 1
}

npm run dev
