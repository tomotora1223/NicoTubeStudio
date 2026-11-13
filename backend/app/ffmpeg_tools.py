from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Callable, Optional

import httpx

from .config import BIN_DIR, BUNDLED_BIN_DIR, TOOL_META_FILE
from .models import EncoderProbeResult

FFMPEG_RELEASE_ZIP_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"

_cached_probe: Optional[EncoderProbeResult] = None


def ensure_ffmpeg_in_path() -> Optional[str]:
    """Ensure the active ffmpeg/ffprobe directory is prepended to PATH for yt-dlp FFmpegFD."""
    ff = find_ffmpeg()
    if ff:
        ff_dir = str(Path(ff).parent)
        cur_path = os.environ.get("PATH", "")
        parts = cur_path.split(os.pathsep) if cur_path else []
        if ff_dir not in parts:
            os.environ["PATH"] = ff_dir + os.pathsep + cur_path
    return ff


def find_ffmpeg() -> Optional[str]:
    # Prefer user BIN_DIR (auto-updated) over bundled BUNDLED_BIN_DIR
    for d in (BIN_DIR, BUNDLED_BIN_DIR):
        cand = d / "ffmpeg.exe"
        if cand.exists():
            return str(cand)
    which = shutil.which("ffmpeg")
    if which:
        return which
    for candidate in (
        Path("C:/ffmpeg/bin/ffmpeg.exe"),
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Links/ffmpeg.exe",
    ):
        if candidate.exists():
            return str(candidate)
    return None


def find_ffprobe() -> Optional[str]:
    for d in (BIN_DIR, BUNDLED_BIN_DIR):
        cand = d / "ffprobe.exe"
        if cand.exists():
            return str(cand)
    which = shutil.which("ffprobe")
    if which:
        return which
    for candidate in (
        Path("C:/ffmpeg/bin/ffprobe.exe"),
        Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Links/ffprobe.exe",
    ):
        if candidate.exists():
            return str(candidate)
    return None


