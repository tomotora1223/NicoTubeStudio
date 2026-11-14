import { useEffect, useRef, useState } from 'react'
import Hls from 'hls.js'
import {
  AlertCircle,
  CheckCircle2,
  ClipboardPaste,
  Cpu,
  ExternalLink,
  Film,
  Loader2,
  Maximize2,
  MessageSquare,
  Pause,
  Play,
  Plus,
  Repeat,
  Scissors,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { api, formatDuration, parseTimecode } from '../lib/api'
import type {
  CommentStyleConfig,
  EncodeConfig,
  EncoderProbeResult,
  OutputMode,
  Preset,
  VideoInfoResponse,
} from '../types/studio'

interface CaptureWorkspaceProps {
  encodeConfig: EncodeConfig
  onChangeEncode: (next: EncodeConfig) => void
  presets: Preset[]
  activePresetId: string
  onSelectPreset: (id: string) => void
  commentStyle: CommentStyleConfig
  encoders: EncoderProbeResult | null
  outputDir: string
  onOpenCommentStudio: () => void
  onOpenFullscreenPreview: (thumbnail?: string | null) => void
  onJobQueued: () => void
  onGoToSettings: () => void
  onVideoProbed?: (info: VideoInfoResponse | null) => void
}

export function CaptureWorkspace({
  encodeConfig,
  onChangeEncode,
  presets,
  activePresetId,
  onSelectPreset,
  commentStyle,
  encoders,
  outputDir,
  onOpenCommentStudio,
  onOpenFullscreenPreview,
  onJobQueued,
  onGoToSettings,
  onVideoProbed,
}: CaptureWorkspaceProps) {
  const clipVideoRef = useRef<HTMLVideoElement | null>(null)
  const timelineTrackRef = useRef<HTMLDivElement | null>(null)
  const dragStateRef = useRef<{
    mode: 'start' | 'end' | 'window' | 'playhead'
    anchorX: number
    initStart: number
    initEnd: number
  } | null>(null)
  const [url, setUrl] = useState('')
  const [probing, setProbing] = useState(false)
  const [probeError, setProbeError] = useState<string | null>(null)
  const [videoInfo, setVideoInfo] = useState<VideoInfoResponse | null>(null)

  const [clipEnabled, setClipEnabled] = useState(false)
  const [clipStart, setClipStart] = useState(0)
  const [clipEnd, setClipEnd] = useState(0)
  const [startInput, setStartInput] = useState('00:00:00')
  const [endInput, setEndInput] = useState('00:00:00')
  const [customFilename, setCustomFilename] = useState('')
  const [showRangePreview, setShowRangePreview] = useState(true)
  const [previewCurrentSec, setPreviewCurrentSec] = useState(0)
  const [previewPlaying, setPreviewPlaying] = useState(false)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [loopSegment, setLoopSegment] = useState(false)
  const [activeDragMode, setActiveDragMode] = useState<'start' | 'end' | 'window' | 'playhead' | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [queuedNotice, setQueuedNotice] = useState<string | null>(null)

  useEffect(() => {
    setStartInput(formatDuration(clipStart))
  }, [clipStart])

  useEffect(() => {
    setEndInput(formatDuration(clipEnd))
  }, [clipEnd])

  const handleProbe = async () => {
    const trimmed = url.trim()
    if (!trimmed) return
    setProbing(true)
    setProbeError(null)
    setQueuedNotice(null)
    try {
      const info = await api.probeUrl(trimmed)
      setVideoInfo(info)
      onVideoProbed?.(info)
      setCustomFilename('')
      const dur = Math.max(0, Math.floor(info.duration_sec))
      setClipEnabled(false)
      setClipStart(0)
      setClipEnd(dur)
      setPreviewCurrentSec(0)
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'URLの解析に失敗しました')
    } finally {
      setProbing(false)
    }
  }

  const applyStartText = () => {
    const sec = parseTimecode(startInput)
    if (sec === null) {
      setStartInput(formatDuration(clipStart))
      return
    }
    const maxEnd = videoInfo?.duration_sec ? Math.floor(videoInfo.duration_sec) : 86400
    const clamped = Math.max(0, Math.min(sec, clipEnd > 0 ? clipEnd - 1 : maxEnd))
    setClipStart(clamped)
  }

  const applyEndText = () => {
    const sec = parseTimecode(endInput)
    if (sec === null) {
      setEndInput(formatDuration(clipEnd))
      return
    }
    const maxDur = videoInfo?.duration_sec ? Math.floor(videoInfo.duration_sec) : 86400
    const clamped = Math.max(clipStart + 1, Math.min(sec, maxDur))
    setClipEnd(clamped)
  }

  const seekPreviewTo = (sec: number, autoPlay = false) => {
    const vid = clipVideoRef.current
    if (!vid) return
    const dur = Number.isFinite(vid.duration) && vid.duration > 0 ? vid.duration : totalDur
    const target = Math.max(0, Math.min(sec, dur))
    vid.currentTime = target
    setPreviewCurrentSec(target)
    if (autoPlay) {
      vid.play().catch(() => {})
    }
  }

  const togglePlayPreview = () => {
    const vid = clipVideoRef.current
    if (!vid) return
    if (vid.paused) {
      if (vid.currentTime < clipStart || vid.currentTime >= clipEnd) {
        vid.currentTime = clipStart
      }
      vid.play().catch(() => {})
    } else {
      vid.pause()
    }
  }

  const stepPreview = (deltaSec: number) => {
    const cur = clipVideoRef.current?.currentTime ?? previewCurrentSec
    seekPreviewTo(cur + deltaSec)
  }

  const setFromPreviewTime = (target: 'start' | 'end') => {
    const cur = Math.floor(clipVideoRef.current?.currentTime ?? previewCurrentSec)
    if (target === 'start') {
      const nextStart = Math.min(cur, Math.max(0, clipEnd - 1))
      setClipStart(nextStart)
    } else {
      const nextEnd = Math.max(cur, clipStart + 1)
      setClipEnd(nextEnd)
    }
  }

  const handleEnqueue = async () => {
    const targetUrl = videoInfo?.webpage_url || url.trim()
    if (!targetUrl) return
    setSubmitting(true)
    setProbeError(null)
    setQueuedNotice(null)
    try {
      await api.enqueueJob({
        url: targetUrl,
        title: videoInfo?.title || 'YouTube Video',
        uploader: videoInfo?.uploader || '',
        thumbnail: videoInfo?.thumbnail || null,
        duration_sec: videoInfo?.duration_sec || 0,
        clip_start_sec: clipEnabled ? clipStart : null,
        clip_end_sec: clipEnabled && clipEnd > clipStart ? clipEnd : null,
        encode: encodeConfig,
        comment_style: commentStyle,
        output_dir: outputDir || null,
        custom_filename: customFilename.trim() || null,
      })
      setQueuedNotice('処理キューに追加しました')
      onJobQueued()
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : 'キューへの追加に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const availableRes = videoInfo?.resolutions?.length
    ? videoInfo.resolutions
    : [2160, 1440, 1080, 720, 480]
  const totalDur = Math.max(1, Math.floor(videoInfo?.duration_sec || 0))
  const clipSpan = Math.max(0, clipEnd - clipStart)
  const needsFfmpeg = !encoders?.ffmpeg_found

  useEffect(() => {
    const vid = clipVideoRef.current
    const srcUrl = videoInfo?.preview_stream_url
    if (!clipEnabled || !showRangePreview || !vid || !srcUrl) {
      setPreviewPlaying(false)
      setPreviewLoading(false)
      setPreviewError(null)
      return
    }

    setPreviewLoading(true)
    setPreviewError(null)

    let hls: Hls | null = null
    if (srcUrl.includes('.m3u8') && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: false })
      hls.loadSource(srcUrl)
      hls.attachMedia(vid)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setPreviewLoading(false)
      })
      hls.on(Hls.Events.ERROR, (_ev, data) => {
        if (data.fatal) {
          setPreviewLoading(false)
          setPreviewError('プレビュー映像の読み込みに失敗しました（時刻指定での切り抜きは利用できます）')
        }
      })
    } else {
      vid.src = srcUrl
    }

    return () => {
      if (hls) {
        hls.destroy()
      }
      vid.pause()
      vid.removeAttribute('src')
      vid.load()
    }
  }, [videoInfo?.preview_stream_url, showRangePreview, clipEnabled])

  const secFromClientX = (clientX: number): number => {
    const el = timelineTrackRef.current
    if (!el || totalDur <= 0) return 0
    const rect = el.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)))
    return Math.round(ratio * totalDur)
  }

  const handleTimelinePointerDown = (
    mode: 'start' | 'end' | 'window' | 'playhead',
    e: React.PointerEvent<HTMLElement>
  ) => {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragStateRef.current = {
      mode,
      anchorX: e.clientX,
      initStart: clipStart,
      initEnd: clipEnd,
    }
    setActiveDragMode(mode)
    if (mode === 'playhead') {
      seekPreviewTo(secFromClientX(e.clientX))
    }
  }

  const handleTimelinePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const ds = dragStateRef.current
    if (!ds || !timelineTrackRef.current) return
    const rect = timelineTrackRef.current.getBoundingClientRect()
    const pxW = Math.max(1, rect.width)

    if (ds.mode === 'start') {
      const next = Math.min(secFromClientX(e.clientX), Math.max(0, clipEnd - 1))
      setClipStart(next)
      seekPreviewTo(next)
    } else if (ds.mode === 'end') {
      const next = Math.max(secFromClientX(e.clientX), Math.min(totalDur, clipStart + 1))
      setClipEnd(next)
      seekPreviewTo(next)
    } else if (ds.mode === 'window') {
      const deltaSec = Math.round(((e.clientX - ds.anchorX) / pxW) * totalDur)
      const span = Math.max(1, ds.initEnd - ds.initStart)
      const nextStart = Math.max(0, Math.min(totalDur - span, ds.initStart + deltaSec))
      setClipStart(nextStart)
      setClipEnd(nextStart + span)
      seekPreviewTo(nextStart)
    } else {
      seekPreviewTo(secFromClientX(e.clientX))
    }
  }

  const handleTimelinePointerUp = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragStateRef.current) return
    dragStateRef.current = null
    setActiveDragMode(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const handlePasteUrl = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text?.trim()) {
        setUrl(text.trim())
      }
    } catch (_) {}
  }

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-6 px-8 py-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-medium tracking-tight" style={{ color: 'var(--md-on-surface)' }}>
            取り込み・切り抜き
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--md-on-surface-variant)' }}>
            YouTube / Twitch (VOD・クリップ) のURLを解析し、区間切り抜き・画質・コメント合成の有無を設定してキューへ投入します
          </p>
        </div>
        {needsFfmpeg && (
          <button
            type="button"
            onClick={onGoToSettings}
            className="flex h-9 items-center gap-2 rounded-lg border px-3 text-[12px] font-medium"
            style={{
              backgroundColor: 'rgba(229, 169, 60, 0.12)',
              borderColor: 'rgba(229, 169, 60, 0.3)',
              color: 'var(--md-warning)',
            }}
          >
            <AlertCircle size={15} strokeWidth={1.5} />
            <span>FFmpegが未導入です（設定画面から自動インストールできます）</span>
          </button>
        )}
      </div>

      {/* URL Probe Bar */}
      <div
        className="flex items-center gap-3 rounded-2xl border p-3"
        style={{
          backgroundColor: 'var(--md-surface-low)',
          borderColor: 'var(--md-outline-variant)',
        }}
      >
        <div
          className="flex h-10 flex-1 items-center gap-2 rounded-lg border px-3"
          style={{
            backgroundColor: 'var(--md-surface-high)',
            borderColor: 'var(--md-outline-variant)',
          }}
        >
          <Search size={16} strokeWidth={1.5} style={{ color: 'var(--md-on-surface-muted)' }} />
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleProbe()
            }}
            placeholder="https://www.youtube.com/watch?v=... または https://www.twitch.tv/videos/..."
            className="w-full bg-transparent text-[13px] outline-none"
            style={{ color: 'var(--md-on-surface)' }}
          />
          {url ? (
            <button
              type="button"
              onClick={() => setUrl('')}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-[var(--md-surface-highest)]"
              style={{ color: 'var(--md-on-surface-muted)' }}
              title="URLをクリア"
            >
              <X size={13} strokeWidth={1.5} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handlePasteUrl}
              className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] font-medium hover:bg-[var(--md-surface-highest)]"
              style={{ color: 'var(--md-on-surface-variant)' }}
              title="クリップボードから貼り付け"
            >
              <ClipboardPaste size={12} strokeWidth={1.5} />
              <span>貼付</span>
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={handleProbe}
          disabled={probing || !url.trim()}
          className="ease-studio flex h-10 items-center gap-2 rounded-lg px-5 text-[13px] font-medium transition-[opacity,transform] duration-150 active:scale-[0.98] disabled:opacity-45"
          style={{
            backgroundColor: 'var(--md-primary)',
            color: 'var(--md-on-primary)',
          }}
        >
          {probing ? <Loader2 size={16} strokeWidth={1.5} className="animate-spin" /> : <Film size={16} strokeWidth={1.5} />}
          <span>{probing ? '解析中...' : 'URLを解析'}</span>
        </button>
      </div>

      {probeError && (
        <div
          className="flex items-center gap-2.5 rounded-xl border px-4 py-3 text-[13px]"
          style={{
            backgroundColor: 'rgba(229, 72, 77, 0.1)',
            borderColor: 'rgba(229, 72, 77, 0.25)',
            color: 'var(--md-negative)',
          }}
        >
          <AlertCircle size={16} strokeWidth={1.5} />
          <span>{probeError}</span>
        </div>
      )}

      {queuedNotice && (
        <div
          className="flex items-center gap-2.5 rounded-xl border px-4 py-3 text-[13px]"
          style={{
            backgroundColor: 'rgba(76, 195, 138, 0.1)',
            borderColor: 'rgba(76, 195, 138, 0.25)',
            color: 'var(--md-positive)',
          }}
        >
          <CheckCircle2 size={16} strokeWidth={1.5} />
          <span>{queuedNotice}</span>
        </div>
      )}

      {/* Main Grid: Left Metadata & Trim / Right Encode & Output */}
      <div className="grid grid-cols-12 gap-5">
        {/* Left Column (7 cols): Video Info + Trim Timeline */}
        <div className="col-span-12 flex flex-col gap-5 lg:col-span-7">
          {/* Video Metadata Card */}
          <div
            className="flex flex-col gap-4 rounded-2xl border p-5"
            style={{
              backgroundColor: 'var(--md-surface-low)',
              borderColor: 'var(--md-outline-variant)',
            }}
          >
            {videoInfo ? (
              <div className="flex flex-col gap-4 sm:flex-row">
                <div
                  className="relative h-32 w-56 shrink-0 overflow-hidden rounded-xl border"
                  style={{
                    borderColor: 'var(--md-outline-variant)',
                    backgroundColor: 'var(--md-surface)',
                  }}
                >
                  {videoInfo.thumbnail && (
                    <img src={videoInfo.thumbnail} alt="" className="h-full w-full object-cover" />
                  )}
                  <span
                    className="font-mono-tabular absolute right-2 bottom-2 rounded px-1.5 py-0.5 text-[11px]"
                    style={{ backgroundColor: 'rgba(15,15,16,0.82)', color: '#ededed' }}
                  >
                    {videoInfo.is_live ? 'LIVE' : formatDuration(videoInfo.duration_sec)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-1 flex-col justify-between gap-2">
                  <div>
                    <h2 className="line-clamp-2 text-[15px] font-medium leading-snug" style={{ color: 'var(--md-on-surface)' }}>
                      {videoInfo.title}
                    </h2>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{
                          backgroundColor:
                            videoInfo.platform === 'twitch' ? 'rgba(145, 70, 255, 0.16)' : 'var(--md-primary-tonal)',
                          color: videoInfo.platform === 'twitch' ? '#c084fc' : 'var(--md-on-primary-tonal)',
                        }}
                      >
                        {videoInfo.platform === 'twitch' ? 'Twitch' : 'YouTube'}
                      </span>
                      <span>{videoInfo.uploader || 'チャンネル不明'}</span>
                      <span>·</span>
                      <span
                        className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px]"
                        style={{
                          backgroundColor: videoInfo.has_live_chat ? 'rgba(76, 195, 138, 0.14)' : 'var(--md-surface-high)',
                          color: videoInfo.has_live_chat ? 'var(--md-positive)' : 'var(--md-on-surface-muted)',
                        }}
                      >
                        <MessageSquare size={12} strokeWidth={1.5} />
                        {videoInfo.has_live_chat ? 'コメント取得可能' : 'チャットデータなし'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => window.nicotube?.openExternal(videoInfo.webpage_url)}
                      className="inline-flex items-center gap-1 text-[12px]"
                      style={{ color: 'var(--md-on-surface-muted)' }}
                    >
                      <ExternalLink size={13} strokeWidth={1.5} />
                      <span>元のページを開く</span>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex h-28 flex-col items-center justify-center gap-1.5 text-center">
                <div className="text-[13px] font-medium" style={{ color: 'var(--md-on-surface-variant)' }}>
                  動画がまだ読み込まれていません
                </div>
                <div className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  上の入力欄にYouTubeの配信アーカイブURLを貼り付けて「URLを解析」を押してください
                </div>
              </div>
            )}

            {/* Custom Output Name */}
            <div className="flex flex-col gap-1.5">
              <label className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface-variant)' }}>
                出力ファイル名（空欄なら動画タイトルを使用）
              </label>
              <input
                type="text"
                value={customFilename}
                onChange={(e) => setCustomFilename(e.target.value)}
                placeholder={videoInfo?.title || '自動設定'}
                className="h-9 rounded-lg border px-3 text-[13px] outline-none"
                style={{
                  backgroundColor: 'var(--md-surface-high)',
                  borderColor: 'var(--md-outline-variant)',
                  color: 'var(--md-on-surface)',
                }}
              />
            </div>
          </div>

          {/* Range Clipping Card */}
          <div
            className="flex flex-col gap-4 rounded-2xl border p-5"
            style={{
              backgroundColor: 'var(--md-surface-low)',
              borderColor: 'var(--md-outline-variant)',
            }}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Scissors size={16} strokeWidth={1.5} style={{ color: 'var(--md-on-surface-muted)' }} />
                <span className="text-[14px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                  区間切り抜きダウンロード
                </span>
              </div>
              <button
                type="button"
                onClick={() => setClipEnabled((v) => !v)}
                className="ease-studio h-7 rounded-full border px-3 text-[12px] font-medium transition-colors duration-150"
                style={{
                  backgroundColor: clipEnabled ? 'var(--md-primary-tonal)' : 'var(--md-surface-high)',
                  borderColor: clipEnabled ? 'var(--md-primary)' : 'var(--md-outline-variant)',
                  color: clipEnabled ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-variant)',
                }}
              >
                {clipEnabled ? '区間指定オン' : '全編ダウンロード'}
              </button>
            </div>

            {clipEnabled ? (
              <div className="flex flex-col gap-4">
                {videoInfo?.preview_stream_url ? (
                  <div
                    className="flex flex-col gap-3 rounded-xl border p-3"
                    style={{
                      backgroundColor: 'var(--md-surface)',
                      borderColor: 'var(--md-outline-variant)',
                    }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-[12px]">
                        <Play size={13} strokeWidth={1.5} style={{ color: 'var(--md-primary)' }} />
                        <span className="font-medium" style={{ color: 'var(--md-on-surface)' }}>
                          ビジュアル切り抜きトリマー
                        </span>
                        <span className="font-mono-tabular text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                          現在 {formatDuration(Math.floor(previewCurrentSec))} / {formatDuration(totalDur)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowRangePreview((v) => !v)}
                        className="text-[11px] font-medium"
                        style={{ color: 'var(--md-on-surface-muted)' }}
                      >
                        {showRangePreview ? 'プレイヤーを隠す' : 'プレイヤーを表示'}
                      </button>
                    </div>

                    {showRangePreview && (
                      <div
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
                          if (e.code === 'Space') {
                            e.preventDefault()
                            togglePlayPreview()
                          } else if (e.key === 'i' || e.key === 'I') {
                            e.preventDefault()
                            setFromPreviewTime('start')
                          } else if (e.key === 'o' || e.key === 'O') {
                            e.preventDefault()
                            setFromPreviewTime('end')
                          } else if (e.key === 'ArrowLeft') {
                            e.preventDefault()
                            stepPreview(e.shiftKey ? -10 : -1)
                          } else if (e.key === 'ArrowRight') {
                            e.preventDefault()
                            stepPreview(e.shiftKey ? 10 : 1)
                          }
                        }}
                        className="flex flex-col gap-3 rounded-lg outline-none"
                      >
                        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
                          <video
                            ref={clipVideoRef}
                            controls
                            preload="metadata"
                            onLoadedMetadata={() => setPreviewLoading(false)}
                            onCanPlay={() => setPreviewLoading(false)}
                            onError={() => {
                              setPreviewLoading(false)
                              setPreviewError('プレビュー映像を読み込めませんでした（下の時刻指定で切り抜き可能）')
                            }}
                            onPlay={() => setPreviewPlaying(true)}
                            onPause={() => setPreviewPlaying(false)}
                            onTimeUpdate={(e) => {
                              const cur = e.currentTarget.currentTime
                              setPreviewCurrentSec(cur)
                              if (loopSegment && clipEnd > clipStart && cur >= clipEnd) {
                                e.currentTarget.currentTime = clipStart
                                e.currentTarget.play().catch(() => {})
                              }
                            }}
                            className="h-full w-full object-contain"
                          />
                          {previewLoading && !previewError && (
                            <div
                              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2"
                              style={{ backgroundColor: 'rgba(15, 15, 16, 0.72)' }}
                            >
                              <Loader2 size={20} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--md-primary)' }} />
                              <span className="text-[11px]" style={{ color: '#a1a1a6' }}>
                                プレビューストリームを読み込み中...
                              </span>
                            </div>
                          )}
                          {previewError && (
                            <div
                              className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center"
                              style={{ backgroundColor: 'rgba(15, 15, 16, 0.85)' }}
                            >
                              <AlertCircle size={18} strokeWidth={1.5} style={{ color: 'var(--md-warning)' }} />
                              <span className="text-[12px]" style={{ color: '#ededed' }}>
                                {previewError}
                              </span>
                            </div>
                          )}
                          <div
                            className="font-mono-tabular pointer-events-none absolute top-2.5 left-2.5 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
                            style={{ backgroundColor: 'rgba(15,15,16,0.78)', color: '#ededed' }}
                          >
                            <span>IN {formatDuration(clipStart)}</span>
                            <span style={{ color: '#85858b' }}>→</span>
                            <span>OUT {formatDuration(clipEnd)}</span>
                            <span style={{ color: '#f59c97' }}>({formatDuration(clipSpan)})</span>
                          </div>
                        </div>

                        {/* Pointer-Capture NLE Dual-Handle Timeline Scrubber */}
                        {totalDur > 1 && (
                          <div className="flex flex-col gap-1 px-1">
                            <div
                              ref={timelineTrackRef}
                              onPointerDown={(e) => handleTimelinePointerDown('playhead', e)}
                              onPointerMove={handleTimelinePointerMove}
                              onPointerUp={handleTimelinePointerUp}
                              onPointerCancel={handleTimelinePointerUp}
                              className="relative flex h-9 cursor-pointer items-center touch-none select-none"
                            >
                              {/* Base Rail */}
                              <div
                                className="h-2.5 w-full rounded-full"
                                style={{ backgroundColor: 'var(--md-surface-highest)' }}
                              />

                              {/* Selected Range Bar (Draggable window slip) */}
                              <div
                                onPointerDown={(e) => handleTimelinePointerDown('window', e)}
                                onPointerMove={handleTimelinePointerMove}
                                onPointerUp={handleTimelinePointerUp}
                                onPointerCancel={handleTimelinePointerUp}
                                title="選択区間をドラッグして丸ごとスライド移動"
                                className="absolute h-2.5 cursor-grab rounded-full active:cursor-grabbing"
                                style={{
                                  left: `${(clipStart / totalDur) * 100}%`,
                                  width: `${Math.max(1, ((clipEnd - clipStart) / totalDur) * 100)}%`,
                                  backgroundColor: activeDragMode === 'window' ? 'var(--md-primary)' : 'rgba(217, 72, 65, 0.85)',
                                }}
                              />

                              {/* Playhead Needle */}
                              <div
                                className="pointer-events-none absolute top-1 bottom-1 z-10 w-0.5 rounded-full"
                                style={{
                                  left: `${Math.max(0, Math.min(100, (previewCurrentSec / totalDur) * 100))}%`,
                                  backgroundColor: '#fafafa',
                                }}
                              />

                              {/* IN Grip Handle */}
                              <button
                                type="button"
                                aria-label="切り抜き開始位置"
                                onPointerDown={(e) => handleTimelinePointerDown('start', e)}
                                onPointerMove={handleTimelinePointerMove}
                                onPointerUp={handleTimelinePointerUp}
                                onPointerCancel={handleTimelinePointerUp}
                                className="absolute z-20 flex h-7 w-3.5 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded border-2 border-[#fafafa]"
                                style={{
                                  left: `${(clipStart / totalDur) * 100}%`,
                                  backgroundColor: 'var(--md-primary)',
                                }}
                                title={`開始位置 ${formatDuration(clipStart)}`}
                              >
                                <span className="h-3 w-0.5 rounded-full bg-[#fafafa]/80" />
                              </button>

                              {/* OUT Grip Handle */}
                              <button
                                type="button"
                                aria-label="切り抜き終了位置"
                                onPointerDown={(e) => handleTimelinePointerDown('end', e)}
                                onPointerMove={handleTimelinePointerMove}
                                onPointerUp={handleTimelinePointerUp}
                                onPointerCancel={handleTimelinePointerUp}
                                className="absolute z-20 flex h-7 w-3.5 -translate-x-1/2 cursor-ew-resize items-center justify-center rounded border-2 border-[#fafafa]"
                                style={{
                                  left: `${(clipEnd / totalDur) * 100}%`,
                                  backgroundColor: '#f59c97',
                                }}
                                title={`終了位置 ${formatDuration(clipEnd)}`}
                              >
                                <span className="h-3 w-0.5 rounded-full bg-[#141415]/80" />
                              </button>
                            </div>

                            {/* Timecode Ruler Ticks */}
                            <div
                              className="font-mono-tabular flex items-center justify-between text-[10px]"
                              style={{ color: 'var(--md-on-surface-muted)' }}
                            >
                              {[0, 0.25, 0.5, 0.75, 1].map((r) => (
                                <span key={r}>{formatDuration(Math.round(totalDur * r))}</span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Precision Nudge & In/Out Toolbar */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1">
                            {[
                              [-10, '-10s'],
                              [-1, '-1s'],
                            ].map(([delta, lbl]) => (
                              <button
                                key={String(lbl)}
                                type="button"
                                onClick={() => stepPreview(Number(delta))}
                                className="font-mono-tabular h-7 rounded-lg border px-2 text-[11px] hover:bg-[var(--md-surface-highest)]"
                                style={{
                                  backgroundColor: 'var(--md-surface-high)',
                                  borderColor: 'var(--md-outline-variant)',
                                  color: 'var(--md-on-surface-variant)',
                                }}
                              >
                                {lbl}
                              </button>
                            ))}
                            <button
                              type="button"
                              onClick={togglePlayPreview}
                              className="flex h-7 items-center gap-1 rounded-lg border px-2.5 text-[11px] font-medium"
                              style={{
                                backgroundColor: 'var(--md-surface-highest)',
                                borderColor: 'var(--md-outline-variant)',
                                color: 'var(--md-on-surface)',
                              }}
                            >
                              {previewPlaying ? <Pause size={12} strokeWidth={1.5} /> : <Play size={12} strokeWidth={1.5} />}
                              <span>{previewPlaying ? '停止' : '再生'}</span>
                            </button>
                            {[
                              [1, '+1s'],
                              [10, '+10s'],
                            ].map(([delta, lbl]) => (
                              <button
                                key={String(lbl)}
                                type="button"
                                onClick={() => stepPreview(Number(delta))}
                                className="font-mono-tabular h-7 rounded-lg border px-2 text-[11px] hover:bg-[var(--md-surface-highest)]"
                                style={{
                                  backgroundColor: 'var(--md-surface-high)',
                                  borderColor: 'var(--md-outline-variant)',
                                  color: 'var(--md-on-surface-variant)',
                                }}
                              >
                                {lbl}
                              </button>
                            ))}
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => setFromPreviewTime('start')}
                              className="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium"
                              style={{
                                backgroundColor: 'var(--md-primary-tonal)',
                                borderColor: 'var(--md-primary)',
                                color: 'var(--md-on-primary-tonal)',
                              }}
                            >
                              <kbd className="studio-kbd">I</kbd>
                              <span>ここを開始に</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setFromPreviewTime('end')}
                              className="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium"
                              style={{
                                backgroundColor: 'var(--md-surface-high)',
                                borderColor: 'var(--md-outline-variant)',
                                color: 'var(--md-on-surface)',
                              }}
                            >
                              <kbd className="studio-kbd">O</kbd>
                              <span>ここを終了に</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => seekPreviewTo(clipStart, true)}
                              className="h-7 rounded-lg border px-2 text-[11px]"
                              style={{
                                backgroundColor: 'var(--md-surface-high)',
                                borderColor: 'var(--md-outline-variant)',
                                color: 'var(--md-on-surface-variant)',
                              }}
                            >
                              頭出し
                            </button>
                            <button
                              type="button"
                              onClick={() => seekPreviewTo(Math.max(clipStart, clipEnd - 3), true)}
                              className="h-7 rounded-lg border px-2 text-[11px]"
                              style={{
                                backgroundColor: 'var(--md-surface-high)',
                                borderColor: 'var(--md-outline-variant)',
                                color: 'var(--md-on-surface-variant)',
                              }}
                            >
                              末尾3秒
                            </button>
                            <button
                              type="button"
                              onClick={() => setLoopSegment((v) => !v)}
                              className="flex h-7 items-center gap-1 rounded-lg border px-2 text-[11px]"
                              style={{
                                backgroundColor: loopSegment ? 'var(--md-primary-tonal)' : 'var(--md-surface-high)',
                                borderColor: loopSegment ? 'var(--md-primary)' : 'var(--md-outline-variant)',
                                color: loopSegment ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-muted)',
                              }}
                            >
                              <Repeat size={11} strokeWidth={1.5} />
                              <span>ループ</span>
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  videoInfo && (
                    <div className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                      プレビュー用映像ストリームが取得できない動画のため、下のタイムコード入力で区間を指定してください
                    </div>
                  )
                )}

                <div className="grid grid-cols-3 gap-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                      開始時刻
                    </label>
                    <input
                      type="text"
                      value={startInput}
                      onChange={(e) => setStartInput(e.target.value)}
                      onBlur={applyStartText}
                      onKeyDown={(e) => e.key === 'Enter' && applyStartText()}
                      className="font-mono-tabular h-9 rounded-lg border px-3 text-[13px] outline-none"
                      style={{
                        backgroundColor: 'var(--md-surface-high)',
                        borderColor: 'var(--md-outline-variant)',
                        color: 'var(--md-on-surface)',
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                      終了時刻
                    </label>
                    <input
                      type="text"
                      value={endInput}
                      onChange={(e) => setEndInput(e.target.value)}
                      onBlur={applyEndText}
                      onKeyDown={(e) => e.key === 'Enter' && applyEndText()}
                      className="font-mono-tabular h-9 rounded-lg border px-3 text-[13px] outline-none"
                      style={{
                        backgroundColor: 'var(--md-surface-high)',
                        borderColor: 'var(--md-outline-variant)',
                        color: 'var(--md-on-surface)',
                      }}
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                      切り抜き長
                    </span>
                    <div
                      className="font-mono-tabular flex h-9 items-center rounded-lg border px-3 text-[13px]"
                      style={{
                        backgroundColor: 'var(--md-surface)',
                        borderColor: 'var(--md-outline-variant)',
                        color: 'var(--md-on-surface)',
                      }}
                    >
                      {formatDuration(clipSpan)}
                    </div>
                  </div>
                </div>

                <p className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  コメントのタイムスタンプも切り抜き開始時刻に合わせて自動シフトされ、範囲内のチャットのみが合成されます
                </p>
              </div>
            ) : (
              <p className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                配信全体をそのままダウンロードします。長いアーカイブのハイライトだけ抜きたい場合は「区間指定オン」に切り替えてください
              </p>
            )}
          </div>
        </div>

        {/* Right Column (5 cols): Output Mode & Comment Style & Hardware Encode Settings */}
        <div className="col-span-12 flex flex-col gap-5 lg:col-span-5">
          <div
            className="flex flex-col gap-5 rounded-2xl border p-5"
            style={{
              backgroundColor: 'var(--md-surface-low)',
              borderColor: 'var(--md-outline-variant)',
            }}
          >
            {/* Output Mode Segmented Control */}
            <div className="flex flex-col gap-2">
              <span className="text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                コメント合成モード
              </span>
              <div
                className="grid grid-cols-3 gap-1 rounded-xl p-1"
                style={{ backgroundColor: 'var(--md-surface)' }}
              >
                {(
                  [
                    ['with_comments', 'コメント合成'],
                    ['video_only', '動画のみ'],
                    ['both', '両方出力'],
                  ] as Array<[OutputMode, string]>
                ).map(([mode, label]) => {
                  const active = encodeConfig.output_mode === mode
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => onChangeEncode({ ...encodeConfig, output_mode: mode })}
                      className="ease-studio h-8 rounded-lg text-[12px] font-medium transition-colors duration-150"
                      style={{
                        backgroundColor: active ? 'var(--md-surface-highest)' : 'transparent',
                        color: active ? 'var(--md-on-surface)' : 'var(--md-on-surface-muted)',
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
              {encodeConfig.output_mode === 'video_only' && (
                <p className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  ※ 元動画とコンテナ・コーデックが一致し FPS制限なし・全編時は無劣化高速コピーします
                </p>
              )}
            </div>

            {/* Comment Style Preset Selector (directly under synthesis mode) */}
            <div
              className="flex flex-col gap-2.5 rounded-xl border p-3.5 transition-opacity duration-150"
              style={{
                backgroundColor: 'var(--md-surface)',
                borderColor: 'var(--md-outline-variant)',
                opacity: encodeConfig.output_mode === 'video_only' ? 0.45 : 1,
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                  コメントスタイルプリセット
                </span>
                <span className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  {encodeConfig.output_mode === 'video_only' ? '動画のみモードでは無効' : '合成時に適用'}
                </span>
              </div>

              <select
                value={activePresetId}
                onChange={(e) => onSelectPreset(e.target.value)}
                disabled={encodeConfig.output_mode === 'video_only'}
                className="h-9 w-full rounded-lg border px-3 text-[13px] outline-none disabled:cursor-not-allowed"
                style={{
                  backgroundColor: 'var(--md-surface-high)',
                  borderColor: 'var(--md-outline-variant)',
                  color: 'var(--md-on-surface)',
                }}
              >
                {activePresetId === 'custom' && (
                  <option value="custom" disabled>
                    カスタム調整スタイル
                  </option>
                )}
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={onOpenCommentStudio}
                  className="flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium"
                  style={{
                    backgroundColor: 'var(--md-surface-high)',
                    borderColor: 'var(--md-outline-variant)',
                    color: 'var(--md-on-surface)',
                  }}
                >
                  <SlidersHorizontal size={13} strokeWidth={1.5} />
                  <span>細かく調整</span>
                </button>

                <button
                  type="button"
                  onClick={() => onOpenFullscreenPreview(videoInfo?.thumbnail)}
                  className="flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium"
                  style={{
                    backgroundColor: 'var(--md-surface-high)',
                    borderColor: 'var(--md-outline-variant)',
                    color: 'var(--md-on-surface)',
                  }}
                >
                  <Maximize2 size={13} strokeWidth={1.5} />
                  <span>全画面プレビュー</span>
                </button>
              </div>
            </div>

            {/* Video Quality & FPS */}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  最大解像度
                </label>
                <select
                  value={encodeConfig.resolution}
                  onChange={(e) => onChangeEncode({ ...encodeConfig, resolution: e.target.value })}
                  className="h-9 rounded-lg border px-2.5 text-[13px] outline-none"
                  style={{
                    backgroundColor: 'var(--md-surface-high)',
                    borderColor: 'var(--md-outline-variant)',
                    color: 'var(--md-on-surface)',
                  }}
                >
                  <option value="best">最高画質 (自動)</option>
                  {availableRes.map((r) => (
                    <option key={r} value={String(r)}>
                      {r}p
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  フレームレート上限
                </label>
                <select
                  value={encodeConfig.max_fps}
                  onChange={(e) => onChangeEncode({ ...encodeConfig, max_fps: Number(e.target.value) })}
                  className="h-9 rounded-lg border px-2.5 text-[13px] outline-none"
                  style={{
                    backgroundColor: 'var(--md-surface-high)',
                    borderColor: 'var(--md-outline-variant)',
                    color: 'var(--md-on-surface)',
                  }}
                >
                  <option value={0}>制限なし (ソース準拠)</option>
                  <option value={60}>60 fps</option>
                  <option value={30}>30 fps</option>
                </select>
              </div>
            </div>

            {/* Codec & Hardware Encoder */}
            <div className="flex flex-col gap-3 border-t pt-4" style={{ borderColor: 'var(--md-outline-variant)' }}>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                  <Cpu size={15} strokeWidth={1.5} style={{ color: 'var(--md-on-surface-muted)' }} />
                  ハードウェアエンコード
                </span>
                <span className="font-mono-tabular text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  {encoders?.available_hw?.length
                    ? `検出: ${encoders.available_hw.map((h) => h.toUpperCase()).join(', ')}`
                    : 'CPU / 未検出'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                    映像コーデック
                  </label>
                  <select
                    value={encodeConfig.codec}
                    onChange={(e) =>
                      onChangeEncode({ ...encodeConfig, codec: e.target.value as EncodeConfig['codec'] })
                    }
                    className="h-9 rounded-lg border px-2.5 text-[13px] outline-none"
                    style={{
                      backgroundColor: 'var(--md-surface-high)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface)',
                    }}
                  >
                    <option value="h264">H.264 (AVC · 互換性高)</option>
                    <option value="h265">H.265 (HEVC · 高圧縮)</option>
                    <option value="av1">AV1 (最新 · 対応GPUのみ)</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                    アクセラレーション
                  </label>
                  <select
                    value={encodeConfig.hw_encoder}
                    onChange={(e) =>
                      onChangeEncode({
                        ...encodeConfig,
                        hw_encoder: e.target.value as EncodeConfig['hw_encoder'],
                      })
                    }
                    className="h-9 rounded-lg border px-2.5 text-[13px] outline-none"
                    style={{
                      backgroundColor: 'var(--md-surface-high)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface)',
                    }}
                  >
                    <option value="auto">自動選択 (推奨)</option>
                    <option value="nvenc">NVIDIA NVENC</option>
                    <option value="qsv">Intel QSV</option>
                    <option value="amf">AMD AMF</option>
                    <option value="cpu">CPU (ソフトウェア)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                    エンコード速度
                  </label>
                  <select
                    value={encodeConfig.preset_speed}
                    onChange={(e) =>
                      onChangeEncode({
                        ...encodeConfig,
                        preset_speed: e.target.value as EncodeConfig['preset_speed'],
                      })
                    }
                    className="h-9 rounded-lg border px-2.5 text-[13px] outline-none"
                    style={{
                      backgroundColor: 'var(--md-surface-high)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface)',
                    }}
                  >
                    <option value="fast">高速 (Fast)</option>
                    <option value="medium">標準 (Balanced)</option>
                    <option value="slow">高画質 (Slow)</option>
                  </select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                    出力コンテナ
                  </label>
                  <select
                    value={encodeConfig.container}
                    onChange={(e) =>
                      onChangeEncode({
                        ...encodeConfig,
                        container: e.target.value as EncodeConfig['container'],
                      })
                    }
                    className="h-9 rounded-lg border px-2.5 text-[13px] outline-none"
                    style={{
                      backgroundColor: 'var(--md-surface-high)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface)',
                    }}
                  >
                    <option value="mp4">MP4 (.mp4)</option>
                    <option value="mkv">Matroska (.mkv)</option>
                  </select>
                </div>
              </div>

              <label className="flex flex-col gap-1.5 text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                <div className="flex justify-between">
                  <span>品質 CQ / CRF（低いほど高画質・大容量）</span>
                  <span className="font-mono-tabular font-medium" style={{ color: 'var(--md-on-surface)' }}>
                    {encodeConfig.quality_cq}
                  </span>
                </div>
                <input
                  type="range"
                  min={14}
                  max={30}
                  step={1}
                  value={encodeConfig.quality_cq}
                  onChange={(e) => onChangeEncode({ ...encodeConfig, quality_cq: Number(e.target.value) })}
                  className="m3-slider"
                />
              </label>

              <label
                className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5"
                style={{
                  backgroundColor: 'var(--md-surface)',
                  borderColor: 'var(--md-outline-variant)',
                }}
              >
                <div className="min-w-0">
                  <div className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                    サムネイル画像を同時に保存
                  </div>
                  <div className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                    動画と同じ出力フォルダへサムネ画像も書き出します
                  </div>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(encodeConfig.download_thumbnail)}
                  onChange={(e) =>
                    onChangeEncode({ ...encodeConfig, download_thumbnail: e.target.checked })
                  }
                  className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--md-primary)]"
                />
              </label>
            </div>

            {/* Primary CTA */}
            <button
              type="button"
              onClick={handleEnqueue}
              disabled={submitting || (!videoInfo && !url.trim())}
              className="ease-studio mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-xl text-[14px] font-medium transition-opacity duration-150 disabled:opacity-40"
              style={{
                backgroundColor: 'var(--md-primary)',
                color: 'var(--md-on-primary)',
              }}
            >
              {submitting ? <Loader2 size={17} strokeWidth={1.5} className="animate-spin" /> : <Plus size={17} strokeWidth={1.5} />}
              <span>ダウンロード＆合成キューに追加</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
