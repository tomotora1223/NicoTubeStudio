from __future__ import annotations

from enum import Enum
from typing import Literal, Optional
from pydantic import BaseModel, Field


class CollisionMode(str, Enum):
    DANMAKU = "danmaku"
    DROP = "drop"
    STAGGER = "stagger"


class SuperChatMode(str, Enum):
    CARD_SCROLL = "card_scroll"
    CARD_TOP = "card_top"
    TEXT_COLOR = "text_color"
    HIDE = "hide"


class EventDisplayMode(str, Enum):
    FOLLOW_SUPERCHAT = "follow_superchat"
    CARD_SCROLL = "card_scroll"
    CARD_TOP = "card_top"
    TEXT_COLOR = "text_color"
    HIDE = "hide"


class RoleDisplayMode(str, Enum):
    COLOR = "color"
    NORMAL = "normal"
    HIDE = "hide"


class OutputMode(str, Enum):
    WITH_COMMENTS = "with_comments"
    VIDEO_ONLY = "video_only"
    BOTH = "both"


class EventPosition(str, Enum):
    NAKA = "naka"
    UE = "ue"
    SHITA = "shita"


DEFAULT_SUPERCHAT_TIER_COLORS: dict[str, str] = {
    "blue": "#1E88E5",
    "lightblue": "#00B8D4",
    "green": "#00BFA5",
    "yellow": "#FFB300",
    "orange": "#E65100",
    "magenta": "#C2185B",
    "red": "#D00000",
}


class CommentStyleConfig(BaseModel):
    # Niconico Core Layout
    font_family: str = "Yu Gothic UI"
    font_weight: int = Field(default=600, ge=100, le=900)
    font_scale: float = Field(default=1.0, ge=0.5, le=2.5)
    opacity: float = Field(default=0.85, ge=0.1, le=1.0)
    scroll_duration_sec: float = Field(default=4.0, ge=1.5, le=12.0)
    fixed_duration_sec: float = Field(default=3.0, ge=1.0, le=10.0)

    # Outline & Shadow
    outline_width: float = Field(default=2.0, ge=0.0, le=8.0)
    outline_color: str = "#000000"
    outline_opacity: float = Field(default=0.88, ge=0.0, le=1.0)
    outline2_width: float = Field(default=0.0, ge=0.0, le=6.0)
    outline2_color: str = "#FFFFFF"
    outline2_opacity: float = Field(default=0.65, ge=0.0, le=1.0)

    shadow_enabled: bool = True
    shadow_color: str = "#000000"
    shadow_opacity: float = Field(default=0.55, ge=0.0, le=1.0)
    shadow_blur: float = Field(default=0.0, ge=0.0, le=12.0)
    shadow_offset_x: float = Field(default=1.5, ge=-10.0, le=10.0)
    shadow_offset_y: float = Field(default=1.5, ge=-10.0, le=10.0)

    display_area_ratio: float = Field(default=1.0, ge=0.2, le=1.0)
    line_height_ratio: float = Field(default=1.22, ge=1.0, le=1.8)
    collision_mode: CollisionMode = CollisionMode.DANMAKU
    max_concurrent: int = Field(default=80, ge=0, le=300)
    lane_gap_px: int = Field(default=16, ge=0, le=120)
    ng_words: list[str] = Field(default_factory=list)

    # YouTube Mapping — Roles
    default_color: str = "#FFFFFF"
    normal_pin_mode: Literal["naka", "ue", "shita"] = "naka"

    member_color_enabled: bool = True
    member_color: str = "#5CE68A"
    member_badge_prefix: bool = False
    member_badge_text: str = "[M]"
    member_scale: float = Field(default=1.0, ge=0.6, le=1.8)
    member_pin_mode: Literal["naka", "ue", "shita"] = "naka"

    moderator_mode: RoleDisplayMode = RoleDisplayMode.COLOR
    moderator_color_enabled: bool = True
    moderator_color: str = "#6BA5FF"
    moderator_badge_prefix: bool = False
    moderator_badge_text: str = "[Mod]"
    moderator_scale: float = Field(default=1.0, ge=0.6, le=1.8)
    moderator_pin_mode: Literal["naka", "ue", "shita"] = "naka"

    owner_color_enabled: bool = True
    owner_color: str = "#FFD447"
    owner_pin_top: bool = True
    owner_pin_mode: Literal["naka", "ue", "shita"] = "ue"
    owner_badge_prefix: bool = False
    owner_badge_text: str = "[配信者]"
    owner_scale: float = Field(default=1.05, ge=0.6, le=1.8)

    # YouTube Mapping — Special Events & Cards
    superchat_mode: SuperChatMode = SuperChatMode.CARD_SCROLL
    superchat_show_amount: bool = True
    superchat_scale: float = Field(default=1.05, ge=0.7, le=1.6)
    superchat_speed_multiplier: float = Field(default=1.0, ge=0.5, le=2.0)
    superchat_color_source: Literal["official", "youtube_raw", "custom"] = "official"
    superchat_tier_colors: dict[str, str] = Field(
        default_factory=lambda: dict(DEFAULT_SUPERCHAT_TIER_COLORS)
    )

    card_opacity: float = Field(default=0.92, ge=0.25, le=1.0)
    card_radius_px: float = Field(default=7.0, ge=0.0, le=20.0)
    card_border_opacity: float = Field(default=0.28, ge=0.0, le=1.0)

    supersticker_mode: EventDisplayMode = EventDisplayMode.FOLLOW_SUPERCHAT
    supersticker_scale: float = Field(default=1.05, ge=0.7, le=1.6)
    membership_mode: EventDisplayMode = EventDisplayMode.CARD_SCROLL
    membership_color: str = "#0F9D58"
    membership_scale: float = Field(default=0.96, ge=0.7, le=1.6)
    gift_mode: EventDisplayMode = EventDisplayMode.CARD_SCROLL
    gift_color: str = "#0F9D58"
    gift_scale: float = Field(default=0.96, ge=0.7, le=1.6)
    membership_events_enabled: bool = True  # legacy fallback compatibility

    custom_emotes_enabled: bool = True
    unicode_emoji_enabled: bool = True