def get_ffmpeg_version() -> str:
    ff = find_ffmpeg()
    if not ff:
        return "未導入"
    try:
        res = subprocess.run(
            [ff, "-version"],
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        first = (res.stdout or "").splitlines()[0] if res.stdout else ""
        m = re.search(r"ffmpeg version\s+([^\s-]+)", first)
        if m:
            return m.group(1)
    except Exception:
        pass
    return "導入済み"


def _test_encoder(ffmpeg_path: str, encoder: str) -> bool:
    """Actually initialize the encoder on a 1-frame dummy input to verify GPU driver support."""
    try:
        cmd = [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=256x256:r=30:d=0.1",
            "-c:v",
            encoder,
            "-f",
            "null",
            "-",
        ]
        res = subprocess.run(
            cmd,
            capture_output=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return res.returncode == 0
    except Exception:
        return False


def probe_encoders(force: bool = False) -> EncoderProbeResult:
    global _cached_probe
    if _cached_probe is not None and not force:
        return _cached_probe

    ffmpeg_path = ensure_ffmpeg_in_path()
    ffprobe_path = find_ffprobe()
    if not ffmpeg_path:
        _cached_probe = EncoderProbeResult(
            ffmpeg_found=False,
            ffmpeg_path=None,
            ffprobe_path=ffprobe_path,
            available_hw=[],
            encoders_by_codec={},
            recommended_hw="cpu",
        )
        return _cached_probe

    candidates = {
        "h264": ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"],
        "h265": ["hevc_nvenc", "hevc_qsv", "hevc_amf", "libx265"],
        "av1": ["av1_nvenc", "av1_qsv", "av1_amf", "libsvtav1"],
    }

    try:
        listed = subprocess.run(
            [ffmpeg_path, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            timeout=6,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except Exception:
        listed = ""

    encoders_by_codec: dict[str, list[str]] = {"h264": [], "h265": [], "av1": []}
    hw_found: set[str] = set()

    for codec, enc_list in candidates.items():
        for enc in enc_list:
            if enc not in listed:
                continue
            if enc.startswith(("libx", "libsvt")):
                encoders_by_codec[codec].append(enc)
            elif _test_encoder(ffmpeg_path, enc):
                encoders_by_codec[codec].append(enc)
                if "nvenc" in enc:
                    hw_found.add("nvenc")
                elif "qsv" in enc:
                    hw_found.add("qsv")
                elif "amf" in enc:
                    hw_found.add("amf")

    ordered_hw = [h for h in ("nvenc", "qsv", "amf") if h in hw_found]
    recommended = ordered_hw[0] if ordered_hw else "cpu"

    _cached_probe = EncoderProbeResult(
        ffmpeg_found=True,
        ffmpeg_path=ffmpeg_path,
        ffprobe_path=ffprobe_path,
        available_hw=ordered_hw,
        encoders_by_codec=encoders_by_codec,
        recommended_hw=recommended,
    )
    return _cached_probe


async def download_ffmpeg(
    progress_cb: Optional[Callable[[float, str], None]] = None,
    version_tag: Optional[str] = None,
) -> EncoderProbeResult:
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    tmp_zip = BIN_DIR / "ffmpeg_download.zip"

    if progress_cb:
        progress_cb(0.02, "FFmpegビルドをダウンロード中...")

    async with httpx.AsyncClient(follow_redirects=True, timeout=240.0) as client:
        async with client.stream("GET", FFMPEG_RELEASE_ZIP_URL) as resp:
            resp.raise_for_status()
            total = int(resp.headers.get("content-length") or 0)
            downloaded = 0
            with open(tmp_zip, "wb") as f:
                async for chunk in resp.aiter_bytes(chunk_size=1024 * 256):
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total > 0 and progress_cb:
                        pct = min(0.85, 0.05 + 0.80 * (downloaded / total))
                        progress_cb(pct, f"FFmpegをダウンロード中... ({downloaded // (1024*1024)} MB)")

    if progress_cb:
        progress_cb(0.88, "FFmpegを展開中...")

    with zipfile.ZipFile(tmp_zip, "r") as zf:
        for member in zf.namelist():
            low = member.lower()
            if low.endswith("/bin/ffmpeg.exe") or low.endswith("/bin/ffprobe.exe"):
                filename = Path(member).name
                target = BIN_DIR / filename
                tmp_target = BIN_DIR / f"{filename}.new"
                with zf.open(member) as src, open(tmp_target, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                tmp_target.replace(target)

    try:
        tmp_zip.unlink(missing_ok=True)
    except Exception:
        pass

    if version_tag:
        try:
            meta = json.loads(TOOL_META_FILE.read_text(encoding="utf-8")) if TOOL_META_FILE.exists() else {}
            meta["ffmpeg_version"] = version_tag
            TOOL_META_FILE.write_text(json.dumps(meta, indent=2), encoding="utf-8")
        except Exception:
            pass

    if progress_cb:
        progress_cb(0.95, "ハードウェアエンコーダを検証中...")

    ensure_ffmpeg_in_path()
    result = probe_encoders(force=True)
    if progress_cb:
        progress_cb(1.0, "FFmpegの準備が完了しました")
    return result


def get_video_metadata(video_path: str) -> tuple[int, int, float, float]:
    """Return (width, height, fps, duration_sec) using ffprobe."""
    ffprobe = find_ffprobe()
    if not ffprobe:
        return 1920, 1080, 30.0, 0.0

    cmd = [
        ffprobe,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        video_path,
    ]
    res = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    data = json.loads(res.stdout or "{}")
    width, height, fps, duration = 1920, 1080, 30.0, 0.0

    fmt = data.get("format") or {}
    if fmt.get("duration"):
        try:
            duration = float(fmt["duration"])
        except Exception:
            pass

    for stream in data.get("streams", []):
        if stream.get("codec_type") == "video":
            width = int(stream.get("width") or 1920)
            height = int(stream.get("height") or 1080)
            r_fps = stream.get("avg_frame_rate") or stream.get("r_frame_rate") or "30/1"
            try:
                num, den = r_fps.split("/")
                val = float(num) / max(1.0, float(den))
                if 1.0 <= val <= 240.0:
                    fps = val
            except Exception:
                pass
            if not duration and stream.get("duration"):
                try:
                    duration = float(stream["duration"])
                except Exception:
                    pass
            break

    return width, height, fps, duration


def get_media_start_time(video_path: str) -> float:
    """Return container format start_time in seconds (useful after -c copy -copyts)."""
    ffprobe = find_ffprobe()
    if not ffprobe:
        return 0.0
    cmd = [
        ffprobe,
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        video_path,
    ]
    res = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    try:
        data = json.loads(res.stdout or "{}")
        st = (data.get("format") or {}).get("start_time")
        return float(st) if st is not None else 0.0
    except Exception:
        return 0.0


def resolve_ffmpeg_video_args(
    codec: str,
    hw_encoder: str,
    quality_cq: int,
    preset_speed: str,
    probe: EncoderProbeResult,
) -> list[str]:
    """Build hardware/software video encoder flags for FFmpeg."""
    chosen_hw = hw_encoder
    if chosen_hw == "auto":
        chosen_hw = probe.recommended_hw

    avail = probe.encoders_by_codec.get(codec, [])

    def pick(prefix_map: dict[str, str], fallback: str) -> str:
        target = prefix_map.get(chosen_hw)
        if target and target in avail:
            return target
        for cand in avail:
            return cand
        return fallback

    if codec == "h264":
        enc = pick({"nvenc": "h264_nvenc", "qsv": "h264_qsv", "amf": "h264_amf"}, "libx264")
    elif codec == "h265":
        enc = pick({"nvenc": "hevc_nvenc", "qsv": "hevc_qsv", "amf": "hevc_amf"}, "libx265")
    else:
        enc = pick({"nvenc": "av1_nvenc", "qsv": "av1_qsv", "amf": "av1_amf"}, "libsvtav1")

    if "nvenc" in enc:
        p_map = {"fast": "p3", "medium": "p5", "slow": "p6"}
        return [
            "-c:v", enc,
            "-preset", p_map.get(preset_speed, "p5"),
            "-rc", "vbr",
            "-cq", str(quality_cq),
            "-b:v", "0",
            "-pix_fmt", "yuv420p",
        ]
    if "qsv" in enc:
        p_map = {"fast": "veryfast", "medium": "medium", "slow": "veryslow"}
        return [
            "-c:v", enc,
            "-preset", p_map.get(preset_speed, "medium"),
            "-global_quality", str(quality_cq),
            "-pix_fmt", "yuv420p",
        ]
    if "amf" in enc:
        q_map = {"fast": "speed", "medium": "balanced", "slow": "quality"}
        return [
            "-c:v", enc,
            "-quality", q_map.get(preset_speed, "balanced"),
            "-rc", "qvbr",
            "-qvbr_quality_level", str(quality_cq),
            "-pix_fmt", "yuv420p",
        ]

    # CPU fallback
    if enc == "libsvtav1":
        p_map = {"fast": "8", "medium": "6", "slow": "4"}
        return ["-c:v", enc, "-preset", p_map.get(preset_speed, "6"), "-crf", str(quality_cq), "-pix_fmt", "yuv420p"]
    return ["-c:v", enc, "-preset", preset_speed, "-crf", str(quality_cq), "-pix_fmt", "yuv420p"]
