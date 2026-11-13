from __future__ import annotations

import asyncio
import json
import shutil
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .config import (
    AUTH_META_FILE,
    COOKIE_FILE,
    EMOTE_CACHE_DIR,
    SHARED_STYLES_FILE,
    ensure_dirs,
    load_presets,
    load_settings,
    save_custom_presets,
    save_settings,
)
from .ffmpeg_tools import download_ffmpeg, ensure_ffmpeg_in_path, probe_encoders
from .fonts import resolve_typeface_file, scan_system_fonts
from .models import (
    AppSettings,
    AuthStatus,
    CommentStyleConfig,
    EncoderProbeResult,
    JobCreateRequest,
    Preset,
    PresetCreate,
    QueueJob,
    SharedStyleCreate,
    SharedStyleEntry,
    StyleUrlImportRequest,
    SystemFontInfo,
    ToolUpdateStatus,
    VideoInfoResponse,
    VideoProbeRequest,
)
from .queue_manager import QueueManager
from .tool_updater import tool_updater
from .ytdlp_service import probe_video_info

queue_manager = QueueManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()
    ensure_ffmpeg_in_path()
    loop = asyncio.get_running_loop()
    queue_manager.start(loop)
    tool_updater.set_emitter(queue_manager.broadcast)
    # Run background auto-check for yt-dlp / FFmpeg / JS runtime without blocking startup
    loop.create_task(tool_updater.run_check_and_update(force_even_if_disabled=False))
    yield


