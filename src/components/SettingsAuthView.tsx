import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  Cpu,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  SunMoon,
  Trash2,
  Upload,
} from 'lucide-react'
import { api } from '../lib/api'
import type {
  AppSettings,
  AppUpdateState,
  AuthStatus,
  EncoderProbeResult,
  ToolUpdateStatus,
} from '../types/studio'

interface SettingsAuthViewProps {
  settings: AppSettings
  onUpdateSettings: (next: AppSettings) => Promise<void>
  authStatus: AuthStatus | null
  onRefreshAuth: () => Promise<void>
  encoders: EncoderProbeResult | null
  onRefreshEncoders: (force?: boolean) => Promise<void>
  toolProgress: { progress: number; label: string } | null
  toolUpdateStatus: ToolUpdateStatus | null
  onCheckToolUpdates: () => Promise<void>
  appUpdateState: AppUpdateState | null
  onCheckAppUpdate: (feedUrl?: string) => Promise<void>
  onInstallAppUpdate: () => Promise<void>
}

export function SettingsAuthView({
  settings,
  onUpdateSettings,
  authStatus,
  onRefreshAuth,
  encoders,
  onRefreshEncoders,
  toolProgress,
  toolUpdateStatus,
  onCheckToolUpdates,
  appUpdateState,
  onCheckAppUpdate,
  onInstallAppUpdate,
}: SettingsAuthViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [installingFfmpeg, setInstallingFfmpeg] = useState(false)
  const [cacheNotice, setCacheNotice] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [feedUrlDraft, setFeedUrlDraft] = useState(settings.update_feed_url || '')

  useEffect(() => {
    setFeedUrlDraft(settings.update_feed_url || '')
  }, [settings.update_feed_url])

  const handleBuiltinLogin = async () => {
    setAuthError(null)
    if (!window.nicotube) {
      setAuthError('内蔵ブラウザログインはデスクトップアプリ実行時のみ利用できます')
      return
    }
    await window.nicotube.openYoutubeLogin()
  }

  const handleLogout = async () => {
    await window.nicotube?.clearYoutubeLogin()
    await api.clearAuthCookies()
    await onRefreshAuth()
  }

  const handleCookiesUpload = async (file: File) => {
    setAuthError(null)
    try {
      await api.uploadCookiesFile(file)
      await onRefreshAuth()
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Cookieの読み込みに失敗しました')
    }
  }

  const handleSelectFolder = async () => {
    const dir = await window.nicotube?.selectOutputDir()
    if (dir) {
      await onUpdateSettings({ ...settings, output_dir: dir })
    }
  }

  const handleInstallFfmpeg = async () => {
    setInstallingFfmpeg(true)
    try {
      await api.installFfmpeg()
      await onRefreshEncoders(true)
    } finally {
      setInstallingFfmpeg(false)
    }
  }

  const handleClearCache = async () => {
    const res = await api.clearEmoteCache()
    setCacheNotice(`${res.cleared}件のスタンプキャッシュを削除しました`)
    setTimeout(() => setCacheNotice(null), 2500)
  }

  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-6 px-8 py-6">
      <div>
        <h1 className="text-[24px] font-medium tracking-tight" style={{ color: 'var(--md-on-surface)' }}>
          アカウント・設定
        </h1>
        <p className="mt-1 text-[13px]" style={{ color: 'var(--md-on-surface-variant)' }}>
          メンバー限定配信向けのGoogleログイン、ハードウェアエンコーダ環境、保存先を設定します
        </p>
      </div>

      {/* Google / YouTube Auth Card */}
      <div
        className="flex flex-col gap-4 rounded-2xl border p-5"
        style={{
          backgroundColor: 'var(--md-surface-low)',
          borderColor: 'var(--md-outline-variant)',
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              style={{ backgroundColor: 'var(--md-surface-high)', color: 'var(--md-on-surface-variant)' }}
            >
              <KeyRound size={18} strokeWidth={1.5} />
            </div>
            <div>
              <h2 className="text-[15px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                YouTube / Google ログイン連携
              </h2>
              <p className="mt-0.5 text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                メンバーシップ限定配信や年齢制限配信を取得するためにCookieを保持します（ローカル保存のみ）
              </p>
            </div>
          </div>

          <div
            className="flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12px] font-medium"
            style={{
              backgroundColor: authStatus?.logged_in ? 'rgba(76, 195, 138, 0.14)' : 'var(--md-surface-high)',
              color: authStatus?.logged_in ? 'var(--md-positive)' : 'var(--md-on-surface-muted)',
            }}
          >
            {authStatus?.logged_in && <CheckCircle2 size={14} strokeWidth={1.5} />}
            <span>
              {authStatus?.logged_in
                ? `ログイン済み (${authStatus.cookie_count} cookies)`
                : '未ログイン'}
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleBuiltinLogin}
            className="flex h-9 items-center gap-2 rounded-lg px-4 text-[13px] font-medium"
            style={{ backgroundColor: 'var(--md-primary)', color: 'var(--md-on-primary)' }}
          >
            <LogIn size={15} strokeWidth={1.5} />
            <span>アプリ内ブラウザでGoogleログイン</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".txt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) handleCookiesUpload(f)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium"
            style={{
              backgroundColor: 'var(--md-surface-high)',
              borderColor: 'var(--md-outline-variant)',
              color: 'var(--md-on-surface)',
            }}
          >
            <Upload size={14} strokeWidth={1.5} />
            <span>cookies.txt を読み込む</span>
          </button>

          {authStatus && authStatus.cookie_count > 0 && (
            <button
              type="button"
              onClick={handleLogout}
              className="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px]"
              style={{
                backgroundColor: 'var(--md-surface)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-negative)',
              }}
            >
              <LogOut size={14} strokeWidth={1.5} />
              <span>ログアウト / Cookie削除</span>
            </button>
          )}
        </div>

        {authError && (
          <div className="text-[12px]" style={{ color: 'var(--md-negative)' }}>
            {authError}
          </div>
        )}
      </div>

      {/* FFmpeg & Hardware Encoder Card */}
      <div
        className="flex flex-col gap-4 rounded-2xl border p-5"
        style={{
          backgroundColor: 'var(--md-surface-low)',
          borderColor: 'var(--md-outline-variant)',
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div
              className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
              style={{ backgroundColor: 'var(--md-surface-high)', color: 'var(--md-on-surface-variant)' }}
            >
              <Cpu size={18} strokeWidth={1.5} />
            </div>
            <div>
              <h2 className="text-[15px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                FFmpeg と GPUハードウェアエンコーダ
              </h2>
              <p className="mt-0.5 text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                {encoders?.ffmpeg_found
                  ? `検出パス: ${encoders.ffmpeg_path}`
                  : 'FFmpegが見つかりません。自動ダウンロードでアプリ内に導入できます'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onRefreshEncoders(true)}
              className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px]"
              style={{
                backgroundColor: 'var(--md-surface-high)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-on-surface)',
              }}
            >
              <RefreshCw size={13} strokeWidth={1.5} />
              <span>再検出</span>
            </button>

            {!encoders?.ffmpeg_found && (
              <button
                type="button"
                onClick={handleInstallFfmpeg}
                disabled={installingFfmpeg}
                className="flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-[12px] font-medium disabled:opacity-50"
                style={{ backgroundColor: 'var(--md-primary)', color: 'var(--md-on-primary)' }}
              >
                {installingFfmpeg ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Download size={14} strokeWidth={1.5} />
                )}
                <span>{installingFfmpeg ? '導入中...' : 'FFmpegを自動インストール'}</span>
              </button>
            )}
          </div>
        </div>

        {installingFfmpeg && toolProgress && (
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
              <span>{toolProgress.label}</span>
              <span className="font-mono-tabular">{Math.round(toolProgress.progress * 100)}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ backgroundColor: 'var(--md-surface-high)' }}>
              <div
                className="h-full rounded-full"
                style={{ width: `${Math.round(toolProgress.progress * 100)}%`, backgroundColor: 'var(--md-primary)' }}
              />
            </div>
          </div>
        )}

        {encoders?.ffmpeg_found && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {(['h264', 'h265', 'av1'] as const).map((codec) => (
              <div
                key={codec}
                className="rounded-xl border p-3"
                style={{
                  backgroundColor: 'var(--md-surface)',
                  borderColor: 'var(--md-outline-variant)',
                }}
              >
                <div className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                  {codec.toUpperCase()}
                </div>
                <div className="font-mono-tabular mt-1 text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  {encoders.encoders_by_codec[codec]?.join(', ') || '利用不可'}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Storage, Theme & Cache */}
      <div
        className="flex flex-col gap-4 rounded-2xl border p-5"
        style={{
          backgroundColor: 'var(--md-surface-low)',
          borderColor: 'var(--md-outline-variant)',
        }}
      >
        <h2 className="text-[15px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
          一般設定・ストレージ
        </h2>

        <div className="flex flex-col gap-1.5">
          <label className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
            動画保存先フォルダ
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={settings.output_dir}
              onChange={(e) => onUpdateSettings({ ...settings, output_dir: e.target.value })}
              className="font-mono-tabular h-9 flex-1 rounded-lg border px-3 text-[12px] outline-none"
              style={{
                backgroundColor: 'var(--md-surface-high)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-on-surface)',
              }}
            />
            <button
              type="button"
              onClick={handleSelectFolder}
              className="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium"
              style={{
                backgroundColor: 'var(--md-surface-high)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-on-surface)',
              }}
            >
              <FolderOpen size={14} strokeWidth={1.5} />
              <span>参照</span>
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: 'var(--md-outline-variant)' }}>
          <div className="flex items-center gap-2">
            <SunMoon size={16} strokeWidth={1.5} style={{ color: 'var(--md-on-surface-muted)' }} />
            <span className="text-[13px]" style={{ color: 'var(--md-on-surface-variant)' }}>
              外観テーマ
            </span>
          </div>
          <div className="flex gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--md-surface)' }}>
            {(
              [
                ['dark', 'ダーク (Studio)'],
                ['light', 'ライト'],
              ] as const
            ).map(([t, lbl]) => (
              <button
                key={t}
                type="button"
                onClick={() => onUpdateSettings({ ...settings, theme: t })}
                className="rounded-md px-3 py-1 text-[12px] font-medium"
                style={{
                  backgroundColor: settings.theme === t ? 'var(--md-surface-highest)' : 'transparent',
                  color: settings.theme === t ? 'var(--md-on-surface)' : 'var(--md-on-surface-muted)',
                }}
              >
                {lbl}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: 'var(--md-outline-variant)' }}>
          <div>
            <div className="text-[13px]" style={{ color: 'var(--md-on-surface-variant)' }}>
              同時実行ジョブ数
            </div>
            <div className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              複数ジョブを並列処理します（GPUメモリ節約時は 1 推奨）
            </div>
          </div>
          <div className="flex gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--md-surface)' }}>
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onUpdateSettings({ ...settings, max_concurrent_jobs: n })}
                className="font-mono-tabular rounded-md px-3 py-1 text-[12px] font-medium"
                style={{
                  backgroundColor:
                    (settings.max_concurrent_jobs || 1) === n ? 'var(--md-surface-highest)' : 'transparent',
                  color:
                    (settings.max_concurrent_jobs || 1) === n
                      ? 'var(--md-on-surface)'
                      : 'var(--md-on-surface-muted)',
                }}
              >
                {n}件
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4" style={{ borderColor: 'var(--md-outline-variant)' }}>
          <div>
            <div className="text-[13px]" style={{ color: 'var(--md-on-surface-variant)' }}>
              スタンプ画像キャッシュ
            </div>
            <div className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              {cacheNotice || 'ダウンロード済みのYouTubeチャンネル固有スタンプを一括削除します'}
            </div>
          </div>
          <button
            type="button"
            onClick={handleClearCache}
            className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px]"
            style={{
              backgroundColor: 'var(--md-surface-high)',
              borderColor: 'var(--md-outline-variant)',
              color: 'var(--md-on-surface-variant)',
            }}
          >
            <Trash2 size={13} strokeWidth={1.5} />
            <span>キャッシュを削除</span>
          </button>
        </div>
      </div>

      {/* Auto Update & Tool Versions */}
      <div
        className="flex flex-col gap-4 rounded-2xl border p-5"
        style={{
          backgroundColor: 'var(--md-surface-low)',
          borderColor: 'var(--md-outline-variant)',
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
              アップデート・バージョン管理
            </h2>
            <p className="mt-1 text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              起動時にバックグラウンドで yt-dlp・FFmpeg・JSランタイム・アプリの更新を確認します
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={toolUpdateStatus?.checking}
              onClick={onCheckToolUpdates}
              className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] disabled:opacity-50"
              style={{
                backgroundColor: 'var(--md-surface-high)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-on-surface)',
              }}
            >
              {toolUpdateStatus?.checking ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <RefreshCw size={13} strokeWidth={1.5} />
              )}
              <span>{toolUpdateStatus?.checking ? '確認中...' : 'ツールを今すぐ更新確認'}</span>
            </button>

            {window.nicotube && (
              <button
                type="button"
                onClick={
                  appUpdateState?.state === 'ready'
                    ? onInstallAppUpdate
                    : () => onCheckAppUpdate(feedUrlDraft.trim())
                }
                disabled={appUpdateState?.state === 'checking' || appUpdateState?.state === 'downloading'}
                className="flex h-8 items-center gap-1.5 rounded-lg px-3 text-[12px] font-medium disabled:opacity-50"
                style={{
                  backgroundColor:
                    appUpdateState?.state === 'ready' ? 'var(--md-primary)' : 'var(--md-surface-high)',
                  border: appUpdateState?.state === 'ready' ? 'none' : '1px solid var(--md-outline-variant)',
                  color:
                    appUpdateState?.state === 'ready' ? 'var(--md-on-primary)' : 'var(--md-on-surface)',
                }}
              >
                <span>
                  {appUpdateState?.state === 'ready'
                    ? '再起動して適用（サイレント）'
                    : appUpdateState?.state === 'checking'
                    ? '確認中...'
                    : appUpdateState?.state === 'downloading'
                    ? 'ダウンロード中...'
                    : 'アプリ更新を確認'}
                </span>
              </button>
            )}
          </div>
        </div>

        {appUpdateState?.state === 'downloading' && (
          <div className="space-y-1">
            <div className="flex justify-between text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              <span>{appUpdateState.message}</span>
              <span className="font-mono-tabular">{Math.round((appUpdateState.progress || 0) * 100)}%</span>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full"
              style={{ backgroundColor: 'var(--md-surface-high)' }}
            >
              <div
                className="ease-studio h-full transition-[width] duration-200"
                style={{
                  width: `${Math.max(4, Math.min(100, Math.round((appUpdateState.progress || 0) * 100)))}%`,
                  backgroundColor: 'var(--md-primary)',
                }}
              />
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div
            className="rounded-xl border p-3"
            style={{ backgroundColor: 'var(--md-surface)', borderColor: 'var(--md-outline-variant)' }}
          >
            <div className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              yt-dlp
            </div>
            <div className="font-mono-tabular mt-1 text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
              {toolUpdateStatus?.ytdlp_version || '確認中'}
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
              {toolUpdateStatus?.ytdlp_status || '待機中'}
            </div>
          </div>

          <div
            className="rounded-xl border p-3"
            style={{ backgroundColor: 'var(--md-surface)', borderColor: 'var(--md-outline-variant)' }}
          >
            <div className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              FFmpeg
            </div>
            <div className="font-mono-tabular mt-1 text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
              {toolUpdateStatus?.ffmpeg_version || '未導入'}
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
              {toolUpdateStatus?.ffmpeg_status || '待機中'}
            </div>
          </div>

          <div
            className="rounded-xl border p-3"
            style={{ backgroundColor: 'var(--md-surface)', borderColor: 'var(--md-outline-variant)' }}
          >
            <div className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              JSランタイム (EJS)
            </div>
            <div className="font-mono-tabular mt-1 text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
              {toolUpdateStatus?.js_runtime || '未検出'}
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
              YouTube形式解析用
            </div>
          </div>

          <div
            className="rounded-xl border p-3"
            style={{ backgroundColor: 'var(--md-surface)', borderColor: 'var(--md-outline-variant)' }}
          >
            <div className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              NicoTube Studio 本体
            </div>
            <div className="font-mono-tabular mt-1 text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
              v{appUpdateState?.version || '0.2.3'}
            </div>
            <div
              className="mt-0.5 truncate text-[11px]"
              title={appUpdateState?.message || ''}
              style={{
                color:
                  appUpdateState?.state === 'error'
                    ? 'var(--md-error)'
                    : 'var(--md-on-surface-variant)',
              }}
            >
              {appUpdateState?.message || 'バックグラウンド自動確認有効'}
            </div>
          </div>
        </div>

        <div
          className="space-y-2 border-t pt-3"
          style={{ borderColor: 'var(--md-outline-variant)' }}
        >
          <div className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
            アプリ自動アップデート配布先 (GitHub `owner/repo` または Generic HTTP(S) URL)
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={feedUrlDraft}
              onChange={(e) => setFeedUrlDraft(e.target.value)}
              placeholder="例: yourname/NicoTubeStudio または https://example.com/updates"
              className="h-8 min-w-[260px] flex-1 rounded-lg border px-2.5 text-[12px] outline-none"
              style={{
                backgroundColor: 'var(--md-surface)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-on-surface)',
              }}
            />
            <button
              type="button"
              onClick={async () => {
                const nextUrl = feedUrlDraft.trim()
                await onUpdateSettings({ ...settings, update_feed_url: nextUrl })
                if (window.nicotube) {
                  await onCheckAppUpdate(nextUrl)
                }
              }}
              className="h-8 rounded-lg border px-3 text-[12px] font-medium"
              style={{
                backgroundColor: 'var(--md-surface-high)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-on-surface)',
              }}
            >
              保存して確認
            </button>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
            Setup (NSIS) 版はウィザードを表示せずバックグラウンド準備＋サイレント再起動更新を行います（Portable版は通知のみ）。
          </p>
        </div>

        <StyleServerRow
          value={settings.style_server_url || ''}
          githubToken={settings.github_style_token || ''}
          authorName={settings.style_author_name || ''}
          onSave={(nextUrl, nextToken, nextAuthor) =>
            onUpdateSettings({
              ...settings,
              style_server_url: nextUrl,
              github_style_token: nextToken,
              style_author_name: nextAuthor,
            })
          }
        />

        <div
          className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
          style={{ borderColor: 'var(--md-outline-variant)' }}
        >
          <span className="text-[13px]" style={{ color: 'var(--md-on-surface-variant)' }}>
            起動時に yt-dlp / FFmpeg をバックグラウンドで自動更新する
          </span>
          <button
            type="button"
            onClick={() =>
              onUpdateSettings({
                ...settings,
                auto_update_tools: !settings.auto_update_tools,
              })
            }
            className="h-7 rounded-full border px-3 text-[12px] font-medium"
            style={{
              backgroundColor: settings.auto_update_tools ? 'var(--md-primary-tonal)' : 'var(--md-surface-high)',
              borderColor: settings.auto_update_tools ? 'var(--md-primary)' : 'var(--md-outline-variant)',
              color: settings.auto_update_tools ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-muted)',
            }}
          >
            {settings.auto_update_tools ? '自動更新オン' : '手動のみ'}
          </button>
        </div>

        <div
          className="flex flex-wrap items-center justify-between gap-3 border-t pt-3"
          style={{ borderColor: 'var(--md-outline-variant)' }}
        >
          <span className="text-[13px]" style={{ color: 'var(--md-on-surface-variant)' }}>
            起動時に NicoTube Studio 本体の自動更新を確認する
          </span>
          <button
            type="button"
            onClick={() =>
              onUpdateSettings({
                ...settings,
                auto_update_app: !settings.auto_update_app,
              })
            }
            className="h-7 rounded-full border px-3 text-[12px] font-medium"
            style={{
              backgroundColor: settings.auto_update_app ? 'var(--md-primary-tonal)' : 'var(--md-surface-high)',
              borderColor: settings.auto_update_app ? 'var(--md-primary)' : 'var(--md-outline-variant)',
              color: settings.auto_update_app ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-muted)',
            }}
          >
            {settings.auto_update_app ? '自動確認オン' : '手動のみ'}
          </button>
        </div>
      </div>
    </div>
  )
}