class Preset(BaseModel):
    id: str
    name: str
    description: str = ""
    is_builtin: bool = False
    config: CommentStyleConfig


class PresetCreate(BaseModel):
    name: str
    description: str = ""
    config: CommentStyleConfig


class FormatOption(BaseModel):
    format_id: str
    resolution: str
    width: Optional[int] = None
    height: Optional[int] = None
    fps: Optional[float] = None
    vcodec: Optional[str] = None
    acodec: Optional[str] = None
    ext: str = "mp4"
    filesize_approx: Optional[int] = None


class VideoProbeRequest(BaseModel):
    url: str


class VideoInfoResponse(BaseModel):
    id: str
    title: str
    uploader: str
    channel_id: Optional[str] = None
    platform: str = "youtube"
    duration_sec: float = 0.0
    is_live: bool = False
    was_live: bool = False
    has_live_chat: bool = False
    thumbnail: Optional[str] = None
    preview_stream_url: Optional[str] = None
    webpage_url: str
    resolutions: list[int] = Field(default_factory=list)
    fps_options: list[int] = Field(default_factory=list)
    formats: list[FormatOption] = Field(default_factory=list)


class EncodeConfig(BaseModel):
    output_mode: OutputMode = OutputMode.WITH_COMMENTS
    resolution: str = "1080"
    max_fps: int = 60
    codec: Literal["h264", "h265", "av1"] = "h264"
    hw_encoder: Literal["auto", "nvenc", "qsv", "amf", "cpu"] = "auto"
    quality_cq: int = Field(default=20, ge=12, le=34)
    preset_speed: Literal["fast", "medium", "slow"] = "medium"
    container: Literal["mp4", "mkv"] = "mp4"
    download_thumbnail: bool = False


class JobCreateRequest(BaseModel):
    url: str
    title: str
    uploader: str = ""
    thumbnail: Optional[str] = None
    duration_sec: float = 0.0
    clip_start_sec: Optional[float] = None
    clip_end_sec: Optional[float] = None
    encode: EncodeConfig = Field(default_factory=EncodeConfig)
    comment_style: CommentStyleConfig = Field(default_factory=CommentStyleConfig)
    output_dir: Optional[str] = None
    custom_filename: Optional[str] = None


class JobStatus(str, Enum):
    QUEUED = "queued"
    DOWNLOADING = "downloading"
    PARSING_CHAT = "parsing_chat"
    RENDERING = "rendering"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class QueueJob(BaseModel):
    id: str
    status: JobStatus = JobStatus.QUEUED
    stage_label: str = "待機中"
    progress: float = 0.0
    fps: float = 0.0
    speed: str = ""
    eta_sec: Optional[int] = None
    error: Optional[str] = None
    output_files: list[str] = Field(default_factory=list)
    created_at: float
    request: JobCreateRequest


class AppSettings(BaseModel):
    output_dir: str
    theme: Literal["dark", "light"] = "dark"
    active_preset_id: str = "niconico-official"
    keep_temp_files: bool = False
    max_concurrent_jobs: int = 1
    auto_update_tools: bool = True
    auto_update_app: bool = True
    update_feed_url: str = "tomotora1223/NicoTubeStudio"
    style_server_url: str = ""
    github_style_token: str = ""
    style_author_name: str = ""
    encode_config: EncodeConfig = Field(default_factory=EncodeConfig)
    last_comment_style: Optional[CommentStyleConfig] = None


class SystemFontInfo(BaseModel):
    family: str
    has_japanese: bool = False
    is_user_installed: bool = False
    has_file: bool = False


class SharedStyleEntry(BaseModel):
    id: str
    name: str
    author: str = "Anonymous"
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    source: str = "local"
    url: Optional[str] = None
    created_at: float
    config: CommentStyleConfig


class SharedStyleCreate(BaseModel):
    name: str
    author: str = "Anonymous"
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    config: CommentStyleConfig


class StyleUrlImportRequest(BaseModel):
    url: str


class GithubStyleShareResult(BaseModel):
    method: Literal["gist", "issue_url"]
    url: str
    entry: SharedStyleEntry


class EncoderProbeResult(BaseModel):
    ffmpeg_found: bool
    ffmpeg_path: Optional[str] = None
    ffprobe_path: Optional[str] = None
    available_hw: list[str] = Field(default_factory=list)
    encoders_by_codec: dict[str, list[str]] = Field(default_factory=dict)
    recommended_hw: str = "cpu"


class AuthStatus(BaseModel):
    logged_in: bool
    source: Literal["none", "builtin_browser", "imported_file"] = "none"
    cookie_count: int = 0
    has_youtube_auth: bool = False
    cookie_path: Optional[str] = None


class ToolUpdateStatus(BaseModel):
    checking: bool = False
    ytdlp_version: str = ""
    ytdlp_latest: Optional[str] = None
    ytdlp_status: str = "待機中"
    ffmpeg_version: str = ""
    ffmpeg_latest: Optional[str] = None
    ffmpeg_status: str = "待機中"
    js_runtime: str = "未検出"
    last_checked_at: Optional[float] = None