app = FastAPI(title="NicoTube Studio API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class CookiesImportPayload(BaseModel):
    netscape_text: str
    source: str = "builtin_browser"


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/settings", response_model=AppSettings)
async def get_settings() -> AppSettings:
    return load_settings()


@app.put("/api/settings", response_model=AppSettings)
async def update_settings(payload: AppSettings) -> AppSettings:
    return save_settings(payload)


@app.get("/api/presets", response_model=list[Preset])
async def get_presets() -> list[Preset]:
    return load_presets()


@app.post("/api/presets", response_model=Preset)
async def create_preset(payload: PresetCreate) -> Preset:
    presets = load_presets()
    new_preset = Preset(
        id=f"custom-{uuid.uuid4().hex[:8]}",
        name=payload.name.strip() or "カスタムプリセット",
        description=payload.description.strip(),
        is_builtin=False,
        config=payload.config,
    )
    presets.append(new_preset)
    save_custom_presets(presets)
    return new_preset


@app.put("/api/presets/{preset_id}", response_model=Preset)
async def update_preset(preset_id: str, payload: PresetCreate) -> Preset:
    presets = load_presets()
    for idx, p in enumerate(presets):
        if p.id == preset_id:
            if p.is_builtin:
                raise HTTPException(status_code=400, detail="ビルトインプリセットは上書きできません")
            updated = Preset(
                id=preset_id,
                name=payload.name.strip() or p.name,
                description=payload.description.strip(),
                is_builtin=False,
                config=payload.config,
            )
            presets[idx] = updated
            save_custom_presets(presets)
            return updated
    raise HTTPException(status_code=404, detail="プリセットが見つかりません")


@app.delete("/api/presets/{preset_id}")
async def delete_preset(preset_id: str) -> dict[str, bool]:
    presets = load_presets()
    filtered = [p for p in presets if not (p.id == preset_id and not p.is_builtin)]
    if len(filtered) == len(presets):
        raise HTTPException(status_code=404, detail="削除可能なプリセットが見つかりません")
    save_custom_presets(filtered)
    return {"deleted": True}


@app.get("/api/fonts", response_model=list[SystemFontInfo])
async def list_fonts() -> list[dict]:
    return await asyncio.to_thread(scan_system_fonts, False)


@app.post("/api/fonts/refresh", response_model=list[SystemFontInfo])
async def refresh_fonts() -> list[dict]:
    return await asyncio.to_thread(scan_system_fonts, True)


@app.get("/api/fonts/file")
async def get_font_file(family: str) -> FileResponse:
    path = await asyncio.to_thread(resolve_typeface_file, family)
    if not path or not path.exists():
        raise HTTPException(status_code=404, detail="フォントファイルが見つかりません")
    ext = path.suffix.lower()
    media_type = "font/otf" if ext in (".otf", ".otc") else "font/ttf"
    return FileResponse(str(path), media_type=media_type)


def _load_local_shared_styles() -> list[SharedStyleEntry]:
    ensure_dirs()
    if SHARED_STYLES_FILE.exists():
        try:
            raw = json.loads(SHARED_STYLES_FILE.read_text(encoding="utf-8"))
            return [SharedStyleEntry(**item) for item in raw]
        except Exception:
            pass
    return []


def _save_local_shared_styles(items: list[SharedStyleEntry]) -> None:
    ensure_dirs()
    SHARED_STYLES_FILE.write_text(
        json.dumps([i.model_dump() for i in items], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


@app.get("/api/styles/shared", response_model=list[SharedStyleEntry])
async def list_shared_styles() -> list[SharedStyleEntry]:
    local_items = _load_local_shared_styles()
    settings = load_settings()
    remote_base = (settings.style_server_url or "").strip().rstrip("/")
    if not remote_base:
        return local_items
    try:
        endpoint = remote_base if remote_base.endswith(".json") else f"{remote_base}/styles"
        async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
            resp = await client.get(endpoint)
            if resp.status_code == 200:
                raw = resp.json()
                if isinstance(raw, list):
                    remote_items = [SharedStyleEntry(**x) for x in raw]
                    seen = {i.id for i in remote_items}
                    return [*remote_items, *(x for x in local_items if x.id not in seen)]
    except Exception:
        pass
    return local_items


@app.post("/api/styles/shared", response_model=SharedStyleEntry)
async def publish_shared_style(payload: SharedStyleCreate) -> SharedStyleEntry:
    entry = SharedStyleEntry(
        id=f"share-{uuid.uuid4().hex[:10]}",
        name=payload.name.strip() or "共有コメントスタイル",
        author=payload.author.strip() or "Anonymous",
        description=payload.description.strip(),
        created_at=time.time(),
        config=payload.config,
    )
    items = _load_local_shared_styles()
    items.insert(0, entry)
    _save_local_shared_styles(items)

    settings = load_settings()
    remote_base = (settings.style_server_url or "").strip().rstrip("/")
    if remote_base and not remote_base.endswith(".json"):
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
                await client.post(f"{remote_base}/styles", json=payload.model_dump())
        except Exception:
            pass
    return entry


@app.delete("/api/styles/shared/{style_id}")
async def delete_shared_style(style_id: str) -> dict[str, bool]:
    items = _load_local_shared_styles()
    filtered = [i for i in items if i.id != style_id]
    if len(filtered) == len(items):
        raise HTTPException(status_code=404, detail="共有スタイルが見つかりません")
    _save_local_shared_styles(filtered)
    return {"deleted": True}


@app.post("/api/styles/import-url", response_model=SharedStyleCreate)
async def import_style_from_url(payload: StyleUrlImportRequest) -> SharedStyleCreate:
    url = payload.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="http:// または https:// のURLを指定してください")
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=12.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"URLからの読込に失敗しました: {exc}") from exc

    if isinstance(data, dict) and "config" in data:
        return SharedStyleCreate(
            name=str(data.get("name") or "インポートスタイル"),
            author=str(data.get("author") or "URL Import"),
            description=str(data.get("description") or url),
            config=CommentStyleConfig(**data["config"]),
        )
    if isinstance(data, dict):
        return SharedStyleCreate(
            name="インポートスタイル",
            author="URL Import",
            description=url,
            config=CommentStyleConfig(**data),
        )
    raise HTTPException(status_code=400, detail="有効なスタイルJSON形式ではありません")


@app.get("/api/encoders", response_model=EncoderProbeResult)
async def get_encoders(refresh: bool = False) -> EncoderProbeResult:
    return await asyncio.to_thread(probe_encoders, refresh)


@app.post("/api/tools/install-ffmpeg", response_model=EncoderProbeResult)
async def install_ffmpeg() -> EncoderProbeResult:
    def prog(pct: float, label: str) -> None:
        queue_manager._emit_sync("tool_progress", {"tool": "ffmpeg", "progress": pct, "label": label})

    return await download_ffmpeg(prog)


@app.get("/api/updates/status", response_model=ToolUpdateStatus)
async def get_tool_update_status() -> ToolUpdateStatus:
    return tool_updater.status


@app.post("/api/updates/check", response_model=ToolUpdateStatus)
async def check_tool_updates() -> ToolUpdateStatus:
    return await tool_updater.run_check_and_update(force_even_if_disabled=True)


@app.post("/api/probe", response_model=VideoInfoResponse)
async def probe_url(payload: VideoProbeRequest) -> VideoInfoResponse:
    url = payload.url.strip()
    if not url:
        raise HTTPException(status_code=400, detail="URLを入力してください")
    try:
        return await asyncio.to_thread(probe_video_info, url)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"解析エラー: {exc}") from exc


