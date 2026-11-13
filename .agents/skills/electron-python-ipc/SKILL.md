---
name: electron-python-ipc
description: Architecture for Electron desktop shell + Python FastAPI local backend, process lifecycle management, WebSocket job progress, and built-in BrowserWindow Google/YouTube authentication.
---

# Electron + Python FastAPI Desktop Integration

## 1. Process & Lifecycle Architecture

- Electron Main Process spawns the Python backend (`backend/.venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port <port>`).
- Pass dynamic free port via environment variable `NICOTUBE_PORT` (or fixed fallback in dev) and wait for `GET /api/health` readiness before rendering main window or showing loading state.
- On Electron `will-quit` / `window-all-closed`, send graceful termination (`SIGTERM` / `taskkill /T /F` on Windows) so no orphaned `python.exe` or `ffmpeg.exe` processes remain.

## 2. Built-in Google / YouTube Login (Plan 2)

- Open a dedicated Electron `BrowserWindow` using a persistent session partition (`partition: 'persist:yt_auth'`).
- Navigate to `https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/`.
- Configure clean Chromium headers/preferences (`userAgent` stripped of `Electron/` token) so Google Auth accepts the session cleanly.
- Detect login completion (navigating onto `youtube.com` with `SID`/`SAPISID`/`__Secure-3PSID` cookies present) or user clicking "Save Session & Close".
- Extract all cookies via `session.fromPartition('persist:yt_auth').cookies.get({})` and serialize to standard **Netscape HTTP Cookie File** (`cookies.txt`) inside app data (`backend/data/cookies.txt`).
- Also support importing an external `cookies.txt` file and clearing/logging out of the session cleanly.

## 3. Real-Time IPC & Job Queue

- REST API (`http://127.0.0.1:<port>/api/...`) for metadata probing, presets CRUD, settings, auth status, encoder probing, and queue operations (`add`, `cancel`, `retry`, `remove`, `clear_done`).
- WebSocket (`ws://127.0.0.1:<port>/ws/events`) broadcasts live queue state, download percentage, emote caching progress, FFmpeg encoding FPS/ETA, and tool installation progress.
- Electron `ipcMain` exposes native Windows dialogs (`dialog.showOpenDialog` for folder/cookies.txt selection, `shell.openPath` to open output folder or play finished video).