function StyleServerRow({
  value,
  githubToken,
  authorName,
  onSave,
}: {
  value: string
  githubToken: string
  authorName: string
  onSave: (nextUrl: string, nextToken: string, nextAuthor: string) => Promise<void> | void
}) {
  const [draft, setDraft] = useState(value)
  const [tokenDraft, setTokenDraft] = useState(githubToken)
  const [showToken, setShowToken] = useState(false)
  const [authorDraft, setAuthorDraft] = useState(authorName)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setDraft(value)
    setTokenDraft(githubToken)
    setAuthorDraft(authorName)
  }, [value, githubToken, authorName])

  return (
    <div
      className="space-y-2.5 border-t pt-3"
      style={{ borderColor: 'var(--md-outline-variant)' }}
    >
      <div className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
        スタイル共有設定（リレーサーバー / GitHub Gist 自動公開・作成者名）
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="共有サーバーURL（例: https://styles.example.workers.dev）"
          className="h-8 rounded-lg border px-2.5 text-[12px] outline-none"
          style={{
            backgroundColor: 'var(--md-surface)',
            borderColor: 'var(--md-outline-variant)',
            color: 'var(--md-on-surface)',
          }}
        />
        <input
          type="text"
          value={authorDraft}
          onChange={(e) => setAuthorDraft(e.target.value)}
          placeholder="公開時の作成者名（任意）"
          className="h-8 rounded-lg border px-2.5 text-[12px] outline-none"
          style={{
            backgroundColor: 'var(--md-surface)',
            borderColor: 'var(--md-outline-variant)',
            color: 'var(--md-on-surface)',
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="flex h-8 min-w-[260px] flex-1 items-center gap-1 rounded-lg border px-2.5"
          style={{
            backgroundColor: 'var(--md-surface)',
            borderColor: 'var(--md-outline-variant)',
          }}
        >
          <input
            type={showToken ? 'text' : 'password'}
            value={tokenDraft}
            onChange={(e) => setTokenDraft(e.target.value)}
            placeholder="GitHub Personal Access Token (gist 権限のみ・任意)"
            className="w-full bg-transparent text-[12px] outline-none"
            style={{ color: 'var(--md-on-surface)' }}
          />
          <button
            type="button"
            onClick={() => setShowToken((v) => !v)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[var(--md-surface-high)]"
            style={{ color: 'var(--md-on-surface-muted)' }}
            title={showToken ? 'トークンを隠す' : 'トークンを表示'}
          >
            {showToken ? <EyeOff size={13} strokeWidth={1.5} /> : <Eye size={13} strokeWidth={1.5} />}
          </button>
        </div>
        <button
          type="button"
          onClick={async () => {
            await onSave(draft.trim(), tokenDraft.trim(), authorDraft.trim())
            setSaved(true)
            setTimeout(() => setSaved(false), 2000)
          }}
          className="h-8 rounded-lg border px-3 text-[12px] font-medium"
          style={{
            backgroundColor: 'var(--md-surface-high)',
            borderColor: 'var(--md-outline-variant)',
            color: 'var(--md-on-surface)',
          }}
        >
          {saved ? '保存済み' : '保存'}
        </button>
      </div>
      <p className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
        トークン未設定でも「みんなのスタイル」タブから GitHub Issue 経由の公開やリレーサーバー連携が利用できます。
      </p>
    </div>
  )
}
