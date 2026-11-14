from __future__ import annotations

import copy
import hashlib
import re
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Callable, Optional
from urllib.parse import urljoin

import httpx

from .chat_parser import (
    extract_twitch_target,
    fetch_twitch_chat_to_file,
    fetch_youtube_chat_to_file,
    is_twitch_url,
    resolve_twitch_clip_source,
)
from .config import BIN_DIR, BUNDLED_BIN_DIR, get_active_cookie_path
from .ffmpeg_tools import (
    ensure_ffmpeg_in_path,
    get_audio_codec,
    get_media_start_time,
    get_video_codec,
    get_video_metadata,
    get_video_stream_start_time,
    resolve_ffmpeg_video_args,
    resolve_hw_decode_args,
)
from .models import EncodeConfig, EncoderProbeResult, FormatOption, VideoInfoResponse
from .tool_updater import detect_js_runtime

_PREVIEW_LOCK = threading.Lock()
_PREVIEW_CACHE: dict[str, dict] = {}
_MAX_PREVIEW_ENTRIES = 24


def _build_cookie_header(cookiejar, target_url: str) -> str:
    if not cookiejar:
        return ""
    try:
        cookies = cookiejar.get_cookies_for_url(target_url)
        if cookies:
            return "; ".join(f"{c.name}={c.value}" for c in cookies)
    except Exception:
        pass
    return ""


def _register_preview_entry(
    url: str,
    headers: dict,
    cookie_header: str,
    is_hls: bool,
    mime: str,
) -> str:
    token = uuid.uuid4().hex[:16]
    entry = {
        "url": url,
        "headers": dict(headers or {}),
        "cookie": cookie_header,
        "is_hls": is_hls,
        "mime": mime,
        "segments": {},
        "created_at": time.time(),
    }
    with _PREVIEW_LOCK:
        _PREVIEW_CACHE[token] = entry
        while len(_PREVIEW_CACHE) > _MAX_PREVIEW_ENTRIES:
            oldest = min(_PREVIEW_CACHE.items(), key=lambda kv: kv[1]["created_at"])[0]
            _PREVIEW_CACHE.pop(oldest, None)
    return token


def get_preview_entry(token: str) -> Optional[dict]:
    with _PREVIEW_LOCK:
        return _PREVIEW_CACHE.get(token)


def register_preview_segment(token: str, target_url: str) -> str:
    seg_id = hashlib.sha1(target_url.encode("utf-8")).hexdigest()[:20]
    with _PREVIEW_LOCK:
        entry = _PREVIEW_CACHE.get(token)
        if entry is not None:
            segs = entry["segments"]
            if len(segs) > 4000:
                segs.clear()
            segs[seg_id] = target_url
    return seg_id


def get_preview_segment_url(token: str, seg_id: str) -> Optional[str]:
    with _PREVIEW_LOCK:
        entry = _PREVIEW_CACHE.get(token)
        if not entry:
            return None
        return entry["segments"].get(seg_id)


def _probe_stream_url_ok(
    f_url: str,
    headers: dict,
    cookiejar=None,
    is_hls: bool = False,
) -> bool:
    """Verify with a tiny HTTP GET that the upstream media URL does not return 403/404."""
    if not f_url or not f_url.startswith(("http://", "https://")):
        return False
    req_headers = {str(k): str(v) for k, v in (headers or {}).items()}
    cookie_hdr = _build_cookie_header(cookiejar, f_url)
    if cookie_hdr and "Cookie" not in req_headers:
        req_headers["Cookie"] = cookie_hdr
    if not is_hls:
        req_headers["Range"] = "bytes=0-1023"
    try:
        with httpx.Client(timeout=httpx.Timeout(6.0, connect=4.0), follow_redirects=True) as client:
            with client.stream("GET", f_url, headers=req_headers) as resp:
                return 200 <= resp.status_code < 400
    except Exception:
        return False


def _find_aria2c() -> Optional[str]:
    for d in (BIN_DIR, BUNDLED_BIN_DIR):
        cand = d / "aria2c.exe"
        if cand.exists():
            return str(cand)
    return shutil.which("aria2c")


def sanitize_filename(name: str, max_len: int = 120) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]+', "_", name).strip(" .")
    if not cleaned:
        cleaned = "video"
    return cleaned[:max_len]


def _common_ytdlp_opts(cookie_path: Optional[str]) -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "remote_components": ["ejs:github"],
        "concurrent_fragment_downloads": 6,
        "buffersize": 262144,
        "socket_timeout": 25,
        "retries": 10,
        "fragment_retries": 10,
        "extractor_retries": 5,
    }
    if cookie_path:
        opts["cookiefile"] = cookie_path
    rt_name, rt_path = detect_js_runtime()
    if rt_name and rt_path:
        opts["js_runtimes"] = {rt_name: {"path": rt_path}}
    return opts


def _extract_probe_info(url: str, cookie_path: Optional[str]) -> tuple[dict, object]:
    import yt_dlp

    ydl_opts = _common_ytdlp_opts(cookie_path)
    ydl_opts["skip_download"] = True
    ydl_opts["extract_flat"] = False
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
        return info or {}, ydl.cookiejar


