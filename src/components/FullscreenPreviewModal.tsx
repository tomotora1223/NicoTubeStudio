import { useEffect, useRef, useState } from 'react'
import { Monitor, SlidersHorizontal, X } from 'lucide-react'
import type { CommentStyleConfig } from '../types/studio'
import { DanmakuCanvas, type PreviewBackdrop } from './DanmakuCanvas'
import type { PreviewScenario } from '../lib/danmakuEngine'

interface FullscreenPreviewModalProps {
  open: boolean
  onClose: () => void
  styleConfig: CommentStyleConfig
  onChangeStyle: (next: CommentStyleConfig) => void
  thumbnailUrl?: string | null
}

export function FullscreenPreviewModal({
  open,
  onClose,
  styleConfig,
  onChangeStyle,
  thumbnailUrl,
}: FullscreenPreviewModalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [scenario, setScenario] = useState<PreviewScenario>('longtext')
  const [backdrop, setBackdrop] = useState<PreviewBackdrop>('game')
  const [showQuickTweak, setShowQuickTweak] = useState(false)
  const [isNativeFs, setIsNativeFs] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {})
        } else {
          onClose()
        }
      }
    }
    const onFsChange = () => setIsNativeFs(Boolean(document.fullscreenElement))
    window.addEventListener('keydown', onKey)
    document.addEventListener('fullscreenchange', onFsChange)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onFsChange)
    }
  }, [open, onClose])

  if (!open) return null

  const toggleNativeFs = () => {
    if (!containerRef.current) return
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      containerRef.current.requestFullscreen().catch(() => {})
    }
  }

  const handleCloseAll = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
    onClose()
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999] flex flex-col justify-between px-6 pt-10 pb-5"
      style={{ backgroundColor: '#0b0b0c', WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Top Studio Bar */}
      <div className="relative z-20 flex shrink-0 flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="text-[14px] font-medium" style={{ color: '#ededed' }}>
            全画面テストプレビュー
          </span>
          <span className="font-mono-tabular text-[12px]" style={{ color: '#85858b' }}>
            短文 · 長文 · 弾幕 · スパチャ全色 · メンバー · スタンプ確認
          </span>
        </div>

        <div className="flex items-center gap-2 pr-2">
          <button
            type="button"
            onClick={() => setShowQuickTweak((v) => !v)}
            className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium"
            style={{
              backgroundColor: showQuickTweak ? 'var(--md-primary-tonal)' : '#1f1f22',
              borderColor: 'rgba(237,237,237,0.12)',
              color: showQuickTweak ? '#f59c97' : '#ededed',
            }}
          >
            <SlidersHorizontal size={14} strokeWidth={1.5} />
            <span>ライブ微調整</span>
          </button>

          <button
            type="button"
            onClick={toggleNativeFs}
            className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium"
            style={{
              backgroundColor: '#1f1f22',
              borderColor: 'rgba(237,237,237,0.12)',
              color: '#ededed',
            }}
          >
            <Monitor size={14} strokeWidth={1.5} />
            <span>{isNativeFs ? 'ウィンドウに戻す' : 'モニター全画面'}</span>
          </button>

          <button
            type="button"
            onClick={handleCloseAll}
            className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium"
            style={{
              backgroundColor: '#2c1c1e',
              borderColor: 'rgba(232,93,86,0.45)',
              color: '#f5b8b4',
            }}
            title="閉じる (Esc)"
          >
            <X size={15} strokeWidth={1.5} />
            <span>閉じる (Esc)</span>
          </button>
        </div>
      </div>

      {/* Center Stage + Optional Quick Tweak Drawer */}
      <div className="relative z-10 my-auto flex min-h-0 flex-1 items-center justify-center gap-4 overflow-hidden py-3">
        <div className="flex h-full max-h-full w-full max-w-[1440px] flex-col justify-center">
          <DanmakuCanvas
            styleConfig={styleConfig}
            thumbnailUrl={thumbnailUrl}
            scenario={scenario}
            onScenarioChange={setScenario}
            backdrop={backdrop}
            onBackdropChange={setBackdrop}
            isFullscreenView
          />
        </div>

        {showQuickTweak && (
          <div
            className="flex w-72 shrink-0 flex-col gap-4 rounded-xl border p-4"
            style={{
              backgroundColor: '#19191b',
              borderColor: 'rgba(237,237,237,0.12)',
            }}
          >
            <div className="text-[13px] font-medium" style={{ color: '#ededed' }}>
              ライブ調整（即時反映）
            </div>

            <label className="flex flex-col gap-1.5 text-[12px]" style={{ color: '#a1a1a6' }}>
              <div className="flex justify-between">
                <span>文字サイズ倍率</span>
                <span className="font-mono-tabular text-[#ededed]">{styleConfig.font_scale.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={2.0}
                step={0.05}
                value={styleConfig.font_scale}
                onChange={(e) => onChangeStyle({ ...styleConfig, font_scale: Number(e.target.value) })}
                className="m3-slider"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-[12px]" style={{ color: '#a1a1a6' }}>
              <div className="flex justify-between">
                <span>流れる時間</span>
                <span className="font-mono-tabular text-[#ededed]">{styleConfig.scroll_duration_sec.toFixed(1)}秒</span>
              </div>
              <input
                type="range"
                min={2.0}
                max={9.0}
                step={0.2}
                value={styleConfig.scroll_duration_sec}
                onChange={(e) =>
                  onChangeStyle({ ...styleConfig, scroll_duration_sec: Number(e.target.value) })
                }
                className="m3-slider"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-[12px]" style={{ color: '#a1a1a6' }}>
              <div className="flex justify-between">
                <span>不透明度</span>
                <span className="font-mono-tabular text-[#ededed]">{Math.round(styleConfig.opacity * 100)}%</span>
              </div>
              <input
                type="range"
                min={0.2}
                max={1.0}
                step={0.05}
                value={styleConfig.opacity}
                onChange={(e) => onChangeStyle({ ...styleConfig, opacity: Number(e.target.value) })}
                className="m3-slider"
              />
            </label>

            <label className="flex flex-col gap-1.5 text-[12px]" style={{ color: '#a1a1a6' }}>
              <div className="flex justify-between">
                <span>表示エリア（上から）</span>
                <span className="font-mono-tabular text-[#ededed]">
                  {Math.round(styleConfig.display_area_ratio * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.25}
                max={1.0}
                step={0.05}
                value={styleConfig.display_area_ratio}
                onChange={(e) =>
                  onChangeStyle({ ...styleConfig, display_area_ratio: Number(e.target.value) })
                }
                className="m3-slider"
              />
            </label>
          </div>
        )}
      </div>

      {/* Bottom Easy Escape Bar (always reachable in monitor fullscreen too) */}
      <div className="relative z-20 flex shrink-0 justify-center pt-1">
        <button
          type="button"
          onClick={handleCloseAll}
          className="flex h-8 items-center gap-1.5 rounded-full border px-4 text-[12px] font-medium"
          style={{
            backgroundColor: 'rgba(25, 25, 27, 0.9)',
            borderColor: 'rgba(237,237,237,0.16)',
            color: '#ededed',
          }}
        >
          <X size={13} strokeWidth={1.5} />
          <span>全画面プレビューを終了 (Esc)</span>
        </button>
      </div>
    </div>
  )
}
