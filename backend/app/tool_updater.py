from __future__ import annotations

import asyncio
import importlib
import io
import json
import os
import shutil
import sys
import time
import zipfile
from pathlib import Path
from typing import Any, Callable, Coroutine, Optional

import httpx
import yt_dlp

from .config import BIN_DIR, BUNDLED_BIN_DIR, TOOL_META_FILE, YTDLP_LIVE_DIR, load_settings
from .ffmpeg_tools import download_ffmpeg, ensure_ffmpeg_in_path, get_ffmpeg_version
from .models import ToolUpdateStatus

PYPI_YTDLP_URL = "https://pypi.org/pypi/yt-dlp/json"
FFMPEG_VERSION_URL = "https://www.gyan.dev/ffmpeg/builds/release-version"
DENO_ZIP_URL = "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip"


def _parse_ver_tuple(v: str) -> tuple[int, ...]:
    nums = []
    for part in v.replace("-", ".").split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        if digits:
            nums.append(int(digits))
    return tuple(nums)


def detect_js_runtime() -> tuple[str, Optional[str]]:
    """Detect available JS runtime for yt-dlp (deno in BIN_DIR/PATH or node in PATH)."""
    for d in (BIN_DIR, BUNDLED_BIN_DIR):
        deno_local = d / "deno.exe"
        if deno_local.exists():
            return "deno", str(deno_local)
    deno_sys = shutil.which("deno")
    if deno_sys:
        return "deno", deno_sys
    node_sys = shutil.which("node")
    if node_sys:
        return "node", node_sys
    return "", None


def _reload_ytdlp_from_live_dir() -> None:
    live_str = str(YTDLP_LIVE_DIR)
    if live_str not in sys.path:
        sys.path.insert(0, live_str)
    for mod_name in list(sys.modules.keys()):
        if mod_name == "yt_dlp" or mod_name.startswith("yt_dlp."):
            sys.modules.pop(mod_name, None)
    importlib.invalidate_caches()
    import yt_dlp as fresh  # noqa: F401