def probe_video_info(url: str) -> VideoInfoResponse:
    ensure_ffmpeg_in_path()
    cookie_path = get_active_cookie_path()
    try:
        info, cj = _extract_probe_info(url, cookie_path)
    except Exception:
        if not cookie_path:
            raise
        info, cj = _extract_probe_info(url, None)

    if not info:
        raise ValueError("動画情報を取得できませんでした")

    formats_out: list[FormatOption] = []
    resolutions_set: set[int] = set()
    fps_set: set[int] = set()
    # (score, is_hls, mime, headers, url)
    preview_candidates: list[tuple[int, bool, str, dict, str]] = []
    fallback_headers = info.get("http_headers") or {}

    for f in info.get("formats") or []:
        vcodec = f.get("vcodec") or "none"
        acodec = f.get("acodec") or "none"
        height = f.get("height")
        width = f.get("width")
        fps = f.get("fps")
        ext = str(f.get("ext", "mp4"))
        f_url = f.get("url")
        protocol = str(f.get("protocol") or "")

        if vcodec == "none" or not height:
            continue
        eff_res = min(int(width), int(height)) if (width and height) else int(height)
        resolutions_set.add(eff_res)
        if fps:
            fps_set.add(int(round(float(fps))))

        if f_url and protocol in ("https", "http", "m3u8_native", "m3u8"):
            has_audio = 1 if acodec != "none" else 0
            is_hls = protocol in ("m3u8_native", "m3u8") or ".m3u8" in f_url.lower()
            is_h264 = 1 if "avc" in str(vcodec).lower() or "h264" in str(vcodec).lower() else 0
            is_mp4 = 1 if ext == "mp4" else 0
            # Prefer reliable HLS m3u8 / playable H.264 MP4 around 360p-720p for instant preview
            score = (
                (2200 if is_hls else 1800)
                + is_h264 * 600
                + has_audio * 500
                + is_mp4 * 150
                - abs(eff_res - 480)
            )
            hdrs = dict(f.get("http_headers") or fallback_headers or {})
            mime = "application/vnd.apple.mpegurl" if is_hls else f"video/{'webm' if ext == 'webm' else 'mp4'}"
            preview_candidates.append((score, is_hls, mime, hdrs, f_url))

        formats_out.append(
            FormatOption(
                format_id=str(f.get("format_id", "")),
                resolution=f"{width or '?'}x{height}",
                width=width,
                height=height,
                fps=fps,
                vcodec=vcodec,
                acodec=acodec,
                ext=ext,
                filesize_approx=f.get("filesize") or f.get("filesize_approx"),
            )
        )

    preview_stream_url: Optional[str] = None
    preview_token: Optional[str] = None
    if preview_candidates:
        preview_candidates.sort(key=lambda x: x[0], reverse=True)
        chosen = preview_candidates[0]
        # Verify top preview candidates so dead 403 URLs (like YouTube itag=18) are skipped
        for cand in preview_candidates[:6]:
            if _probe_stream_url_ok(cand[4], cand[3], cj, is_hls=cand[1]):
                chosen = cand
                break
        _, chosen_hls, chosen_mime, chosen_hdrs, chosen_url = chosen
        preview_stream_url = chosen_url
        preview_token = _register_preview_entry(
            chosen_url,
            chosen_hdrs,
            _build_cookie_header(cj, chosen_url),
            chosen_hls,
            chosen_mime,
        )

    extractor_key = str(info.get("extractor_key") or info.get("extractor") or "").lower()
    is_twitch = is_twitch_url(url) or extractor_key.startswith("twitch")
    platform = "twitch" if is_twitch else ("youtube" if "youtube" in extractor_key or "youtu" in url.lower() else "other")

    subs = info.get("subtitles") or {}
    auto_caps = info.get("automatic_captions") or {}
    has_live_chat = ("live_chat" in subs) or ("live_chat" in auto_caps)
    if is_twitch and not has_live_chat:
        vod_id, clip_slug = extract_twitch_target(url)
        if vod_id:
            has_live_chat = True
        elif clip_slug:
            resolved_vod, _, _ = resolve_twitch_clip_source(clip_slug)
            has_live_chat = resolved_vod is not None

    return VideoInfoResponse(
        id=str(info.get("id", "")),
        title=str(info.get("title", "Untitled")),
        uploader=str(info.get("uploader") or info.get("channel") or ""),
        channel_id=info.get("channel_id"),
        platform=platform,
        duration_sec=float(info.get("duration") or 0.0),
        is_live=bool(info.get("is_live")),
        was_live=bool(info.get("was_live")),
        has_live_chat=has_live_chat,
        thumbnail=info.get("thumbnail"),
        preview_stream_url=preview_stream_url,
        preview_token=preview_token,
        webpage_url=str(info.get("webpage_url") or url),
        resolutions=sorted(resolutions_set, reverse=True),
        fps_options=sorted(fps_set, reverse=True),
        formats=formats_out,
    )


def _is_portrait_info(info: Optional[dict]) -> bool:
    if not info:
        return False
    fmts = [
        f
        for f in (info.get("formats") or [])
        if (f.get("vcodec") or "none") != "none" and f.get("width") and f.get("height")
    ]
    if fmts:
        top = max(fmts, key=lambda f: int(f["height"]) * int(f["width"]))
        return int(top["height"]) > int(top["width"])
    w, h = info.get("width"), info.get("height")
    return bool(w and h and int(h) > int(w))


def _build_format_selector(
    resolution: str,
    max_fps: int,
    prefer_hls: bool = False,
    is_portrait: bool = False,
) -> str:
    filters: list[str] = []
    if resolution != "best" and resolution.isdigit():
        dim_key = "width" if is_portrait else "height"
        filters.append(f"{dim_key}<={resolution}")
    if max_fps > 0:
        filters.append(f"fps<={max_fps}.5")
    cond = "".join(f"[{c}]" for c in filters)
    if prefer_hls:
        return (
            f"bestvideo{cond}[protocol^=m3u8]+bestaudio[protocol^=m3u8]/"
            f"bestvideo{cond}[protocol^=m3u8]+bestaudio/"
            f"best{cond}[protocol^=m3u8]/"
            f"bestvideo{cond}+bestaudio/best{cond}/best"
        )
    return f"bestvideo{cond}+bestaudio/best{cond}/bestvideo+bestaudio/best"


def _build_ffmpeg_input_cmd_part(
    fmt: dict,
    fallback_headers: dict,
    cookiejar,
    clip_start: float,
    fetch_dur: Optional[float],
) -> list[str]:
    f_url = str(fmt["url"])
    part: list[str] = []
    if f_url.startswith(("http://", "https://")):
        part += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "4", "-rw_timeout", "20000000"]
    cookies = cookiejar.get_cookies_for_url(f_url) if cookiejar else []
    if cookies:
        cookie_hdr = "".join(
            f"{c.name}={c.value}; path={c.path}; domain={c.domain};\r\n" for c in cookies
        )
        part += ["-cookies", cookie_hdr]
    headers = fmt.get("http_headers") or fallback_headers or {}
    if headers:
        hdr_str = "".join(f"{k}: {v}\r\n" for k, v in headers.items())
        part += ["-headers", hdr_str]
    if clip_start > 0:
        part += ["-ss", f"{clip_start:.3f}"]
    if fetch_dur is not None and fetch_dur > 0:
        part += ["-t", f"{fetch_dur:.3f}"]
    part += ["-i", f_url]
    return part


