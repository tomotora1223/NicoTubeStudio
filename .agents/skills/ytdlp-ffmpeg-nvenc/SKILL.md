---
name: ytdlp-ffmpeg-nvenc
description: Specifications for yt-dlp video/chat extraction, time-range clipping, cookie authentication, and FFmpeg hardware-accelerated (NVENC/QSV/AMF) raw-RGBA danmaku overlay pipeline.
---

# yt-dlp & FFmpeg Hardware-Accelerated Pipeline

## 1. yt-dlp Extraction & Clipping

- Always support optional `cookiefile` (Netscape format exported from built-in Electron auth window or user-supplied `cookies.txt`).
- **Metadata Probe**:
  - `extract_info(url, download=False)` with `skip_download=True` to retrieve:
    - `id`, `title`, `uploader`, `channel_id`, `duration`, `is_live`, `was_live`, `thumbnail`
    - `formats` grouped cleanly by resolution (`2160p`, `1440p`, `1080p`, `720p`, `480p`, `360p`), `fps`, `vcodec`, `acodec`, `ext`
    - `subtitles` / `automatic_captions` check for `live_chat` availability.
- **Time-Range Clipping**:
  - When `clip_start` or `clip_end` is specified:
    - Use `download_ranges` (`yt_dlp.utils.download_range_func(None, [(clip_start, clip_end)])`) + `force_keyframes_at_cuts=True` for precise video cuts.
    - Download `live_chat` JSON separately or alongside (`writesubtitles=True`, `subtitleslangs=['live_chat']`). Note: `live_chat` JSON always covers the full stream timeline (`videoOffsetTimeMsec`), so our comment parser filters `[clip_start, clip_end]` and subtracts `clip_start`.

## 2. FFmpeg Detection & Hardware Encoder Probing

- Search order for `ffmpeg.exe` / `ffprobe.exe`:
  1. App-bundled `<app_root>/bin/ffmpeg.exe` (or `%LOCALAPPDATA%/NicoTubeStudio/bin/ffmpeg.exe`)
  2. System `PATH` (`shutil.which("ffmpeg")`)
- Provide one-click automatic download of Windows FFmpeg release (`gyan.dev` essentials/full or `BtbN/FFmpeg-Builds`) into local app `bin/` if missing.
- **Encoder Probe** (`ffmpeg -hide_banner -encoders` + tiny 1-frame test encode with `lavfi` `color=c=black:s=256x256:d=0.1`):
  - H.264: `h264_nvenc` (NVIDIA), `h264_qsv` (Intel), `h264_amf` (AMD), `libx264` (CPU fallback)
  - H.265 / HEVC: `hevc_nvenc`, `hevc_qsv`, `hevc_amf`, `libx265`
  - AV1: `av1_nvenc`, `av1_qsv`, `av1_amf`, `libsvtav1`
  - Verify actual hardware initialization by running a dummy 1-frame test (because `ffmpeg -encoders` lists encoders even when the GPU driver isn't present).

## 3. High-Speed Danmaku Burn-in Pipeline (B-Plan)

- **Comment Sprite Caching**:
  - Pre-render each unique comment (text + color emoji + cached channel emote PNGs + outline/shadow + optional Super Chat pill) **once** into a compact RGBA Skia `Image` / buffer.
- **Frame Compositing & Pipe**:
  - Open `ffmpeg` subprocess with two inputs:
    - Input 0: Downloaded source video (`-i source.mp4`)
    - Input 1: Raw RGBA comment overlay stream via `stdin` pipe (`-f rawvideo -pix_fmt bgra -s {W}x{H} -r {fps} -i pipe:0`)
  - Filter graph: `[0:v][1:v]overlay=0:0:shortest=1[v]` (or `format=yuv420p` before hardware encoder).
  - **Idle Frame Optimization**: When zero comments are visible on a frame, reuse a pre-allocated zero-byte transparent buffer (`bytes(W * H * 4)`) so `stdin.write()` has virtually zero CPU cost!
  - Audio stream: Copy (`-c:a copy`) if compatible with output container (`mp4`/`mkv`), otherwise `-c:a aac -b:a 192k`.
  - Progress tracking: Parse `ffmpeg -progress pipe:1` (`out_time_us`, `fps`, `speed`) to stream real-time percentage, encoding FPS, and ETA over WebSocket to the UI queue.
