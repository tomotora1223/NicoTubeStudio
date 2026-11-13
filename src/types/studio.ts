export type CollisionMode = 'danmaku' | 'drop' | 'stagger'
export type SuperChatMode = 'card_scroll' | 'card_top' | 'text_color' | 'hide'
export type EventDisplayMode = 'follow_superchat' | 'card_scroll' | 'card_top' | 'text_color' | 'hide'
export type RoleDisplayMode = 'color' | 'normal' | 'hide'
export type PinMode = 'naka' | 'ue' | 'shita'
export type SuperChatColorSource = 'official' | 'youtube_raw' | 'custom'
export type SuperChatTierKey = 'blue' | 'lightblue' | 'green' | 'yellow' | 'orange' | 'magenta' | 'red'
export type OutputMode = 'with_comments' | 'video_only' | 'both'
export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'parsing_chat'
  | 'rendering'
  | 'completed'
  | 'failed'
  | 'cancelled'

export const DEFAULT_SUPERCHAT_TIER_COLORS: Record<SuperChatTierKey, string> = {
  blue: '#1E88E5',
  lightblue: '#00B8D4',
  green: '#00BFA5',
  yellow: '#FFB300',
  orange: '#E65100',
  magenta: '#C2185B',
  red: '#D00000',
}

export const SUPERCHAT_TIER_LABELS: Array<{ key: SuperChatTierKey; label: string; sampleAmount: string }> = [
  { key: 'blue', label: '青 (¥100〜)', sampleAmount: '¥200' },
  { key: 'lightblue', label: '水色 (¥200〜)', sampleAmount: '¥500' },
  { key: 'green', label: '緑 (¥500〜)', sampleAmount: '¥1,000' },
  { key: 'yellow', label: '黄 (¥1,000〜)', sampleAmount: '¥2,000' },
  { key: 'orange', label: '橙 (¥2,000〜)', sampleAmount: '¥5,000' },
  { key: 'magenta', label: 'マゼンタ (¥5,000〜)', sampleAmount: '¥10,000' },
  { key: 'red', label: '赤 (¥10,000〜)', sampleAmount: '¥50,000' },
]

export interface CommentStyleConfig {
  font_family: string
  font_weight: number
  font_scale: number
  opacity: number
  scroll_duration_sec: number
  fixed_duration_sec: number
  outline_width: number
  outline_color: string
  outline_opacity: number
  outline2_width: number
  outline2_color: string
  outline2_opacity: number
  shadow_enabled: boolean
  shadow_color: string
  shadow_opacity: number
  shadow_blur: number
  shadow_offset_x: number
  shadow_offset_y: number
  display_area_ratio: number
  line_height_ratio: number
  collision_mode: CollisionMode
  max_concurrent: number
  lane_gap_px: number
  ng_words: string[]

  default_color: string
  normal_pin_mode: PinMode

  member_color_enabled: boolean
  member_color: string
  member_badge_prefix: boolean
  member_badge_text: string
  member_scale: number
  member_pin_mode: PinMode

  moderator_mode: RoleDisplayMode
  moderator_color_enabled: boolean
  moderator_color: string
  moderator_badge_prefix: boolean
  moderator_badge_text: string
  moderator_scale: number
  moderator_pin_mode: PinMode

  owner_color_enabled: boolean
  owner_color: string
  owner_pin_top: boolean
  owner_pin_mode: PinMode
  owner_badge_prefix: boolean
  owner_badge_text: string
  owner_scale: number

  superchat_mode: SuperChatMode
  superchat_show_amount: boolean
  superchat_scale: number
  superchat_speed_multiplier: number
  superchat_color_source: SuperChatColorSource
  superchat_tier_colors: Record<string, string>

  card_opacity: number
  card_radius_px: number
  card_border_opacity: number

  supersticker_mode: EventDisplayMode
  supersticker_scale: number
  membership_mode: EventDisplayMode
  membership_color: string
  membership_scale: number
  gift_mode: EventDisplayMode
  gift_color: string
  gift_scale: number
  membership_events_enabled: boolean