@app.get("/api/auth/status", response_model=AuthStatus)
async def get_auth_status() -> AuthStatus:
    if not COOKIE_FILE.exists():
        return AuthStatus(logged_in=False, source="none")
    lines = [
        ln for ln in COOKIE_FILE.read_text(encoding="utf-8", errors="ignore").splitlines()
        if ln.strip() and not ln.startswith("#")
    ]
    has_yt_auth = any(
        any(tok in ln for tok in ("SAPISID", "__Secure-3PSID", "LOGIN_INFO"))
        for ln in lines
    )
    source = "imported_file"
    if AUTH_META_FILE.exists():
        try:
            meta = json.loads(AUTH_META_FILE.read_text(encoding="utf-8"))
            source = meta.get("source", source)
        except Exception:
            pass
    return AuthStatus(
        logged_in=len(lines) > 0 and has_yt_auth,
        source=source if lines else "none",
        cookie_count=len(lines),
        has_youtube_auth=has_yt_auth,
        cookie_path=str(COOKIE_FILE) if lines else None,
    )


@app.post("/api/auth/cookies", response_model=AuthStatus)
async def save_cookies_text(payload: CookiesImportPayload) -> AuthStatus:
    ensure_dirs()
    COOKIE_FILE.write_text(payload.netscape_text, encoding="utf-8")
    AUTH_META_FILE.write_text(json.dumps({"source": payload.source}), encoding="utf-8")
    return await get_auth_status()


@app.post("/api/auth/upload-cookies", response_model=AuthStatus)
async def upload_cookies_file(file: UploadFile = File(...)) -> AuthStatus:
    ensure_dirs()
    raw = (await file.read()).decode("utf-8", errors="ignore")
    COOKIE_FILE.write_text(raw, encoding="utf-8")
    AUTH_META_FILE.write_text(json.dumps({"source": "imported_file"}), encoding="utf-8")
    return await get_auth_status()


@app.delete("/api/auth/cookies", response_model=AuthStatus)
async def clear_cookies() -> AuthStatus:
    COOKIE_FILE.unlink(missing_ok=True)
    AUTH_META_FILE.unlink(missing_ok=True)
    return await get_auth_status()


@app.delete("/api/cache/emotes")
async def clear_emote_cache() -> dict[str, Any]:
    count = 0
    if EMOTE_CACHE_DIR.exists():
        count = sum(1 for _ in EMOTE_CACHE_DIR.iterdir())
        shutil.rmtree(EMOTE_CACHE_DIR, ignore_errors=True)
        EMOTE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return {"cleared": count}


@app.get("/api/queue", response_model=list[QueueJob])
async def list_queue() -> list[QueueJob]:
    return queue_manager.list_jobs()


@app.post("/api/queue", response_model=QueueJob)
async def add_to_queue(payload: JobCreateRequest) -> QueueJob:
    return await queue_manager.enqueue(payload)


@app.post("/api/queue/{job_id}/cancel")
async def cancel_queue_job(job_id: str) -> QueueJob:
    job = await queue_manager.cancel_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="ジョブが見つかりません")
    return job


@app.post("/api/queue/{job_id}/retry")
async def retry_queue_job(job_id: str) -> QueueJob:
    job = await queue_manager.retry_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="ジョブが見つかりません")
    return job


@app.delete("/api/queue/{job_id}")
async def delete_queue_job(job_id: str) -> dict[str, bool]:
    ok = await queue_manager.remove_job(job_id)
    if not ok:
        raise HTTPException(status_code=404, detail="ジョブが見つかりません")
    return {"deleted": True}


@app.post("/api/queue/clear")
async def clear_finished_jobs() -> dict[str, bool]:
    await queue_manager.clear_finished()
    return {"cleared": True}


@app.websocket("/ws/events")
async def ws_events(websocket: WebSocket) -> None:
    await websocket.accept()

    async def send_msg(msg: dict[str, Any]) -> None:
        await websocket.send_json(msg)

    queue_manager.add_listener(send_msg)
    try:
        await websocket.send_json(
            {"type": "queue_snapshot", "payload": [j.model_dump() for j in queue_manager.list_jobs()]}
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        queue_manager.remove_listener(send_msg)
