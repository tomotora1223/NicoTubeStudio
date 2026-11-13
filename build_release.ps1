$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host "[1/4] Generating app icon..."
& "$Root\backend\.venv\Scripts\python.exe" "$Root\build\generate_icon.py"

Write-Host "[2/4] Freezing Python backend with PyInstaller..."
Set-Location "$Root\backend"
& "$Root\backend\.venv\Scripts\pyinstaller.exe" `
    --noconfirm `
    --clean `
    --onedir `
    --name nicotube-backend `
    --collect-submodules yt_dlp `
    --collect-all skia `
    --hidden-import uvicorn.logging `
    --hidden-import uvicorn.loops `
    --hidden-import uvicorn.loops.auto `
    --hidden-import uvicorn.protocols `
    --hidden-import uvicorn.protocols.http `
    --hidden-import uvicorn.protocols.http.auto `
    --hidden-import uvicorn.protocols.websockets `
    --hidden-import uvicorn.protocols.websockets.auto `
    --hidden-import uvicorn.lifespan `
    --hidden-import uvicorn.lifespan.on `
    run_backend.py

Write-Host "[3/4] Building React UI & Electron distributables..."
Set-Location $Root
npm run dist:win

Write-Host "[4/4] Done! Distributables are in $Root\dist"