  custom_emotes_enabled: boolean
  unicode_emoji_enabled: boolean
}

export interface SystemFontInfo {
  family: string
  has_japanese: boolean
  is_user_installed: boolean
  has_file: boolean
}

export interface SharedStyleEntry {
  id: string
  name: string
  author: string
  description: string
  created_at: number
  config: CommentStyleConfig
}

export interface SharedStyleCreate {
  name: string
  author: string
  description: string
  config: CommentStyleConfig
}

export interface Preset {
  id: string
  name: string
  description: string
  is_builtin: boolean
  config: CommentStyleConfig
}

export interface FormatOption {
  format_id: string
  resolution: string
  width?: number | null
  height?: number | null
  fps?: number | null
  vcodec?: string | null
  acodec?: string | null
  ext: string
  filesize_approx?: number | null
}

export interface VideoInfoResponse {
  id: string
  title: string
  uploader: string
  channel_id?: string | null
  duration_sec: number
  is_live: boolean
  was_live: boolean
  has_live_chat: boolean
  thumbnail?: string | null
  preview_stream_url?: string | null
  webpage_url: string
  resolutions: number[]
  fps_options: number[]
  formats: FormatOption[]
}

export interface EncodeConfig {
  output_mode: OutputMode
  resolution: string
  max_fps: number
  codec: 'h264' | 'h265' | 'av1'
  hw_encoder: 'auto' | 'nvenc' | 'qsv' | 'amf' | 'cpu'
  quality_cq: number
  preset_speed: 'fast' | 'medium' | 'slow'
  container: 'mp4' | 'mkv'
}

export interface JobCreateRequest {
  url: string
  title: string
  uploader: string
  thumbnail?: string | null
  duration_sec: number
  clip_start_sec?: number | null
  clip_end_sec?: number | null
  encode: EncodeConfig
  comment_style: CommentStyleConfig
  output_dir?: string | null
  custom_filename?: string | null
}

export interface QueueJob {
  id: string
  status: JobStatus
  stage_label: string
  progress: number
  fps: number
  speed: string
  eta_sec?: number | null
  error?: string | null
  output_files: string[]
  created_at: number
  request: JobCreateRequest
}

export interface AppSettings {
  output_dir: string
  theme: 'dark' | 'light'
  active_preset_id: string
  keep_temp_files: boolean
  max_concurrent_jobs: number
  auto_update_tools: boolean
  auto_update_app: boolean
  update_feed_url: string
  style_server_url: string
  encode_config?: EncodeConfig
  last_comment_style?: CommentStyleConfig | null
}

export interface EncoderProbeResult {
  ffmpeg_found: boolean
  ffmpeg_path?: string | null
  ffprobe_path?: string | null
  available_hw: string[]
  encoders_by_codec: Record<string, string[]>
  recommended_hw: string
}

export interface AuthStatus {
  logged_in: boolean
  source: 'none' | 'builtin_browser' | 'imported_file'
  cookie_count: number
  has_youtube_auth: boolean
  cookie_path?: string | null
}

export interface ToolUpdateStatus {
  checking: boolean
  ytdlp_version: string
  ytdlp_latest?: string | null
  ytdlp_status: string
  ffmpeg_version: string
  ffmpeg_latest?: string | null
  ffmpeg_status: string
  js_runtime: string
  last_checked_at?: number | null
}

export interface AppUpdateState {
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'latest' | 'error'
  version: string
  message: string
  progress: number
}

