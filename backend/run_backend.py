from __future__ import annotations

import os
import sys
import traceback
from pathlib import Path

if getattr(sys, "frozen", False):
    base_dir = os.path.dirname(sys.executable)
else:
    base_dir = os.path.dirname(os.path.abspath(__file__))

if base_dir not in sys.path:
    sys.path.insert(0, base_dir)

data_dir = Path(os.environ.get("NICOTUBE_DATA_DIR") or (Path(base_dir) / "data"))
data_dir.mkdir(parents=True, exist_ok=True)

# Prefer auto-updated yt-dlp live wheel directory over frozen copy
ytdlp_live = data_dir / "ytdlp_live"
if ytdlp_live.exists() and (ytdlp_live / "yt_dlp").exists():
    if str(ytdlp_live) not in sys.path:
        sys.path.insert(0, str(ytdlp_live))

# Ensure bundled / user bin directories are on PATH for yt-dlp FFmpegFD
for bin_env in ("NICOTUBE_BUNDLED_BIN_DIR",):
    bdir = os.environ.get(bin_env)
    if bdir and os.path.isdir(bdir) and bdir not in os.environ.get("PATH", ""):
        os.environ["PATH"] = bdir + os.pathsep + os.environ.get("PATH", "")

user_bin = data_dir / "bin"
if user_bin.is_dir() and str(user_bin) not in os.environ.get("PATH", ""):
    os.environ["PATH"] = str(user_bin) + os.pathsep + os.environ.get("PATH", "")

log_path = data_dir / "backend.log"

if sys.stdout is None or sys.stderr is None:
    log_file = open(log_path, "a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = log_file
    if sys.stderr is None:
        sys.stderr = log_file


def main() -> None:
    try:
        import uvicorn
        from app.main import app

        port = int(os.environ.get("NICOTUBE_PORT", "18742"))
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            log_config=None,
            access_log=False,
        )
    except Exception:
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(traceback.format_exc() + "\n")
        raise


if __name__ == "__main__":
    main()
