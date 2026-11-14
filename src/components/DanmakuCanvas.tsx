import { useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2, Pause, Play, RotateCcw } from 'lucide-react'
import type { CommentStyleConfig } from '../types/studio'
import { loadDynamicFontFace } from '../lib/api'
import {
  buildPreviewScenario,
  drawDanmakuFrame,
  scheduleSimComments,
  type PreviewScenario,
  type ScheduledSimComment,
} from '../lib/danmakuEngine'

export type PreviewBackdrop = 'studio' | 'game' | 'bright' | 'thumbnail'

interface DanmakuCanvasProps {
  styleConfig: CommentStyleConfig
  thumbnailUrl?: string | null
  scenario?: PreviewScenario
  onScenarioChange?: (s: PreviewScenario) => void
  backdrop?: PreviewBackdrop
  onBackdropChange?: (b: PreviewBackdrop) => void
  onOpenFullscreen?: () => void
  isFullscreenView?: boolean
  compactControls?: boolean
}

const LOOP_SECONDS = 32

export function DanmakuCanvas({
  styleConfig,
  thumbnailUrl,
  scenario: controlledScenario,
  onScenarioChange,
  backdrop: controlledBackdrop,
  onBackdropChange,
  onOpenFullscreen,
  isFullscreenView = false,
  compactControls = false,
}: DanmakuCanvasProps) {
  const [localScenario, setLocalScenario] = useState<PreviewScenario>('standard')
  const [localBackdrop, setLocalBackdrop] = useState<PreviewBackdrop>('game')
  const scenario = controlledScenario ?? localScenario
  const backdrop = controlledBackdrop ?? localBackdrop

  const setScenario = (s: PreviewScenario) => {
    setLocalScenario(s)
    onScenarioChange?.(s)
  }
  const setBackdrop = (b: PreviewBackdrop) => {
    setLocalBackdrop(b)
    onBackdropChange?.(b)
  }

  const [playing, setPlaying] = useState(true)
  const [currentTime, setCurrentTime] = useState(1.8)
  const [activeCount, setActiveCount] = useState(0)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const thumbImgRef = useRef<HTMLImageElement | null>(null)
  const timeRef = useRef(1.8)
  const playingRef = useRef(true)
  const scheduledRef = useRef<ScheduledSimComment[]>([])
  const styleRef = useRef(styleConfig)

  styleRef.current = styleConfig
  playingRef.current = playing

  useEffect(() => {
    if (!thumbnailUrl) {
      thumbImgRef.current = null
      return
    }
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = thumbnailUrl
    img.onload = () => {
      thumbImgRef.current = img
    }
  }, [thumbnailUrl])

  const simComments = useMemo(() => buildPreviewScenario(scenario, LOOP_SECONDS), [scenario])

  // Recompute lane schedule instantly whenever styleConfig, font, or scenario changes
  useEffect(() => {
    let cancelled = false
    const runSchedule = () => {
      if (cancelled) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      scheduledRef.current = scheduleSimComments(ctx, simComments, canvas.width, canvas.height, styleConfig)
    }
    runSchedule()
    loadDynamicFontFace(styleConfig.font_family)
      .then(async () => {
        if (document.fonts) await document.fonts.ready
        runSchedule()
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [simComments, styleConfig])

  // 60fps render loop
  useEffect(() => {
    let rafId = 0
    let lastTs = performance.now()
    let uiSyncAccum = 0

    const renderFrame = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000)
      lastTs = now

      if (playingRef.current) {
        timeRef.current = (timeRef.current + dt) % LOOP_SECONDS
      }

      const canvas = canvasRef.current
      if (canvas) {
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const w = canvas.width
          const h = canvas.height
          ctx.clearRect(0, 0, w, h)

          // Draw selected backdrop
          if (backdrop === 'bright') {
            ctx.fillStyle = '#e4e7ec'
            ctx.fillRect(0, 0, w, h)
            ctx.fillStyle = '#cfd5df'
            ctx.fillRect(w * 0.08, h * 0.14, w * 0.84, h * 0.72)
          } else if (backdrop === 'thumbnail' && thumbImgRef.current) {
            ctx.drawImage(thumbImgRef.current, 0, 0, w, h)
            ctx.fillStyle = 'rgba(0,0,0,0.18)'
            ctx.fillRect(0, 0, w, h)
          } else if (backdrop === 'game') {
            ctx.fillStyle = '#111419'
            ctx.fillRect(0, 0, w, h)
            // Simulated broadcast HUD so user can judge occlusion & legibility
            ctx.strokeStyle = 'rgba(255,255,255,0.06)'
            ctx.lineWidth = 1
            for (let gx = 80; gx < w; gx += 80) {
              ctx.beginPath()
              ctx.moveTo(gx, 0)
              ctx.lineTo(gx, h)
              ctx.stroke()
            }
            for (let gy = 80; gy < h; gy += 80) {
              ctx.beginPath()
              ctx.moveTo(0, gy)
              ctx.lineTo(w, gy)
              ctx.stroke()
            }
            // Simulated streamer facecam box & bottom subtitle zone
            ctx.fillStyle = 'rgba(255,255,255,0.05)'
            ctx.fillRect(w - 230, h - 148, 206, 124)
            ctx.strokeStyle = 'rgba(255,255,255,0.12)'
            ctx.strokeRect(w - 230, h - 148, 206, 124)
            ctx.fillStyle = 'rgba(255,255,255,0.38)'
            ctx.font = '500 13px "Inter", "Yu Gothic UI", sans-serif'
            ctx.fillText('Facecam / UI Area', w - 214, h - 124)
            ctx.fillStyle = 'rgba(255,255,255,0.04)'
            ctx.fillRect(24, h - 56, 420, 32)
            ctx.fillStyle = 'rgba(255,255,255,0.35)'
            ctx.fillText('16:9 Stream Preview · 1280×720 Stage', 38, h - 35)
          } else {
            ctx.fillStyle = '#0d0d0f'
            ctx.fillRect(0, 0, w, h)
          }

          // Display area limit guide when < 100%
          const st = styleRef.current
          if (st.display_area_ratio < 0.99) {
            const limitY = h * st.display_area_ratio
            ctx.save()
            ctx.setLineDash([6, 6])
            ctx.strokeStyle = 'rgba(232, 93, 86, 0.55)'
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.moveTo(0, limitY)
            ctx.lineTo(w, limitY)
            ctx.stroke()
            ctx.restore()
          }

          const count = drawDanmakuFrame(ctx, scheduledRef.current, timeRef.current, w, h, st)

          uiSyncAccum += dt
          if (uiSyncAccum >= 0.08) {
            uiSyncAccum = 0
            setCurrentTime(timeRef.current)
            setActiveCount(count)
          }
        }
      }

      rafId = requestAnimationFrame(renderFrame)
    }

    rafId = requestAnimationFrame(renderFrame)
    return () => cancelAnimationFrame(rafId)
  }, [backdrop])

  const handleSeek = (val: number) => {
    timeRef.current = val
    setCurrentTime(val)
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Top Scenario & Backdrop Controls */}
      {!compactControls && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--md-surface)' }}>
            {(
              [
                ['standard', '通常配信'],
                ['barrage', '弾幕ラッシュ'],
                ['longtext', '長文・全色スパチャ'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setScenario(key)}
                className="ease-studio rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors duration-150"
                style={{
                  backgroundColor: scenario === key ? 'var(--md-surface-highest)' : 'transparent',
                  color: scenario === key ? 'var(--md-on-surface)' : 'var(--md-on-surface-muted)',
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg p-1" style={{ backgroundColor: 'var(--md-surface)' }}>
              {(
                [
                  ['game', '配信UI模擬'],
                  ['studio', '黒背景'],
                  ['bright', '明背景'],
                  ...(thumbnailUrl ? ([['thumbnail', '動画サムネ']] as const) : []),
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setBackdrop(key)}
                  className="ease-studio rounded-md px-2 py-1 text-[12px] font-medium transition-colors duration-150"
                  style={{
                    backgroundColor: backdrop === key ? 'var(--md-surface-highest)' : 'transparent',
                    color: backdrop === key ? 'var(--md-on-surface)' : 'var(--md-on-surface-muted)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {!isFullscreenView && onOpenFullscreen && (
              <button
                type="button"
                onClick={onOpenFullscreen}
                className="ease-studio flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium transition-colors duration-150"
                style={{
                  backgroundColor: 'var(--md-surface-high)',
                  borderColor: 'var(--md-outline)',
                  color: 'var(--md-on-surface)',
                }}
              >
                <Maximize2 size={14} strokeWidth={1.6} />
                <span>全画面プレビュー</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 16:9 Canvas Stage */}
      <div
        className="relative w-full overflow-hidden rounded-xl border"
        style={{
          aspectRatio: '16 / 9',
          borderColor: 'var(--md-outline-variant)',
          backgroundColor: '#0d0d0f',
        }}
      >
        <canvas ref={canvasRef} width={1280} height={720} className="h-full w-full object-contain" />
        <div
          className="font-mono-tabular pointer-events-none absolute top-2.5 right-2.5 rounded-md px-2 py-0.5 text-[11px]"
          style={{
            backgroundColor: 'rgba(15, 15, 16, 0.72)',
            color: '#a1a1a6',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          同時 {activeCount}件
        </div>
      </div>

      {/* Transport Bar */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          className="ease-studio flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors duration-150"
          style={{
            backgroundColor: 'var(--md-surface-high)',
            borderColor: 'var(--md-outline-variant)',
            color: 'var(--md-on-surface)',
          }}
          title={playing ? '一時停止' : '再生'}
        >
          {playing ? <Pause size={15} strokeWidth={1.6} /> : <Play size={15} strokeWidth={1.6} />}
        </button>

        <button
          type="button"
          onClick={() => handleSeek(0)}
          className="ease-studio flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-colors duration-150"
          style={{
            backgroundColor: 'var(--md-surface-high)',
            borderColor: 'var(--md-outline-variant)',
            color: 'var(--md-on-surface-variant)',
          }}
          title="最初から再生"
        >
          <RotateCcw size={14} strokeWidth={1.6} />
        </button>

        <input
          type="range"
          min={0}
          max={LOOP_SECONDS}
          step={0.1}
          value={currentTime}
          onChange={(e) => handleSeek(Number(e.target.value))}
          className="m3-slider flex-1"
        />

        <span className="font-mono-tabular w-24 text-right text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
          {currentTime.toFixed(1)}s / {LOOP_SECONDS}s
        </span>
      </div>
    </div>
  )
}