class ToolUpdateManager:
    def __init__(self) -> None:
        self.status = ToolUpdateStatus(
            ytdlp_version=getattr(yt_dlp.version, "__version__", ""),
            ffmpeg_version=get_ffmpeg_version(),
        )
        rt_name, rt_path = detect_js_runtime()
        self.status.js_runtime = f"{rt_name} ({Path(rt_path).name})" if rt_name and rt_path else "未検出"
        self._lock = asyncio.Lock()
        self._emit: Optional[Callable[[str, Any], Coroutine[Any, Any, None]]] = None

    def set_emitter(self, emitter: Callable[[str, Any], Coroutine[Any, Any, None]]) -> None:
        self._emit = emitter

    async def _broadcast(self) -> None:
        if self._emit:
            try:
                await self._emit("tool_update_status", self.status.model_dump())
            except Exception:
                pass

    def _read_meta(self) -> dict:
        if TOOL_META_FILE.exists():
            try:
                return json.loads(TOOL_META_FILE.read_text(encoding="utf-8"))
            except Exception:
                pass
        return {}

    def _write_meta(self, meta: dict) -> None:
        TOOL_META_FILE.parent.mkdir(parents=True, exist_ok=True)
        TOOL_META_FILE.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    async def _ensure_deno_if_missing(self) -> None:
        rt_name, _ = detect_js_runtime()
        if rt_name:
            return
        try:
            self.status.ytdlp_status = "JSランタイム (Deno) を取得中..."
            await self._broadcast()
            BIN_DIR.mkdir(parents=True, exist_ok=True)
            async with httpx.AsyncClient(
                follow_redirects=True,
                timeout=httpx.Timeout(120.0, connect=10.0),
            ) as client:
                resp = await client.get(DENO_ZIP_URL)
                resp.raise_for_status()
                with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
                    for name in zf.namelist():
                        if name.lower().endswith("deno.exe"):
                            target = BIN_DIR / "deno.exe"
                            with zf.open(name) as src, open(target, "wb") as dst:
                                shutil.copyfileobj(src, dst)
                            break
            rt_name2, rt_path2 = detect_js_runtime()
            if rt_name2 and rt_path2:
                self.status.js_runtime = f"{rt_name2} ({Path(rt_path2).name})"
        except Exception:
            pass

    async def _update_ytdlp(self) -> None:
        try:
            self.status.ytdlp_status = "最新版を確認中..."
            await self._broadcast()
            async with httpx.AsyncClient(
                follow_redirects=True,
                timeout=httpx.Timeout(20.0, connect=10.0),
            ) as client:
                resp = await client.get(PYPI_YTDLP_URL)
                resp.raise_for_status()
                data = resp.json()
                latest_ver = data["info"]["version"]
                self.status.ytdlp_latest = latest_ver

                import yt_dlp as cur_ytdlp
                cur_ver = getattr(cur_ytdlp.version, "__version__", "")
                self.status.ytdlp_version = cur_ver

                if _parse_ver_tuple(latest_ver) <= _parse_ver_tuple(cur_ver):
                    self.status.ytdlp_status = "最新です"
                    await self._broadcast()
                    return

                # Find pure python wheel
                whl_url = None
                for url_obj in data.get("urls", []):
                    if url_obj.get("packagetype") == "bdist_wheel" and url_obj.get("filename", "").endswith(".whl"):
                        whl_url = url_obj["url"]
                        break
                if not whl_url:
                    self.status.ytdlp_status = "更新URLが見つかりません"
                    await self._broadcast()
                    return

                self.status.ytdlp_status = f"v{latest_ver} をダウンロード中..."
                await self._broadcast()
                whl_resp = await client.get(whl_url, timeout=httpx.Timeout(120.0, connect=10.0))
                whl_resp.raise_for_status()

            # Extract into staging folder and swap cleanly
            staging = YTDLP_LIVE_DIR.parent / "ytdlp_live_staging"
            shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(io.BytesIO(whl_resp.content)) as zf:
                zf.extractall(staging)

            shutil.rmtree(YTDLP_LIVE_DIR, ignore_errors=True)
            staging.replace(YTDLP_LIVE_DIR)

            await asyncio.to_thread(_reload_ytdlp_from_live_dir)
            import yt_dlp as updated_ytdlp
            self.status.ytdlp_version = getattr(updated_ytdlp.version, "__version__", latest_ver)
            self.status.ytdlp_status = f"v{self.status.ytdlp_version} に更新しました"
            meta = self._read_meta()
            meta["ytdlp_version"] = self.status.ytdlp_version
            self._write_meta(meta)
        except Exception as exc:
            self.status.ytdlp_status = f"確認エラー ({exc})"
        finally:
            await self._broadcast()

    async def _update_ffmpeg(self) -> None:
        try:
            ensure_ffmpeg_in_path()
            cur = get_ffmpeg_version()
            self.status.ffmpeg_version = cur
            self.status.ffmpeg_status = "最新版を確認中..."
            await self._broadcast()

            async with httpx.AsyncClient(
                follow_redirects=True,
                timeout=httpx.Timeout(15.0, connect=8.0),
            ) as client:
                resp = await client.get(FFMPEG_VERSION_URL)
                resp.raise_for_status()
                latest = resp.text.strip()
                self.status.ffmpeg_latest = latest

            cur_tuple = _parse_ver_tuple(cur) if cur not in ("", "未導入", "導入済み") else ()
            meta = self._read_meta()
            saved_raw = meta.get("ffmpeg_version", "")
            saved_tuple = _parse_ver_tuple(saved_raw) if saved_raw else ()
            effective_tuple = max(cur_tuple, saved_tuple) if (cur_tuple or saved_tuple) else ()
            latest_tuple = _parse_ver_tuple(latest)

            if cur != "未導入" and effective_tuple and latest_tuple and latest_tuple <= effective_tuple:
                if cur_tuple >= saved_tuple and cur != saved_raw:
                    meta["ffmpeg_version"] = cur
                    self._write_meta(meta)
                self.status.ffmpeg_status = "最新です"
                return

            if cur != "未導入" and not cur_tuple:
                # Non-semver custom/git build installed locally; do not stall on overwrite
                self.status.ffmpeg_status = "導入済み"
                return

            loop = asyncio.get_running_loop()

            def prog(pct: float, label: str) -> None:
                self.status.ffmpeg_status = label
                if self._emit and loop.is_running():
                    asyncio.run_coroutine_threadsafe(self._broadcast(), loop)

            await download_ffmpeg(prog, version_tag=latest)
            self.status.ffmpeg_version = get_ffmpeg_version()
            self.status.ffmpeg_status = f"v{latest} に更新しました"
            meta = self._read_meta()
            meta["ffmpeg_version"] = latest
            self._write_meta(meta)
        except Exception as exc:
            self.status.ffmpeg_status = f"確認エラー ({exc})"
        finally:
            await self._broadcast()

    async def run_check_and_update(self, force_even_if_disabled: bool = False) -> ToolUpdateStatus:
        settings = load_settings()
        ensure_ffmpeg_in_path()
        self.status.ffmpeg_version = get_ffmpeg_version()
        if not force_even_if_disabled and not settings.auto_update_tools:
            self.status.ytdlp_status = "自動更新オフ"
            self.status.ffmpeg_status = "自動更新オフ"
            await self._broadcast()
            return self.status

        if self._lock.locked():
            return self.status

        async with self._lock:
            self.status.checking = True
            await self._broadcast()
            try:
                await asyncio.gather(
                    self._ensure_deno_if_missing(),
                    self._update_ytdlp(),
                    self._update_ffmpeg(),
                    return_exceptions=True,
                )
                self.status.last_checked_at = time.time()
            finally:
                self.status.checking = False
                await self._broadcast()
        return self.status


tool_updater = ToolUpdateManager()