def _run_ffmpeg_stream_copy(
    ffmpeg_exe: str,
    input_args: list[str],
    map_args: list[str],
    out_path: Path,
    on_stats: Callable[[int, int], None],
    cancel_check: Optional[Callable[[], bool]] = None,
    proc_hook: Optional[Callable[[subprocess.Popen, bool], None]] = None,
) -> tuple[bool, str]:
    cmd = [
        ffmpeg_exe,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-stats_period",
        "0.4",
        "-progress",
        "pipe:1",
        *input_args,
        *map_args,
        "-c",
        "copy",
        "-copyts",
        "-f",
        "matroska",
        str(out_path),
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if proc_hook:
        proc_hook(proc, True)

    stop_watch = threading.Event()
    was_cancelled = [False]
    err_chunks: list[bytes] = []

    def watch_cancel() -> None:
        while not stop_watch.is_set():
            if cancel_check and cancel_check():
                was_cancelled[0] = True
                try:
                    proc.terminate()
                except Exception:
                    pass
                stop_watch.wait(0.5)
                try:
                    if proc.poll() is None:
                        proc.kill()
                except Exception:
                    pass
                return
            stop_watch.wait(0.2)

    def drain_stderr() -> None:
        if proc.stderr is None:
            return
        while True:
            chunk = proc.stderr.read(4096)
            if not chunk:
                break
            if len(err_chunks) < 8:
                err_chunks.append(chunk)

    watcher = threading.Thread(target=watch_cancel, daemon=True)
    err_thread = threading.Thread(target=drain_stderr, daemon=True)
    watcher.start()
    err_thread.start()

    frame_num = 0
    total_bytes = 0
    try:
        assert proc.stdout is not None
        for raw_line in proc.stdout:
            line = raw_line.decode("utf-8", errors="ignore").strip()
            if "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k == "frame":
                try:
                    frame_num = int(v)
                except Exception:
                    pass
            elif k == "total_size":
                try:
                    total_bytes = int(v)
                except Exception:
                    pass
            elif k == "progress":
                if was_cancelled[0]:
                    break
                on_stats(frame_num, total_bytes)
    finally:
        stop_watch.set()
        watcher.join(timeout=1.0)
        if proc_hook:
            proc_hook(proc, False)

    ret = proc.wait()
    err_thread.join(timeout=1.0)
    err_txt = b"".join(err_chunks).decode("utf-8", errors="ignore").strip()
    if was_cancelled[0] or (cancel_check and cancel_check()):
        raise RuntimeError("Cancelled by user")
    ok = ret == 0 and out_path.exists() and out_path.stat().st_size > 0
    return ok, err_txt


def _selected_formats_reachable(info: dict, cookiejar) -> bool:
    selected = info.get("requested_formats") or [info]
    if not selected:
        return False
    fallback_hdrs = info.get("http_headers") or {}

    def _check_one(fmt: dict) -> bool:
        f_url = str(fmt.get("url") or "")
        proto = str(fmt.get("protocol") or "")
        if not f_url.startswith(("http://", "https://")):
            return False
        is_hls = proto in ("m3u8_native", "m3u8") or ".m3u8" in f_url.split("?", 1)[0].lower()
        hdrs = fmt.get("http_headers") or fallback_hdrs
        return _probe_stream_url_ok(f_url, hdrs, cookiejar, is_hls=is_hls)

    if len(selected) == 1:
        return _check_one(selected[0])
    with ThreadPoolExecutor(max_workers=len(selected)) as pool:
        return all(pool.map(_check_one, selected))


def _resolve_working_extraction(
    url: str,
    encode: EncodeConfig,
    cookie_path: Optional[str],
    twitch_mode: bool,
    cancel_check: Optional[Callable[[], bool]] = None,
    prefer_hls_first: bool = False,
) -> tuple[dict, dict, object]:
    """Extract once per (cookie, client) and select reachable formats in-memory."""
    import yt_dlp

    groups: list[tuple[Optional[str], Optional[list[str]]]] = [(cookie_path, None)]
    if cookie_path:
        groups.append((None, None))
    if not twitch_mode:
        groups.append((None, ["android_vr", "tv", "web"]))

    hls_order = (True, False) if prefer_hls_first else (False, True)
    last_info: Optional[dict] = None
    last_opts: Optional[dict] = None
    last_cj: object = None
    last_err: Optional[Exception] = None

    for ck, clients in groups:
        if cancel_check and cancel_check():
            raise RuntimeError("Cancelled by user")
        base_opts = _common_ytdlp_opts(ck)
        base_opts["skip_download"] = True
        if clients:
            base_opts["extractor_args"] = {"youtube": {"player_client": clients}}
        try:
            with yt_dlp.YoutubeDL(base_opts) as ydl:
                raw_info = ydl.extract_info(url, download=False, process=False) or {}
                cj = ydl.cookiejar
                if not raw_info:
                    continue

                is_portrait = _is_portrait_info(raw_info)
                if raw_info.get("formats"):
                    for prefer_hls in hls_order:
                        if cancel_check and cancel_check():
                            raise RuntimeError("Cancelled by user")
                        sel_str = _build_format_selector(
                            encode.resolution, encode.max_fps, prefer_hls=prefer_hls, is_portrait=is_portrait
                        )
                        opts = dict(base_opts)
                        opts["format"] = sel_str
                        ydl.format_selector = ydl.build_format_selector(sel_str)
                        info = ydl.process_ie_result(copy.deepcopy(raw_info), download=False) or {}
                        if not info:
                            continue
                        last_info, last_opts, last_cj = info, opts, cj
                        if _selected_formats_reachable(info, cj):
                            return opts, info, cj
                else:
                    sel_str = _build_format_selector(
                        encode.resolution, encode.max_fps, prefer_hls=False, is_portrait=is_portrait
                    )
                    opts = dict(base_opts)
                    opts["format"] = sel_str
                    ydl.format_selector = ydl.build_format_selector(sel_str)
                    info = ydl.process_ie_result(copy.deepcopy(raw_info), download=False) or {}
                    if info:
                        last_info, last_opts, last_cj = info, opts, cj
                        if _selected_formats_reachable(info, cj):
                            return opts, info, cj
        except Exception as exc:
            if (cancel_check and cancel_check()) or "Cancelled" in str(exc):
                raise RuntimeError("Cancelled by user") from exc
            last_err = exc
            continue

    if last_info is not None and last_opts is not None:
        return last_opts, last_info, last_cj
    if last_err is not None:
        raise last_err
    raise RuntimeError("ストリーム情報の取得に失敗しました")


def _parallel_hls_clip_download(
    ffmpeg_exe: str,
    info: dict,
    selected: list[dict],
    cookiejar,
    work_dir: Path,
    s: float,
    e: float,
    progress_cb: Optional[Callable[[float, str], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
    proc_hook: Optional[Callable[[subprocess.Popen, bool], None]] = None,
) -> Optional[tuple[Path, float, Optional[float]]]:
    """Lightweight 6-connection keep-alive HLS segment clip download + local concat."""
    if not selected or len(selected) > 2 or e == float("inf") or e <= s:
        return None
    for fmt in selected:
        f_url = str(fmt.get("url") or "")
        proto = str(fmt.get("protocol") or "")
        is_hls = proto in ("m3u8_native", "m3u8") or ".m3u8" in f_url.split("?", 1)[0].lower()
        if not (is_hls and f_url.startswith(("http://", "https://"))):
            return None

    fallback_headers = dict(info.get("http_headers") or {})
    target_dur = e - s
    pad_start = max(0.0, s - 2.0)
    pad_end = e + 2.0
    stream_plans: list[tuple[int, dict, list[tuple[int, float, float, str]]]] = []
    seg_dirs: list[Path] = []
    concat_files: list[Path] = []

    try:
        with httpx.Client(
            timeout=httpx.Timeout(18.0, connect=6.0),
            follow_redirects=True,
            limits=httpx.Limits(max_connections=8, max_keepalive_connections=8),
        ) as client:
            for idx, fmt in enumerate(selected):
                if cancel_check and cancel_check():
                    raise RuntimeError("Cancelled by user")
                f_url = str(fmt["url"])
                hdrs = {str(k): str(v) for k, v in {**fallback_headers, **(fmt.get("http_headers") or {})}.items()}
                ck = _build_cookie_header(cookiejar, f_url)
                if ck and "cookie" not in {k.lower() for k in hdrs}:
                    hdrs["Cookie"] = ck
                resp = client.get(f_url, headers=hdrs)
                if resp.status_code >= 400:
                    return None
                m3u8_txt = resp.text
                if any(
                    tag in m3u8_txt
                    for tag in (
                        "#EXT-X-STREAM-INF",
                        "#EXT-X-KEY",
                        "#EXT-X-MAP",
                        "#EXT-X-BYTERANGE",
                        "#EXT-X-DISCONTINUITY",
                    )
                ) or "#EXT-X-ENDLIST" not in m3u8_txt:
                    return None

                base_u = str(resp.url)
                cur_t = 0.0
                dur_next = 0.0
                segs: list[tuple[int, float, float, str]] = []
                for ln in m3u8_txt.splitlines():
                    ls = ln.strip()
                    if not ls:
                        continue
                    if ls.startswith("#EXTINF:"):
                        try:
                            dur_next = float(ls.split(":", 1)[1].split(",", 1)[0])
                        except Exception:
                            dur_next = 0.0
                    elif not ls.startswith("#"):
                        if dur_next <= 0:
                            return None
                        if cur_t + dur_next > pad_start and cur_t < pad_end:
                            segs.append((len(segs), cur_t, dur_next, urljoin(base_u, ls)))
                        cur_t += dur_next
                        dur_next = 0.0

                if len(segs) < 2:
                    return None
                stream_plans.append((idx, hdrs, segs))

            if len(stream_plans) != len(selected):
                return None

            base_start = min(sg[0][1] for _, _, sg in stream_plans)
            total_segs = sum(len(sg) for _, _, sg in stream_plans)
            done_segs = [0]
            done_bytes = [0]
            stat_lock = threading.Lock()
            last_emit = [0.0]

            if progress_cb:
                progress_cb(0.05, "切り抜き区間へ高速並列接続中...")

            dl_jobs: list[tuple[dict, Path, str]] = []
            for idx, hdrs, sg in stream_plans:
                sdir = work_dir / f"_hls_seg_{idx}"
                sdir.mkdir(parents=True, exist_ok=True)
                seg_dirs.append(sdir)
                for seg_i, _, _, seg_u in sg:
                    dl_jobs.append((hdrs, sdir / f"{seg_i:05d}.ts", seg_u))

            tls = threading.local()
            thread_clients: list[httpx.Client] = []
            client_reg_lock = threading.Lock()

            def _get_worker_client() -> httpx.Client:
                c = getattr(tls, "client", None)
                if c is None:
                    c = httpx.Client(
                        timeout=httpx.Timeout(18.0, connect=6.0),
                        follow_redirects=True,
                        limits=httpx.Limits(max_connections=4, max_keepalive_connections=4),
                    )
                    tls.client = c
                    with client_reg_lock:
                        thread_clients.append(c)
                return c

            def fetch_seg(job_item: tuple[dict, Path, str]) -> None:
                hdrs, dest, seg_u = job_item
                last_e: Optional[Exception] = None
                wclient = _get_worker_client()
                for attempt in range(3):
                    if cancel_check and cancel_check():
                        raise RuntimeError("Cancelled by user")
                    try:
                        r = wclient.get(seg_u, headers=hdrs)
                        r.raise_for_status()
                        dest.write_bytes(r.content)
                        sz = len(r.content)
                        with stat_lock:
                            done_segs[0] += 1
                            done_bytes[0] += sz
                            cnt = done_segs[0]
                            mb = done_bytes[0] / (1024.0 * 1024.0)
                            now = time.monotonic()
                            if progress_cb and (now - last_emit[0] >= 0.2 or cnt == total_segs):
                                last_emit[0] = now
                                pct = 0.05 + 0.89 * (cnt / max(1, total_segs))
                                progress_cb(pct, f"切り抜き区間を並列取得中 {pct*100:.0f}% ({mb:.1f} MB)")
                        return
                    except Exception as exc:
                        if cancel_check and cancel_check():
                            raise RuntimeError("Cancelled by user") from exc
                        last_e = exc
                        if attempt < 2:
                            time.sleep(0.3 * (attempt + 1))
                if last_e is not None:
                    raise last_e

            pool = ThreadPoolExecutor(max_workers=min(6, len(dl_jobs)))
            futs = [pool.submit(fetch_seg, item) for item in dl_jobs]
            pending = set(futs)
            try:
                while pending:
                    if cancel_check and cancel_check():
                        for f in futs:
                            f.cancel()
                        pool.shutdown(wait=False, cancel_futures=True)
                        raise RuntimeError("Cancelled by user")
                    finished, pending = wait(pending, timeout=0.2, return_when=FIRST_COMPLETED)
                    for df in finished:
                        df.result()
            except Exception as exc:
                for f in futs:
                    f.cancel()
                pool.shutdown(wait=False, cancel_futures=True)
                if (cancel_check and cancel_check()) or "Cancelled" in str(exc):
                    raise RuntimeError("Cancelled by user") from exc
                return None
            finally:
                for wc in thread_clients:
                    try:
                        wc.close()
                    except Exception:
                        pass
                if not (cancel_check and cancel_check()):
                    pool.shutdown(wait=True)

        if cancel_check and cancel_check():
            raise RuntimeError("Cancelled by user")

        if progress_cb:
            progress_cb(0.95, "映像と音声を結合中...")

        out_mkv = work_dir / "source_raw.mkv"
        mux_cmd = [ffmpeg_exe, "-y", "-hide_banner", "-loglevel", "error"]
        v_base = stream_plans[0][2][0][1]
        for idx, _, sg in stream_plans:
            sdir = seg_dirs[idx]
            cf = work_dir / f"_hls_concat_{idx}.txt"
            concat_files.append(cf)
            c_lines = []
            for seg_i, _, _, _ in sg:
                p_str = (sdir / f"{seg_i:05d}.ts").as_posix().replace("'", r"\'")
                c_lines.append(f"file '{p_str}'")
            cf.write_text("\n".join(c_lines), encoding="utf-8")
            shift = sg[0][1] - v_base if idx > 0 else 0.0
            if abs(shift) > 0.01:
                mux_cmd += ["-itsoffset", f"{shift:.3f}"]
            mux_cmd += ["-f", "concat", "-safe", "0", "-i", str(cf)]

        for idx in range(len(stream_plans)):
            mux_cmd += ["-map", f"{idx}:0"]
        mux_cmd += ["-c", "copy", "-f", "matroska", str(out_mkv)]

        mux_proc = subprocess.Popen(
            mux_cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc_hook:
            proc_hook(mux_proc, True)
        try:
            while mux_proc.poll() is None:
                if cancel_check and cancel_check():
                    mux_proc.kill()
                    raise RuntimeError("Cancelled by user")
                time.sleep(0.1)
        finally:
            if proc_hook:
                proc_hook(mux_proc, False)

        if mux_proc.returncode != 0 or not out_mkv.exists() or out_mkv.stat().st_size == 0:
            out_mkv.unlink(missing_ok=True)
            return None

        trim_offset = max(0.0, s - base_start)
        _, _, _, clip_file_dur = get_video_metadata(str(out_mkv))
        if clip_file_dur > 0 and trim_offset >= max(0.5, clip_file_dur - 0.5):
            out_mkv.unlink(missing_ok=True)
            return None
        if progress_cb:
            progress_cb(0.96, "切り抜き素材の取得が完了しました")
        return out_mkv, trim_offset, target_dur
    finally:
        for cf in concat_files:
            cf.unlink(missing_ok=True)
        for sd in seg_dirs:
            shutil.rmtree(sd, ignore_errors=True)


def _direct_ffmpeg_clip_download(
    ffmpeg_exe: str,
    info: dict,
    cookiejar,
    work_dir: Path,
    clip_start_sec: float,
    clip_end_sec: float,
    progress_cb: Optional[Callable[[float, str], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
    proc_hook: Optional[Callable[[subprocess.Popen, bool], None]] = None,
) -> Optional[tuple[Path, float, Optional[float]]]:
    """Parallel stream-copy clipped download into Matroska preserving original PTS."""
    selected = info.get("requested_formats") or [info]
    if not selected:
        return None
    for fmt in selected:
        f_url = str(fmt.get("url") or "")
        if not (f_url.startswith("http://") or f_url.startswith("https://")):
            return None

    hls_fast = _parallel_hls_clip_download(
        ffmpeg_exe,
        info,
        selected,
        cookiejar,
        work_dir,
        max(0.0, float(clip_start_sec)),
        clip_end_sec,
        progress_cb,
        cancel_check,
        proc_hook,
    )
    if hls_fast is not None:
        return hls_fast

    out_mkv = work_dir / "source_raw.mkv"
    s = max(0.0, float(clip_start_sec))
    has_end = clip_end_sec < float("inf")
    dur_total = float(info.get("duration") or 0.0)
    target_dur = (clip_end_sec - s) if has_end else max(0.0, dur_total - s)
    fetch_dur = (clip_end_sec - s + 4.0) if has_end else None

    v_fps = 30.0
    for fmt in selected:
        if fmt.get("vcodec") not in (None, "none") and fmt.get("fps"):
            v_fps = float(fmt["fps"])
            break
    expected_frames = int(target_dur * v_fps) if target_dur > 0 else 0
    fallback_headers = info.get("http_headers") or {}

    if progress_cb:
        progress_cb(0.04, "切り抜き区間へ高速並列接続中...")

    stats_lock = threading.Lock()
    stream_frames = [0] * len(selected)
    stream_bytes = [0] * len(selected)

    def make_stats_cb(idx: int) -> Callable[[int, int], None]:
        def cb(fr: int, b: int) -> None:
            with stats_lock:
                if fr > 0:
                    stream_frames[idx] = fr
                if b > 0:
                    stream_bytes[idx] = b
                tot_b = sum(stream_bytes)
                max_f = max(stream_frames)
            mb = tot_b / (1024.0 * 1024.0)
            if expected_frames > 0 and max_f > 0:
                pct = min(0.94, max(0.05, max_f / expected_frames))
                if progress_cb:
                    progress_cb(pct, f"切り抜き区間を並列取得中 {pct*100:.0f}% ({mb:.1f} MB)")
            elif progress_cb:
                progress_cb(0.08, f"切り抜き区間を並列取得中 ({mb:.1f} MB)...")
        return cb

    if len(selected) == 1:
        in_args = _build_ffmpeg_input_cmd_part(selected[0], fallback_headers, cookiejar, s, fetch_dur)
        ok, _ = _run_ffmpeg_stream_copy(
            ffmpeg_exe,
            in_args,
            ["-map", "0"],
            out_mkv,
            make_stats_cb(0),
            cancel_check,
            proc_hook,
        )
        if not ok:
            out_mkv.unlink(missing_ok=True)
            return None
    else:
        part_paths = [work_dir / f"part_{i}.mkv" for i in range(len(selected))]

        def fetch_one(idx: int) -> tuple[bool, str]:
            fmt = selected[idx]
            in_args = _build_ffmpeg_input_cmd_part(fmt, fallback_headers, cookiejar, s, fetch_dur)
            s_idx = fmt.get("manifest_stream_number", 0)
            return _run_ffmpeg_stream_copy(
                ffmpeg_exe,
                in_args,
                ["-map", f"0:{s_idx}"],
                part_paths[idx],
                make_stats_cb(idx),
                cancel_check,
                proc_hook,
            )

        with ThreadPoolExecutor(max_workers=len(selected)) as pool:
            futs = [pool.submit(fetch_one, i) for i in range(len(selected))]
            results = [f.result() for f in futs]

        if not all(ok for ok, _ in results):
            for p in part_paths:
                p.unlink(missing_ok=True)
            return None

        if progress_cb:
            progress_cb(0.95, "映像と音声を結合中...")

        mux_cmd = [ffmpeg_exe, "-y", "-hide_banner", "-loglevel", "error"]
        for p in part_paths:
            mux_cmd += ["-i", str(p)]
        for i in range(len(part_paths)):
            mux_cmd += ["-map", f"{i}:0"]
        mux_cmd += ["-c", "copy", "-copyts", "-f", "matroska", str(out_mkv)]
        mux_proc = subprocess.Popen(
            mux_cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc_hook:
            proc_hook(mux_proc, True)
        try:
            while mux_proc.poll() is None:
                if cancel_check and cancel_check():
                    mux_proc.kill()
                    raise RuntimeError("Cancelled by user")
                time.sleep(0.1)
        finally:
            if proc_hook:
                proc_hook(mux_proc, False)

        for p in part_paths:
            p.unlink(missing_ok=True)

        if mux_proc.returncode != 0 or not out_mkv.exists() or out_mkv.stat().st_size == 0:
            out_mkv.unlink(missing_ok=True)
            return None

    v_start = get_video_stream_start_time(str(out_mkv))
    c_start = get_media_start_time(str(out_mkv))
    actual_start = v_start if v_start is not None else c_start
    _, _, _, clip_file_dur = get_video_metadata(str(out_mkv))

    if actual_start >= max(0.0, s - 120.0):
        trim_offset = max(0.0, s - actual_start)
    elif s > 60.0 and actual_start < 5.0 and clip_file_dur > 0 and clip_file_dur <= (target_dur + 45.0):
        # Input -ss on HLS/m3u8 sought directly to target and reset PTS to ~0
        trim_offset = 0.0
    else:
        trim_offset = max(0.0, s - actual_start)

    if s > 5.0 and clip_file_dur > 0 and trim_offset >= max(0.5, clip_file_dur - 0.5):
        out_mkv.unlink(missing_ok=True)
        return None
    trim_duration = (clip_end_sec - s) if has_end else None
    if progress_cb:
        progress_cb(0.96, "切り抜き素材の取得が完了しました")
    return out_mkv, trim_offset, trim_duration


def download_video_and_chat(
    url: str,
    work_dir: Path,
    encode: EncodeConfig,
    need_chat: bool,
    clip_start_sec: Optional[float] = None,
    clip_end_sec: Optional[float] = None,
    progress_cb: Optional[Callable[[float, str], None]] = None,
    cancel_check: Optional[Callable[[], bool]] = None,
    proc_hook: Optional[Callable[[subprocess.Popen, bool], None]] = None,
) -> tuple[Path, Optional[Path], float, Optional[float]]:
    """Download video (optionally clipped) and live_chat.json into work_dir."""
    import yt_dlp
    from yt_dlp.utils import download_range_func

    work_dir.mkdir(parents=True, exist_ok=True)
    ffmpeg_exe = ensure_ffmpeg_in_path()
    cookie_path = get_active_cookie_path()
    last_sub_emit = [0.0]

    def hook(d: dict) -> None:
        if cancel_check and cancel_check():
            raise yt_dlp.utils.DownloadCancelled("Cancelled by user")
        status = d.get("status")
        fname = str(d.get("filename") or "").lower()
        info_ext = str((d.get("info_dict") or {}).get("ext") or "").lower()
        is_sub = info_ext in ("json", "vtt", "srt", "ass", "ttml") or ".live_chat." in fname
        if is_sub:
            if progress_cb:
                if status == "finished":
                    progress_cb(0.06, "ライブチャットデータを取得しました")
                elif status == "downloading":
                    now = time.monotonic()
                    if now - last_sub_emit[0] >= 0.8:
                        last_sub_emit[0] = now
                        mb = (d.get("downloaded_bytes") or 0) / (1024.0 * 1024.0)
                        progress_cb(0.04, f"ライブチャットを取得中 ({mb:.1f} MB)...")
            return
        if status == "downloading" and progress_cb:
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            pct = (downloaded / total) if total > 0 else 0.0
            spd = d.get("_speed_str") or ""
            progress_cb(min(0.95, pct), f"動画をダウンロード中 {pct*100:.1f}% {spd}".strip())

    def pp_hook(d: dict) -> None:
        if cancel_check and cancel_check():
            raise yt_dlp.utils.DownloadCancelled("Cancelled by user")
        if d.get("status") == "started" and "Merger" in str(d.get("postprocessor") or "") and progress_cb:
            progress_cb(0.96, "映像と音声を結合中...")

    outtmpl = str(work_dir / "source.%(ext)s")
    twitch_mode = is_twitch_url(url)

    def build_dl_opts(base_opts: dict, with_subs: bool = False) -> dict:
        opts = dict(base_opts)
        opts["skip_download"] = False
        opts["outtmpl"] = outtmpl
        opts["merge_output_format"] = encode.container
        opts["progress_hooks"] = [hook]
        opts["postprocessor_hooks"] = [pp_hook]
        if ffmpeg_exe:
            opts["ffmpeg_location"] = str(Path(ffmpeg_exe).parent)
        if with_subs and not twitch_mode:
            opts["writesubtitles"] = True
            opts["subtitleslangs"] = ["live_chat"]
        else:
            opts.pop("writesubtitles", None)
        return opts

    is_clipped = (clip_start_sec is not None and clip_start_sec > 0) or (
        clip_end_sec is not None and clip_end_sec > 0
    )

    trim_offset_sec = 0.0
    trim_duration_sec: Optional[float] = None
    video_path: Optional[Path] = None
    chat_path: Optional[Path] = None
    twitch_chat_dest = work_dir / "source.twitch_chat.json"
    youtube_chat_dest = work_dir / "source.live_chat.json"

    def dl_chat_worker() -> None:
        if not need_chat:
            return
        if twitch_mode:
            try:
                fetch_twitch_chat_to_file(
                    url,
                    twitch_chat_dest,
                    clip_start_sec,
                    clip_end_sec,
                    progress_cb,
                    cancel_check,
                )
            except Exception as exc:
                if (cancel_check and cancel_check()) or "Cancelled" in str(exc):
                    raise
            return

        # Fast range-seekable YouTube chat replay fetcher first
        try:
            got = fetch_youtube_chat_to_file(
                url,
                youtube_chat_dest,
                cookie_path,
                clip_start_sec,
                clip_end_sec,
                progress_cb,
                cancel_check,
            )
            if got is not None and got.exists():
                return
            if cookie_path and not (cancel_check and cancel_check()):
                got2 = fetch_youtube_chat_to_file(
                    url,
                    youtube_chat_dest,
                    None,
                    clip_start_sec,
                    clip_end_sec,
                    progress_cb,
                    cancel_check,
                )
                if got2 is not None and got2.exists():
                    return
        except Exception as exc:
            if (cancel_check and cancel_check()) or "Cancelled" in str(exc):
                raise

        if cancel_check and cancel_check():
            raise RuntimeError("Cancelled by user")

        # Fallback to yt-dlp subtitles (with live progress & cancel hook)
        chat_opts = _common_ytdlp_opts(cookie_path)
        chat_opts.update(
            {
                "skip_download": True,
                "writesubtitles": True,
                "subtitleslangs": ["live_chat"],
                "outtmpl": outtmpl,
                "progress_hooks": [hook],
            }
        )
        try:
            with yt_dlp.YoutubeDL(chat_opts) as cydl:
                cydl.download([url])
        except Exception as exc:
            if (cancel_check and cancel_check()) or "Cancelled" in str(exc):
                raise RuntimeError("Cancelled by user") from exc

    def _run_cancellable_pool(tasks: list[Callable[[], object]]) -> list[object]:
        pool = ThreadPoolExecutor(max_workers=len(tasks))
        futs = [pool.submit(fn) for fn in tasks]
        pending = set(futs)
        try:
            while pending:
                if cancel_check and cancel_check():
                    for f in futs:
                        f.cancel()
                    pool.shutdown(wait=False, cancel_futures=True)
                    raise RuntimeError("Cancelled by user")
                done, pending = wait(pending, timeout=0.2, return_when=FIRST_COMPLETED)
                for df in done:
                    df.result()
            return [f.result() for f in futs]
        except Exception:
            for f in futs:
                f.cancel()
            pool.shutdown(wait=False, cancel_futures=True)
            raise
        finally:
            if not (cancel_check and cancel_check()):
                pool.shutdown(wait=True)

    def _run_full_with_fallbacks(preferred_opts: Optional[dict] = None, preferred_info: Optional[dict] = None) -> None:
        strategies: list[dict] = []
        is_portrait = _is_portrait_info(preferred_info)
        if preferred_opts is not None:
            strategies.append(build_dl_opts(preferred_opts, with_subs=False))
        for ck in ([cookie_path, None] if cookie_path else [None]):
            for prefer_hls in (False, True):
                o = _common_ytdlp_opts(ck)
                o["format"] = _build_format_selector(
                    encode.resolution, encode.max_fps, prefer_hls=prefer_hls, is_portrait=is_portrait
                )
                strategies.append(build_dl_opts(o, with_subs=False))
        if not twitch_mode:
            o_alt = _common_ytdlp_opts(None)
            o_alt["format"] = _build_format_selector(
                encode.resolution, encode.max_fps, prefer_hls=True, is_portrait=is_portrait
            )
            o_alt["extractor_args"] = {"youtube": {"player_client": ["android_vr", "tv", "web"]}}
            strategies.append(build_dl_opts(o_alt, with_subs=False))

        last_exc: Optional[Exception] = None
        for idx, s_opts in enumerate(strategies):
            if cancel_check and cancel_check():
                raise RuntimeError("Cancelled by user")
            try:
                if idx > 0 and progress_cb:
                    progress_cb(0.03, "別ストリーム経路で再接続中...")
                for stale in work_dir.glob("source*.part*"):
                    stale.unlink(missing_ok=True)
                with yt_dlp.YoutubeDL(s_opts) as ydl:
                    if idx == 0 and preferred_info is not None:
                        ydl.process_ie_result(copy.deepcopy(preferred_info), download=True)
                    else:
                        ydl.download([url])
                if any(
                    p.stem in ("source", "source_raw") and p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov")
                    for p in work_dir.iterdir()
                ):
                    return
            except Exception as exc:
                if (cancel_check and cancel_check()) or "Cancelled" in str(exc):
                    raise RuntimeError("Cancelled by user") from exc
                last_exc = exc
        if last_exc is not None:
            raise last_exc

    if is_clipped:
        if not ffmpeg_exe:
            raise RuntimeError("区間切り抜きにはFFmpegが必要ですが、見つかりません。設定画面からFFmpegを導入してください。")
        s = float(clip_start_sec or 0.0)
        e = float(clip_end_sec) if clip_end_sec is not None else float("inf")
        if e > s:
            if progress_cb:
                progress_cb(0.02, "切り抜き用ストリーム情報を取得中...")
            resolved_opts, info, cj = _resolve_working_extraction(
                url, encode, cookie_path, twitch_mode, cancel_check, prefer_hls_first=True
            )

            if cancel_check and cancel_check():
                raise RuntimeError("Cancelled by user")

            def _do_clip():
                res = _direct_ffmpeg_clip_download(
                    ffmpeg_exe,
                    info or {},
                    cj,
                    work_dir,
                    s,
                    e,
                    progress_cb,
                    cancel_check,
                    proc_hook,
                )
                if res is not None:
                    return res
                # Second pass forcing HLS/cookie-less if direct clip failed
                if cancel_check and cancel_check():
                    raise RuntimeError("Cancelled by user")
                if progress_cb:
                    progress_cb(0.05, "別経路 (HLS) で切り抜き取得を再試行中...")
                alt_opts = _common_ytdlp_opts(None)
                alt_opts["skip_download"] = True
                alt_opts["format"] = _build_format_selector(
                    encode.resolution, encode.max_fps, prefer_hls=True, is_portrait=_is_portrait_info(info)
                )
                with yt_dlp.YoutubeDL(alt_opts) as ydl2:
                    info2 = ydl2.extract_info(url, download=False) or {}
                    cj2 = ydl2.cookiejar
                return _direct_ffmpeg_clip_download(
                    ffmpeg_exe,
                    info2,
                    cj2,
                    work_dir,
                    s,
                    e,
                    progress_cb,
                    cancel_check,
                    proc_hook,
                )

            tasks: list[Callable[[], object]] = [_do_clip]
            if need_chat:
                tasks.append(dl_chat_worker)
            results = _run_cancellable_pool(tasks)
            direct = results[0]

            if direct is not None:
                video_path, trim_offset_sec, trim_duration_sec = direct  # type: ignore[misc]
            else:
                # Fallback to yt-dlp download_ranges without re-downloading chat
                fb_opts = build_dl_opts(resolved_opts, with_subs=False)
                fb_opts["download_ranges"] = download_range_func(None, [(s, e)])
                fb_opts["force_keyframes_at_cuts"] = False
                with yt_dlp.YoutubeDL(fb_opts) as ydl:
                    ydl.download([url])
        else:
            tasks = [lambda: _run_full_with_fallbacks()]
            if need_chat:
                tasks.append(dl_chat_worker)
            _run_cancellable_pool(tasks)
    else:
        if progress_cb:
            progress_cb(0.02, "ダウンロード用ストリームを検証中...")
        resolved_opts, resolved_info, _ = _resolve_working_extraction(
            url, encode, cookie_path, twitch_mode, cancel_check, prefer_hls_first=True
        )
        tasks = [lambda: _run_full_with_fallbacks(resolved_opts, resolved_info)]
        if need_chat:
            tasks.append(dl_chat_worker)
        _run_cancellable_pool(tasks)

    for p in sorted(work_dir.iterdir()):
        if p.name.endswith(".live_chat.json") or p.name.endswith(".twitch_chat.json"):
            chat_path = p
        elif not video_path and p.stem in ("source", "source_raw") and p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov"):
            video_path = p

    if not video_path:
        for p in sorted(work_dir.iterdir()):
            if p.suffix.lower() in (".mp4", ".mkv", ".webm", ".mov"):
                video_path = p
                break

    if not video_path or not video_path.exists():
        raise RuntimeError("動画ファイルのダウンロードに失敗しました")

    return video_path, chat_path, trim_offset_sec, trim_duration_sec


def transcode_video_only(
    source_video: str,
    output_video: str,
    encode: EncodeConfig,
    probe: EncoderProbeResult,
    clip_offset_sec: float = 0.0,
    clip_duration_sec: Optional[float] = None,
    progress_cb: Optional[Callable[[float, float, str, Optional[int]], None]] = None,
    cancel_event: Optional[threading.Event] = None,
    proc_hook: Optional[Callable[[subprocess.Popen, bool], None]] = None,
) -> None:
    """Copy or hardware-transcode video without comments when user requests video_only or both."""
    ffmpeg_exe = ensure_ffmpeg_in_path()
    if not ffmpeg_exe:
        shutil.copy2(source_video, output_video)
        return

    src_ext = Path(source_video).suffix.lower().lstrip(".")
    has_trim = clip_offset_sec > 0 or (clip_duration_sec is not None and clip_duration_sec > 0)
    src_vcodec = get_video_codec(source_video)
    src_acodec = get_audio_codec(source_video)
    codec_matches = (
        (encode.codec == "h264" and src_vcodec in ("h264", "avc1"))
        or (encode.codec == "h265" and src_vcodec in ("hevc", "h265", "hvc1", "hev1"))
        or (encode.codec == "av1" and src_vcodec in ("av1", "av01"))
    )
    audio_copy_ok = (encode.container == "mkv") or src_acodec in ("aac", "mp3", "ac3", "eac3", "alac", "flac", "")
    container_args = ["-movflags", "+faststart"] if encode.container == "mp4" else []

    if src_ext == encode.container and codec_matches and audio_copy_ok and encode.max_fps == 0 and not has_trim:
        cmd = [
            ffmpeg_exe, "-y", "-hide_banner", "-loglevel", "error",
            "-i", source_video, "-c", "copy", *container_args, output_video,
        ]
        copy_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc_hook:
            proc_hook(copy_proc, True)
        try:
            while copy_proc.poll() is None:
                if cancel_event and cancel_event.is_set():
                    copy_proc.kill()
                    raise RuntimeError("ジョブがキャンセルされました")
                time.sleep(0.2)
        finally:
            if proc_hook:
                proc_hook(copy_proc, False)
        if copy_proc.returncode != 0:
            shutil.copy2(source_video, output_video)
        return

    src_w, src_h, fps, meta_dur = get_video_metadata(source_video)
    target_dur = clip_duration_sec if (clip_duration_sec and clip_duration_sec > 0) else max(0.5, meta_dur - clip_offset_sec)
    if encode.max_fps > 0 and fps > encode.max_fps:
        fps = float(encode.max_fps)

    enc_args = resolve_ffmpeg_video_args(
        encode.codec, encode.hw_encoder, encode.quality_cq, encode.preset_speed, probe
    )
    hw_dec_args = resolve_hw_decode_args(encode.hw_encoder, probe)
    clip_in_args: list[str] = []
    if clip_offset_sec > 0:
        clip_in_args += ["-ss", f"{clip_offset_sec:.3f}"]
    if clip_duration_sec is not None and clip_duration_sec > 0:
        clip_in_args += ["-t", f"{clip_duration_sec:.3f}"]

    vf_parts: list[str] = []
    if encode.max_fps > 0:
        vf_parts.append(f"fps={encode.max_fps}")
    if src_w % 2 != 0 or src_h % 2 != 0:
        vf_parts.append("pad=ceil(iw/2)*2:ceil(ih/2)*2")
    vf_args = ["-vf", ",".join(vf_parts)] if vf_parts else []
    can_copy_audio = (encode.container == "mkv" or src_acodec == "aac") and clip_offset_sec <= 0.05
    audio_args = ["-c:a", "copy"] if can_copy_audio else ["-c:a", "aac", "-b:a", "192k"]

    def _run_transcode(in_hw_args: list[str]) -> tuple[int, str]:
        cmd = [
            ffmpeg_exe, "-y", "-hide_banner", "-loglevel", "error",
            "-threads", "0", "-stats_period", "0.5", "-progress", "pipe:1",
            *in_hw_args,
            *clip_in_args,
            "-i", source_video, *vf_args, *enc_args, *audio_args, *container_args, output_video,
        ]

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc_hook:
            proc_hook(proc, True)
        stderr_chunks: list[bytes] = []

        def drain_err() -> None:
            if proc.stderr is None:
                return
            while True:
                chunk = proc.stderr.read(4096)
                if not chunk:
                    break
                if len(stderr_chunks) < 16:
                    stderr_chunks.append(chunk)

        err_thread = threading.Thread(target=drain_err, daemon=True)
        err_thread.start()
        start_wall = time.monotonic()
        total_us = max(1.0, target_dur * 1_000_000.0)
        cur_fps = 0.0
        cur_speed = ""
        out_us = 0

        try:
            assert proc.stdout is not None
            for raw_line in proc.stdout:
                if cancel_event and cancel_event.is_set():
                    proc.terminate()
                    raise RuntimeError("ジョブがキャンセルされました")
                line = raw_line.decode("utf-8", errors="ignore").strip()
                if "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k == "fps":
                    try:
                        cur_fps = float(v)
                    except Exception:
                        pass
                elif k == "speed":
                    cur_speed = v
                elif k == "out_time_us":
                    try:
                        out_us = int(v)
                    except Exception:
                        pass
                elif k == "progress" and progress_cb:
                    pct = min(0.99, max(0.0, out_us / total_us))
                    elapsed = max(0.1, time.monotonic() - start_wall)
                    eta = int((elapsed / pct) * (1.0 - pct)) if pct > 0.02 else None
                    progress_cb(pct, cur_fps, cur_speed, eta)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
            raise
        finally:
            if proc_hook:
                proc_hook(proc, False)

        ret = proc.wait()
        err_thread.join(timeout=1.0)
        err = b"".join(stderr_chunks).decode("utf-8", errors="ignore")
        return ret, err

    ret, err = _run_transcode(hw_dec_args)
    if ret != 0 and hw_dec_args and not (cancel_event and cancel_event.is_set()):
        ret, err = _run_transcode([])
    if cancel_event and cancel_event.is_set():
        raise RuntimeError("ジョブがキャンセルされました")
    if ret != 0:
        raise RuntimeError(f"FFmpeg出力エラー (code {ret}): {err[-400:]}")


def download_thumbnail_image(
    url: str,
    out_dir: Path,
    base_stem: str,
    thumbnail_url: Optional[str] = None,
) -> Optional[Path]:
    """Download video thumbnail image directly into out_dir alongside output videos."""
    import httpx
    import yt_dlp

    target_url = (thumbnail_url or "").strip()
    if not target_url:
        try:
            cookie_path = get_active_cookie_path()
            opts = _common_ytdlp_opts(cookie_path)
            opts["skip_download"] = True
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False) or {}
            thumbs = info.get("thumbnails") or []
            if thumbs and isinstance(thumbs[-1], dict):
                target_url = str(thumbs[-1].get("url") or info.get("thumbnail") or "")
            else:
                target_url = str(info.get("thumbnail") or "")
        except Exception:
            target_url = ""

    if not target_url.startswith(("http://", "https://")):
        return None

    try:
        with httpx.Client(timeout=15.0, follow_redirects=True) as client:
            resp = client.get(target_url)
            resp.raise_for_status()
            ctype = str(resp.headers.get("content-type") or "").lower()
            ext = "jpg"
            if "png" in ctype or ".png" in target_url.lower():
                ext = "png"
            elif "webp" in ctype or ".webp" in target_url.lower():
                ext = "webp"
            out_dir.mkdir(parents=True, exist_ok=True)
            dest = out_dir / f"{base_stem}_thumb.{ext}"
            idx = 2
            while dest.exists():
                dest = out_dir / f"{base_stem}_thumb_{idx}.{ext}"
                idx += 1
            dest.write_bytes(resp.content)
            return dest
    except Exception:
        return None
