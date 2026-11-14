from __future__ import annotations

import re
import shutil
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Optional

from .chat_parser import (
    extract_twitch_target,
    fetch_twitch_chat_to_file,
    is_twitch_url,
    resolve_twitch_clip_source,
)
from .config import BIN_DIR, BUNDLED_BIN_DIR, get_active_cookie_path
from .ffmpeg_tools import ensure_ffmpeg_in_path, get_media_start_time, get_video_metadata, resolve_ffmpeg_video_args
from .models import EncodeConfig, EncoderProbeResult, FormatOption, VideoInfoResponse
from .tool_updater import detect_js_runtime


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
        "concurrent_fragment_downloads": 16,
        "http_chunk_size": 10 * 1024 * 1024,
        "buffersize": 131072,
        "socket_timeout": 15,
        "retries": 10,
        "fragment_retries": 10,
    }
    if cookie_path:
        opts["cookiefile"] = cookie_path
    rt_name, rt_path = detect_js_runtime()
    if rt_name and rt_path:
        opts["js_runtimes"] = {rt_name: {"path": rt_path}}
    return opts


def probe_video_info(url: str) -> VideoInfoResponse:
    import yt_dlp

    ensure_ffmpeg_in_path()
    cookie_path = get_active_cookie_path()
    ydl_opts = _common_ytdlp_opts(cookie_path)
    ydl_opts["skip_download"] = True
    ydl_opts["extract_flat"] = False

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    if not info:
        raise ValueError("動画情報を取得できませんでした")

    formats_out: list[FormatOption] = []
    resolutions_set: set[int] = set()
    fps_set: set[int] = set()
    preview_candidates: list[tuple[int, int, str]] = []

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
        resolutions_set.add(int(height))
        if fps:
            fps_set.add(int(round(float(fps))))

        if f_url and protocol in ("https", "http", "m3u8_native", "m3u8"):
            # Prefer direct HTTP progressive mp4, then HLS m3u8 around 480p for instant <video> seek
            has_audio = 1 if acodec != "none" else 0
            is_mp4 = 1 if ext == "mp4" else 0
            is_direct_http = 1 if protocol in ("https", "http") else 0
            score = is_direct_http * 3000 + has_audio * 1000 + is_mp4 * 200 - abs(int(height) - 480)
            preview_candidates.append((score, int(height), f_url))

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
    if preview_candidates:
        preview_candidates.sort(key=lambda x: x[0], reverse=True)
        preview_stream_url = preview_candidates[0][2]

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
        webpage_url=str(info.get("webpage_url") or url),
        resolutions=sorted(resolutions_set, reverse=True),
        fps_options=sorted(fps_set, reverse=True),
        formats=formats_out,
    )


def _build_format_selector(resolution: str, max_fps: int) -> str:
    filters: list[str] = []
    if resolution != "best" and resolution.isdigit():
        filters.append(f"height<={resolution}")
    if max_fps > 0:
        filters.append(f"fps<={max_fps}")
    cond = "".join(f"[{c}]" for c in filters)
    return f"bestvideo{cond}+bestaudio/best{cond}/best"