export const DEFAULT_COMMENT_STYLE: CommentStyleConfig = {
  font_family: 'Yu Gothic UI',
  font_weight: 600,
  font_scale: 1.0,
  opacity: 0.85,
  scroll_duration_sec: 4.0,
  fixed_duration_sec: 3.0,
  outline_width: 2.0,
  outline_color: '#000000',
  outline_opacity: 0.88,
  outline2_width: 0.0,
  outline2_color: '#FFFFFF',
  outline2_opacity: 0.65,
  shadow_enabled: true,
  shadow_color: '#000000',
  shadow_opacity: 0.55,
  shadow_blur: 0.0,
  shadow_offset_x: 1.5,
  shadow_offset_y: 1.5,
  display_area_ratio: 1.0,
  line_height_ratio: 1.22,
  collision_mode: 'danmaku',
  max_concurrent: 80,
  lane_gap_px: 16,
  ng_words: [],
  default_color: '#FFFFFF',
  normal_pin_mode: 'naka',
  member_color_enabled: true,
  member_color: '#5CE68A',
  member_badge_prefix: false,
  member_badge_text: '[M]',
  member_scale: 1.0,
  member_pin_mode: 'naka',
  moderator_mode: 'color',
  moderator_color_enabled: true,
  moderator_color: '#6BA5FF',
  moderator_badge_prefix: false,
  moderator_badge_text: '[Mod]',
  moderator_scale: 1.0,
  moderator_pin_mode: 'naka',
  owner_color_enabled: true,
  owner_color: '#FFD447',
  owner_pin_top: true,
  owner_pin_mode: 'ue',
  owner_badge_prefix: false,
  owner_badge_text: '[配信者]',
  owner_scale: 1.05,
  superchat_mode: 'card_scroll',
  superchat_show_amount: true,
  superchat_scale: 1.05,
  superchat_speed_multiplier: 1.0,
  superchat_color_source: 'official',
  superchat_tier_colors: { ...DEFAULT_SUPERCHAT_TIER_COLORS },
  card_opacity: 0.92,
  card_radius_px: 7.0,
  card_border_opacity: 0.28,
  supersticker_mode: 'follow_superchat',
  supersticker_scale: 1.05,
  membership_mode: 'card_scroll',
  membership_color: '#0F9D58',
  membership_scale: 0.96,
  gift_mode: 'card_scroll',
  gift_color: '#0F9D58',
  gift_scale: 0.96,
  membership_events_enabled: true,
  custom_emotes_enabled: true,
  unicode_emoji_enabled: true,
}

export function normalizeCommentStyle(partial?: Partial<CommentStyleConfig> | null): CommentStyleConfig {
  const merged: CommentStyleConfig = {
    ...DEFAULT_COMMENT_STYLE,
    ...(partial || {}),
    superchat_tier_colors: {
      ...DEFAULT_SUPERCHAT_TIER_COLORS,
      ...((partial?.superchat_tier_colors as Record<string, string>) || {}),
    },
    ng_words: Array.isArray(partial?.ng_words) ? partial.ng_words : [],
  }
  return merged
}

export const DEFAULT_ENCODE_CONFIG: EncodeConfig = {
  output_mode: 'with_comments',
  resolution: '1080',
  max_fps: 60,
  codec: 'h264',
  hw_encoder: 'auto',
  quality_cq: 20,
  preset_speed: 'medium',
  container: 'mp4',
}

declare global {
  interface Window {
    nicotube?: {
      getApiBase: () => Promise<string>
      openYoutubeLogin: () => Promise<boolean>
      clearYoutubeLogin: () => Promise<boolean>
      selectOutputDir: () => Promise<string | null>
      selectCookiesFile: () => Promise<string | null>
      showInFolder: (targetPath: string) => Promise<void>
      openPath: (targetPath: string) => Promise<void>
      openExternal: (url: string) => Promise<void>
      getAppVersion: () => Promise<string>
      getAppUpdateStatus: () => Promise<AppUpdateState>
      checkAppUpdate: (feedUrl?: string) => Promise<AppUpdateState>
      installAppUpdate: () => Promise<void>
      onAuthUpdated: (cb: (data: { hasAuth: boolean; count: number }) => void) => () => void
      onAppUpdateStatus: (cb: (data: AppUpdateState) => void) => () => void
    }
  }
}
