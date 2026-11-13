# NicoTube Studio — Project Instructions

This project is a Windows desktop application that downloads YouTube livestreams/clips via `yt-dlp` and optionally composites Niconico-authentic scrolling danmaku comments (with YouTube Super Chats, member highlights, Unicode color emojis, and custom channel emotes) using hardware-accelerated FFmpeg encoding.

## Skills in `.agents/skills/`

Always consult and follow the project skills before modifying their respective domains:
- `unslop` (`.agents/skills/unslop/SKILL.md`): UI craft discipline — quiet neutral chrome, 4px spacing grid, single accent, Lucide line icons, tabular figures, no gradients/glows/emoji UI icons.
- `material3-craft` (`.agents/skills/material3-craft/SKILL.md`): Material Design 3 tonal surface hierarchy, Graphite ramp tokens, nested radii, and motion curve.
- `niconico-danmaku` (`.agents/skills/niconico-danmaku/SKILL.md`): Niconico HTML5 virtual stage (`640×360` scaling), collision prevention math, Super Chat tier colors, and YouTube Live Chat JSON mapping.
- `ytdlp-ffmpeg-nvenc` (`.agents/skills/ytdlp-ffmpeg-nvenc/SKILL.md`): `yt-dlp` range clipping, cookie usage, FFmpeg encoder probing (`NVENC`/`QSV`/`AMF`), and high-speed Skia RGBA pipe compositing.
- `electron-python-ipc` (`.agents/skills/electron-python-ipc/SKILL.md`): Electron main/preload lifecycle, FastAPI/WebSocket IPC, and persistent `BrowserWindow` Google/YouTube login cookie export.