def _build_ffmpeg_input_cmd_part(
    fmt: dict,
    fallback_headers: dict,
    cookiejar,
    clip_start: float,
    fetch_dur: Optional[float],
) -> list[str]:
    f_url = str(fmt["url"])
    part: list[str] = []
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
) -> bool:
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

    def watch_cancel() -> None:
        while not stop_watch.is_set():
            if cancel_check and cancel_check():
                was_cancelled[0] = True
                try:
                    proc.terminate()
                except Exception:
                    pass
                stop_watch.wait(0.6)
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
        while proc.stderr.read(4096):
            pass

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
    if was_cancelled[0] or (cancel_check and cancel_check()):
        raise RuntimeError("Cancelled by user")
    return ret == 0 and out_path.exists() and out_path.stat().st_size > 0


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
        ok = _run_ffmpeg_stream_copy(
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

        def fetch_one(idx: int) -> bool:
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

        if not all(results):
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

    actual_start = get_media_start_time(str(out_mkv))
    trim_offset = max(0.0, s - actual_start)
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

    def hook(d: dict) -> None:
        if cancel_check and cancel_check():
            raise yt_dlp.utils.DownloadCancelled("Cancelled by user")
        status = d.get("status")
        fname = str(d.get("filename") or "").lower()
        info_ext = str((d.get("info_dict") or {}).get("ext") or "").lower()
        is_sub = info_ext in ("json", "vtt", "srt", "ass", "ttml") or ".live_chat." in fname
        if is_sub:
            if status == "finished" and progress_cb:
                progress_cb(0.03, "ライブチャットデータを取得しました")
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
    ydl_opts = _common_ytdlp_opts(cookie_path)
    ydl_opts.update(
        {
            "format": _build_format_selector(encode.resolution, encode.max_fps),
            "outtmpl": outtmpl,
            "merge_output_format": encode.container,
            "progress_hooks": [hook],
            "postprocessor_hooks": [pp_hook],
        }
    )

    twitch_mode = is_twitch_url(url)

    if ffmpeg_exe:
        ydl_opts["ffmpeg_location"] = str(Path(ffmpeg_exe).parent)

    if need_chat and not twitch_mode:
        ydl_opts["writesubtitles"] = True
        ydl_opts["subtitleslangs"] = ["live_chat"]

    is_clipped = (clip_start_sec is not None and clip_start_sec > 0) or (
        clip_end_sec is not None and clip_end_sec > 0
    )

    trim_offset_sec = 0.0
    trim_duration_sec: Optional[float] = None
    video_path: Optional[Path] = None
    chat_path: Optional[Path] = None
    twitch_chat_dest = work_dir / "source.twitch_chat.json"

    def dl_chat_worker() -> None:
        if not need_chat:
            return
        if twitch_mode:
            fetch_twitch_chat_to_file(
                url,
                twitch_chat_dest,
                clip_start_sec,
                clip_end_sec,
                progress_cb,
                cancel_check,
            )
            return
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
        with yt_dlp.YoutubeDL(chat_opts) as cydl:
            cydl.download([url])

    if is_clipped:
        if not ffmpeg_exe:
            raise RuntimeError("区間切り抜きにはFFmpegが必要ですが、見つかりません。設定画面からFFmpegを導入してください。")
        s = float(clip_start_sec or 0.0)
        e = float(clip_end_sec) if clip_end_sec is not None else float("inf")
        if e > s:
            if progress_cb:
                progress_cb(0.02, "切り抜き用ストリーム情報を取得中...")
            probe_opts = dict(ydl_opts)
            probe_opts["skip_download"] = True
            probe_opts.pop("writesubtitles", None)
            with yt_dlp.YoutubeDL(probe_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                cj = ydl.cookiejar

            with ThreadPoolExecutor(max_workers=2 if need_chat else 1) as dl_pool:
                chat_fut = dl_pool.submit(dl_chat_worker) if need_chat else None
                clip_fut = dl_pool.submit(
                    _direct_ffmpeg_clip_download,
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
                direct = clip_fut.result()
                if chat_fut:
                    chat_fut.result()

            if direct is not None:
                video_path, trim_offset_sec, trim_duration_sec = direct
            else:
                # Fallback to yt-dlp FFmpegFD stream copy (no CPU re-encode)
                ydl_opts["download_ranges"] = download_range_func(None, [(s, e)])
                ydl_opts["force_keyframes_at_cuts"] = False
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.download([url])
        else:
            with ThreadPoolExecutor(max_workers=2 if (need_chat and twitch_mode) else 1) as dl_pool:
                chat_fut = dl_pool.submit(dl_chat_worker) if (need_chat and twitch_mode) else None
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.download([url])
                if chat_fut:
                    chat_fut.result()
    else:
        aria2c = _find_aria2c()
        if aria2c:
            ydl_opts["external_downloader"] = {"http": aria2c, "https": aria2c}
            ydl_opts["external_downloader_args"] = {
                "aria2c": ["-x", "16", "-s", "16", "-k", "1M", "--file-allocation=none"]
            }
        with ThreadPoolExecutor(max_workers=2 if (need_chat and twitch_mode) else 1) as dl_pool:
            chat_fut = dl_pool.submit(dl_chat_worker) if (need_chat and twitch_mode) else None
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
            if chat_fut:
                chat_fut.result()

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

    if src_ext == encode.container and encode.max_fps == 0 and not has_trim:
        cmd = [
            ffmpeg_exe, "-y", "-hide_banner", "-loglevel", "error",
            "-i", source_video, "-c", "copy", "-movflags", "+faststart", output_video,
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

    _, _, fps, meta_dur = get_video_metadata(source_video)
    target_dur = clip_duration_sec if (clip_duration_sec and clip_duration_sec > 0) else max(0.5, meta_dur - clip_offset_sec)
    if encode.max_fps > 0 and fps > encode.max_fps:
        fps = float(encode.max_fps)

    enc_args = resolve_ffmpeg_video_args(
        encode.codec, encode.hw_encoder, encode.quality_cq, encode.preset_speed, probe
    )
    clip_in_args: list[str] = []
    if clip_offset_sec > 0:
        clip_in_args += ["-ss", f"{clip_offset_sec:.3f}"]
    if clip_duration_sec is not None and clip_duration_sec > 0:
        clip_in_args += ["-t", f"{clip_duration_sec:.3f}"]

    vf_args = ["-vf", f"fps={encode.max_fps}"] if encode.max_fps > 0 else []
    audio_args = ["-c:a", "copy"] if encode.container == "mkv" else ["-c:a", "aac", "-b:a", "192k"]
    cmd = [
        ffmpeg_exe, "-y", "-hide_banner", "-loglevel", "error",
        "-stats_period", "0.5", "-progress", "pipe:1",
        *clip_in_args,
        "-i", source_video, *vf_args, *enc_args, *audio_args, "-movflags", "+faststart", output_video,
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
    if cancel_event and cancel_event.is_set():
        raise RuntimeError("ジョブがキャンセルされました")
    if ret != 0:
        err = b"".join(stderr_chunks).decode("utf-8", errors="ignore")
        raise RuntimeError(f"FFmpeg出力エラー (code {ret}): {err[-400:]}")
