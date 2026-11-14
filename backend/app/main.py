from __future__ import annotations

import asyncio
import base64
import json
import re
import shutil
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import FastAPI, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from .config import (
    AUTH_META_FILE,
    BASE_DIR,
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
    GithubStyleShareResult,
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


DEFAULT_GITHUB_STYLES_URL = (
    "https://raw.githubusercontent.com/tomotora1223/NicoTubeStudio/main/community-styles/index.json"
)
_COMMUNITY_CACHE: dict[str, Any] = {"ts": 0.0, "items": []}


def _parse_style_list(raw: Any, default_source: str = "github") -> list[SharedStyleEntry]:
    out: list[SharedStyleEntry] = []
    if not isinstance(raw, list):
        return out
    for idx, x in enumerate(raw):
        if not isinstance(x, dict):
            continue
        try:
            cfg_raw = x.get("config") if "config" in x else x
            entry = SharedStyleEntry(
                id=str(x.get("id") or f"{default_source}-{idx}"),
                name=str(x.get("name") or "共有スタイル"),
                author=str(x.get("author") or "Community"),
                description=str(x.get("description") or ""),
                tags=[str(t) for t in (x.get("tags") or []) if t],
                source=str(x.get("source") or default_source),
                url=x.get("url"),
                created_at=float(x.get("created_at") or time.time()),
                config=CommentStyleConfig(**cfg_raw),
            )
            out.append(entry)
        except Exception:
            continue
    return out


def _load_bundled_community_styles() -> list[SharedStyleEntry]:
    candidates = [
        Path(getattr(sys, "_MEIPASS", BASE_DIR)) / "community-styles" / "index.json",
        BASE_DIR.parent / "community-styles" / "index.json",
        BASE_DIR / "community-styles" / "index.json",
    ]
    for p in candidates:
        if p.exists():
            try:
                raw = json.loads(p.read_text(encoding="utf-8"))
                parsed = _parse_style_list(raw, default_source="github")
                if parsed:
                    return parsed
            except Exception:
                pass
    return []


@app.get("/api/styles/community", response_model=list[SharedStyleEntry])
async def list_community_styles(refresh: bool = False) -> list[SharedStyleEntry]:
    now = time.monotonic()
    github_items: list[SharedStyleEntry] = []
    if not refresh and _COMMUNITY_CACHE["items"] and (now - _COMMUNITY_CACHE["ts"] < 180):
        github_items = list(_COMMUNITY_CACHE["items"])
    else:
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
                resp = await client.get(DEFAULT_GITHUB_STYLES_URL)
                if resp.status_code == 200:
                    parsed = _parse_style_list(resp.json(), default_source="github")
                    if parsed:
                        github_items = parsed
                        _COMMUNITY_CACHE["ts"] = now
                        _COMMUNITY_CACHE["items"] = parsed
        except Exception:
            pass
    if not github_items:
        github_items = _load_bundled_community_styles()

    remote_items: list[SharedStyleEntry] = []
    settings = load_settings()
    remote_base = (settings.style_server_url or "").strip().rstrip("/")
    if remote_base:
        try:
            endpoint = remote_base if remote_base.endswith(".json") else f"{remote_base}/styles"
            async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
                resp = await client.get(endpoint)
                if resp.status_code == 200:
                    remote_items = _parse_style_list(resp.json(), default_source="relay")
        except Exception:
            pass

    local_items = _load_local_shared_styles()
    seen: set[str] = set()
    merged: list[SharedStyleEntry] = []
    for it in [*remote_items, *github_items, *local_items]:
        if it.id not in seen:
            seen.add(it.id)
            merged.append(it)
    return merged


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
                remote_items = _parse_style_list(resp.json(), default_source="relay")
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
        tags=[t.strip() for t in payload.tags if t.strip()][:6],
        source="local",
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


@app.post("/api/styles/share-github", response_model=GithubStyleShareResult)
async def share_style_to_github(payload: SharedStyleCreate) -> GithubStyleShareResult:
    settings = load_settings()
    entry = SharedStyleEntry(
        id=f"share-{uuid.uuid4().hex[:10]}",
        name=payload.name.strip() or "共有コメントスタイル",
        author=payload.author.strip() or settings.style_author_name.strip() or "Anonymous",
        description=payload.description.strip(),
        tags=[t.strip() for t in payload.tags if t.strip()][:6],
        source="github",
        created_at=time.time(),
        config=payload.config,
    )
    style_doc = {
        "id": entry.id,
        "name": entry.name,
        "author": entry.author,
        "description": entry.description,
        "tags": entry.tags,
        "created_at": int(entry.created_at),
        "config": entry.config.model_dump(),
    }
    json_body = json.dumps(style_doc, ensure_ascii=False, indent=2)

    # Also store locally & push to custom relay if configured
    items = _load_local_shared_styles()
    items.insert(0, entry)
    _save_local_shared_styles(items)
    remote_base = (settings.style_server_url or "").strip().rstrip("/")
    if remote_base and not remote_base.endswith(".json"):
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=8.0) as client:
                await client.post(f"{remote_base}/styles", json=payload.model_dump())
        except Exception:
            pass

    token = (settings.github_style_token or "").strip()
    if token:
        try:
            async with httpx.AsyncClient(follow_redirects=True, timeout=12.0) as client:
                resp = await client.post(
                    "https://api.github.com/gists",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Accept": "application/vnd.github+json",
                    },
                    json={
                        "description": f"NicoTube Studio Comment Style: {entry.name} by {entry.author}",
                        "public": True,
                        "files": {
                            f"{entry.id}.nicostyle.json": {"content": json_body},
                        },
                    },
                )
                resp.raise_for_status()
                gist_data = resp.json()
                gist_url = str(gist_data.get("html_url") or "")
                entry.url = gist_url
                return GithubStyleShareResult(method="gist", url=gist_url, entry=entry)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"GitHub Gist公開エラー: {exc}") from exc

    issue_title = f"[Style] {entry.name}"
    issue_body = (
        f"### コメントスタイル共有リクエスト\n\n"
        f"- 作成者: {entry.author}\n"
        f"- 説明: {entry.description or 'なし'}\n"
        f"- タグ: {', '.join(entry.tags) if entry.tags else 'なし'}\n\n"
        f"```json\n{json_body[:5500]}\n```\n"
    )
    qs = urlencode({"title": issue_title, "body": issue_body})
    issue_url = f"https://github.com/tomotora1223/NicoTubeStudio/issues/new?{qs}"
    entry.url = issue_url
    return GithubStyleShareResult(method="issue_url", url=issue_url, entry=entry)


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
    raw_input = payload.url.strip()
    if raw_input.startswith("NTS1:"):
        try:
            decoded = json.loads(base64.b64decode(raw_input[5:].strip()).decode("utf-8"))
            cfg = decoded.get("config") or decoded
            return SharedStyleCreate(
                name=str(decoded.get("name") or "共有コードスタイル"),
                author="Share Code",
                description="共有コードからインポート",
                config=CommentStyleConfig(**cfg),
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"共有コードの解析に失敗しました: {exc}") from exc

    if not raw_input.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL (http:// / https://) または NTS1: コードを指定してください")

    url = raw_input
    # Support github.com/owner/repo/blob/... -> raw.githubusercontent.com
    gh_blob = re.match(r"^https?://github\.com/([^/]+)/([^/]+)/blob/(.+)$", url)
    if gh_blob:
        url = f"https://raw.githubusercontent.com/{gh_blob.group(1)}/{gh_blob.group(2)}/{gh_blob.group(3)}"

    # Support gist.github.com/<user>/<gist_id> -> api.github.com/gists/<gist_id>
    gist_m = re.match(r"^https?://gist\.github\.com/(?:[^/]+/)?([0-9a-fA-F]+)", url)
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=12.0) as client:
            if gist_m:
                resp = await client.get(f"https://api.github.com/gists/{gist_m.group(1)}")
                resp.raise_for_status()
                gist_json = resp.json()
                files = gist_json.get("files") or {}
                data = None
                for fname, fmeta in files.items():
                    if fname.endswith(".json") and isinstance(fmeta, dict) and fmeta.get("content"):
                        data = json.loads(fmeta["content"])
                        break
                if data is None:
                    raise ValueError("Gist内に有効なJSONスタイルファイルが見つかりません")
            else:
                resp = await client.get(url)
                resp.raise_for_status()
                data = resp.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"URLからの読込に失敗しました: {exc}") from exc

    if isinstance(data, list) and data:
        data = data[0]

    if isinstance(data, dict) and "config" in data:
        return SharedStyleCreate(
            name=str(data.get("name") or "インポートスタイル"),
            author=str(data.get("author") or "URL Import"),
            description=str(data.get("description") or raw_input),
            tags=[str(t) for t in (data.get("tags") or []) if t],
            config=CommentStyleConfig(**data["config"]),
        )
    if isinstance(data, dict):
        return SharedStyleCreate(
            name="インポートスタイル",
            author="URL Import",
            description=raw_input,
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
        await websocket.send_json(
            {"type": "tool_update_status", "payload": tool_updater.status.model_dump()}
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        queue_manager.remove_listener(send_msg)
