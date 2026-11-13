from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from .models import AppSettings, CommentStyleConfig, Preset, SuperChatMode, CollisionMode

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("NICOTUBE_DATA_DIR") or (BASE_DIR / "data"))
BUNDLED_BIN_DIR = Path(os.environ.get("NICOTUBE_BUNDLED_BIN_DIR") or (BASE_DIR / "bin"))
BIN_DIR = DATA_DIR / "bin" if os.environ.get("NICOTUBE_DATA_DIR") else (BASE_DIR / "bin")
TEMP_DIR = DATA_DIR / "temp"
EMOTE_CACHE_DIR = DATA_DIR / "cache" / "emotes"
YTDLP_LIVE_DIR = DATA_DIR / "ytdlp_live"
TOOL_META_FILE = DATA_DIR / "tool_versions.json"
SETTINGS_FILE = DATA_DIR / "settings.json"
PRESETS_FILE = DATA_DIR / "presets.json"
SHARED_STYLES_FILE = DATA_DIR / "shared_styles.json"
COOKIE_FILE = DATA_DIR / "cookies.txt"
AUTH_META_FILE = DATA_DIR / "auth_meta.json"

DEFAULT_OUTPUT_DIR = str(Path.home() / "Videos" / "NicoTubeStudio")

BUILTIN_PRESETS: list[Preset] = [
    Preset(
        id="niconico-official",
        name="ニコニコ純正 (標準)",
        description="ニコニコ公式HTML5プレイヤー準拠の基準スケール・4秒スクロール・全画面表示",
        is_builtin=True,
        config=CommentStyleConfig(
            font_family="Yu Gothic UI",
            font_weight=600,
            font_scale=1.0,
            opacity=0.85,
            scroll_duration_sec=4.0,
            fixed_duration_sec=3.0,
            outline_width=2.0,
            outline_opacity=0.88,
            shadow_enabled=True,
            display_area_ratio=1.0,
            line_height_ratio=1.22,
            collision_mode=CollisionMode.DANMAKU,
            max_concurrent=80,
            lane_gap_px=16,
            member_color_enabled=True,
            member_color="#5CE68A",
            moderator_color_enabled=True,
            moderator_color="#6BA5FF",
            owner_color_enabled=True,
            owner_color="#FFD447",
            owner_pin_top=True,
            superchat_mode=SuperChatMode.CARD_SCROLL,
            superchat_show_amount=True,
            superchat_scale=1.05,
            membership_events_enabled=True,
            custom_emotes_enabled=True,
            unicode_emoji_enabled=True,
        ),
    ),
    Preset(
        id="readable-upper",
        name="配信アーカイブ向け (上半分・見やすさ重視)",
        description="画面下部のゲームUIや字幕を隠さず、上60%に少し落ち着いた速度で表示",
        is_builtin=True,
        config=CommentStyleConfig(
            font_family="Yu Gothic UI",
            font_weight=600,
            font_scale=0.92,
            opacity=0.80,
            scroll_duration_sec=5.2,
            fixed_duration_sec=3.5,
            outline_width=2.2,
            outline_opacity=0.90,
            shadow_enabled=True,
            display_area_ratio=0.60,
            line_height_ratio=1.26,
            collision_mode=CollisionMode.STAGGER,
            max_concurrent=45,
            lane_gap_px=24,
            member_color_enabled=True,
            member_color="#5CE68A",
            moderator_color_enabled=True,
            moderator_color="#6BA5FF",
            owner_color_enabled=True,
            owner_color="#FFD447",
            owner_pin_top=True,
            superchat_mode=SuperChatMode.CARD_TOP,
            superchat_show_amount=True,
            superchat_scale=1.0,
            membership_events_enabled=True,
            custom_emotes_enabled=True,
            unicode_emoji_enabled=True,
        ),
    ),
    Preset(
        id="classic-niconico",
        name="クラシック弾幕 (MS Pゴシック・高密度)",
        description="往年の弾幕雰囲気を再現するMS Pゴシック・速めスクロール・高密度設定",
        is_builtin=True,
        config=CommentStyleConfig(
            font_family="MS PGothic",
            font_weight=600,
            font_scale=1.05,
            opacity=0.88,
            scroll_duration_sec=3.6,
            fixed_duration_sec=3.0,
            outline_width=1.8,
            outline_opacity=0.92,
            shadow_enabled=False,
            display_area_ratio=1.0,
            line_height_ratio=1.15,
            collision_mode=CollisionMode.DANMAKU,
            max_concurrent=120,
            lane_gap_px=8,
            member_color_enabled=False,
            moderator_color_enabled=True,
            owner_color_enabled=True,
            owner_pin_top=True,
            superchat_mode=SuperChatMode.TEXT_COLOR,
            superchat_show_amount=True,
            superchat_scale=1.1,
            membership_events_enabled=True,
            custom_emotes_enabled=True,
            unicode_emoji_enabled=True,
        ),
    ),
]


def ensure_dirs() -> None:
    for d in (DATA_DIR, BIN_DIR, TEMP_DIR, EMOTE_CACHE_DIR, YTDLP_LIVE_DIR):
        d.mkdir(parents=True, exist_ok=True)


def load_settings() -> AppSettings:
    ensure_dirs()
    if SETTINGS_FILE.exists():
        try:
            data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            return AppSettings(**data)
        except Exception:
            pass
    settings = AppSettings(output_dir=DEFAULT_OUTPUT_DIR)
    save_settings(settings)
    return settings


def save_settings(settings: AppSettings) -> AppSettings:
    ensure_dirs()
    Path(settings.output_dir).mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(
        settings.model_dump_json(indent=2), encoding="utf-8"
    )
    return settings


def load_presets() -> list[Preset]:
    ensure_dirs()
    custom: list[Preset] = []
    if PRESETS_FILE.exists():
        try:
            raw = json.loads(PRESETS_FILE.read_text(encoding="utf-8"))
            custom = [Preset(**item) for item in raw if not item.get("is_builtin")]
        except Exception:
            custom = []
    return [*BUILTIN_PRESETS, *custom]


def save_custom_presets(presets: list[Preset]) -> None:
    ensure_dirs()
    custom_only = [p.model_dump() for p in presets if not p.is_builtin]
    PRESETS_FILE.write_text(
        json.dumps(custom_only, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def get_active_cookie_path() -> Optional[str]:
    if COOKIE_FILE.exists() and COOKIE_FILE.stat().st_size > 20:
        return str(COOKIE_FILE)
    return None
