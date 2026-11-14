import { useState } from 'react'
import {
  CheckCircle2,
  FolderOpen,
  Layers,
  Loader2,
  Play,
  RotateCw,
  Trash2,
  XCircle,
} from 'lucide-react'
import { api, formatDuration } from '../lib/api'
import type { QueueJob } from '../types/studio'

interface QueueViewProps {
  jobs: QueueJob[]
  onRefresh: () => void
}

const MODE_LABELS: Record<string, string> = {
  with_comments: 'コメント合成',
  video_only: '動画のみ',
  both: '両方出力',
}

export function QueueView({ jobs, onRefresh }: QueueViewProps) {
  const [cancellingIds, setCancellingIds] = useState<Record<string, boolean>>({})

  const handleClear = async () => {
    await api.clearQueue()
    onRefresh()
  }

  const handleCancel = async (id: string) => {
    setCancellingIds((prev) => ({ ...prev, [id]: true }))
    try {
      await api.cancelJob(id)
      onRefresh()
    } finally {
      setCancellingIds((prev) => {
        const copy = { ...prev }
        delete copy[id]
        return copy
      })
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-6 px-8 py-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-medium tracking-tight" style={{ color: 'var(--md-on-surface)' }}>
            処理キュー
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--md-on-surface-variant)' }}>
            ダウンロード・スタンプ取得・コメント合成とハードウェアエンコードの進行状況を管理します
          </p>
        </div>

        {jobs.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            className="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium"
            style={{
              backgroundColor: 'var(--md-surface-high)',
              borderColor: 'var(--md-outline-variant)',
              color: 'var(--md-on-surface-variant)',
            }}
          >
            <Trash2 size={14} strokeWidth={1.5} />
            <span>完了・失敗をクリア</span>
          </button>
        )}
      </div>

      {jobs.length > 0 && (
        <div
          className="font-mono-tabular flex flex-wrap items-center gap-4 rounded-xl border px-4 py-2.5 text-[12px]"
          style={{
            backgroundColor: 'var(--md-surface-low)',
            borderColor: 'var(--md-outline-variant)',
            color: 'var(--md-on-surface-variant)',
          }}
        >
          <span>
            合計 <strong className="font-medium" style={{ color: 'var(--md-on-surface)' }}>{jobs.length}</strong>件
          </span>
          <span style={{ color: 'var(--md-outline)' }}>|</span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'var(--md-primary)' }} />
            処理中 {jobs.filter((j) => j.status === 'downloading' || j.status === 'parsing_chat' || j.status === 'rendering').length}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'var(--md-on-surface-muted)' }} />
            待機 {jobs.filter((j) => j.status === 'queued').length}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'var(--md-positive)' }} />
            完了 {jobs.filter((j) => j.status === 'completed').length}
          </span>
          {jobs.some((j) => j.status === 'failed' || j.status === 'cancelled') && (
            <span className="flex items-center gap-1.5" style={{ color: 'var(--md-negative)' }}>
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'var(--md-negative)' }} />
              停止/失敗 {jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').length}
            </span>
          )}
        </div>
      )}

      {jobs.length === 0 ? (
        <div
          className="flex h-64 flex-col items-center justify-center gap-2 rounded-2xl border text-center"
          style={{
            backgroundColor: 'var(--md-surface-low)',
            borderColor: 'var(--md-outline-variant)',
          }}
        >
          <Layers size={28} strokeWidth={1.3} style={{ color: 'var(--md-on-surface-muted)' }} />
          <div className="text-[14px] font-medium" style={{ color: 'var(--md-on-surface-variant)' }}>
            キューは空です
          </div>
          <div className="text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
            「取り込み・切り抜き」画面からYouTubeの配信を追加してください
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {jobs.map((job) => {
            const isRunning =
              job.status === 'downloading' ||
              job.status === 'parsing_chat' ||
              job.status === 'rendering' ||
              job.status === 'queued'
            const pct = Math.max(0, Math.min(100, Math.round(job.progress * 100)))
            const req = job.request
            const hasClip =
              (req.clip_start_sec !== null && req.clip_start_sec !== undefined) ||
              (req.clip_end_sec !== null && req.clip_end_sec !== undefined)

            const primaryFile =
              job.output_files.find((f) => /\.(mp4|mkv|webm|mov)$/i.test(f)) ||
              job.output_files[0]

            return (
              <div
                key={job.id}
                className="flex flex-col gap-3 rounded-2xl border p-4"
                style={{
                  backgroundColor: 'var(--md-surface-low)',
                  borderColor: 'var(--md-outline-variant)',
                }}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-1 items-start gap-3.5">
                    <div
                      className="h-16 w-28 shrink-0 overflow-hidden rounded-lg border"
                      style={{
                        borderColor: 'var(--md-outline-variant)',
                        backgroundColor: 'var(--md-surface)',
                      }}
                    >
                      {req.thumbnail && (
                        <img src={req.thumbnail} alt="" className="h-full w-full object-cover" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                        {req.title}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                        <span>{MODE_LABELS[req.encode.output_mode] || req.encode.output_mode}</span>
                        <span>·</span>
                        <span className="font-mono-tabular">
                          {req.encode.resolution === 'best' ? '最高画質' : `${req.encode.resolution}p`} / {req.encode.codec.toUpperCase()}
                        </span>
                        {hasClip && (
                          <>
                            <span>·</span>
                            <span className="font-mono-tabular">
                              区間 {formatDuration(req.clip_start_sec || 0)} – {formatDuration(req.clip_end_sec || req.duration_sec)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-1.5">
                    {job.status === 'completed' && primaryFile && (
                      <>
                        <button
                          type="button"
                          onClick={() => window.nicotube?.openPath(primaryFile)}
                          className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium"
                          style={{
                            backgroundColor: 'var(--md-surface-high)',
                            borderColor: 'var(--md-outline-variant)',
                            color: 'var(--md-on-surface)',
                          }}
                        >
                          <Play size={13} strokeWidth={1.6} />
                          <span>再生</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => window.nicotube?.showInFolder(primaryFile)}
                          className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium"
                          style={{
                            backgroundColor: 'var(--md-surface-high)',
                            borderColor: 'var(--md-outline-variant)',
                            color: 'var(--md-on-surface)',
                          }}
                        >
                          <FolderOpen size={13} strokeWidth={1.5} />
                          <span>フォルダ</span>
                        </button>
                      </>
                    )}

                    {(job.status === 'failed' || job.status === 'cancelled') && (
                      <button
                        type="button"
                        onClick={() => api.retryJob(job.id)}
                        className="flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[12px]"
                        style={{
                          backgroundColor: 'var(--md-surface-high)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-on-surface)',
                        }}
                      >
                        <RotateCw size={13} strokeWidth={1.5} />
                        <span>再試行</span>
                      </button>
                    )}

                    {isRunning ? (
                      <button
                        type="button"
                        disabled={Boolean(cancellingIds[job.id])}
                        onClick={() => handleCancel(job.id)}
                        className="flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[12px] disabled:opacity-50"
                        style={{
                          backgroundColor: 'var(--md-surface-high)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-negative)',
                        }}
                      >
                        <XCircle size={13} strokeWidth={1.5} />
                        <span>{cancellingIds[job.id] ? '中止中...' : '中止'}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => api.deleteJob(job.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border"
                        style={{
                          backgroundColor: 'var(--md-surface-high)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-on-surface-muted)',
                        }}
                        title="リストから削除"
                      >
                        <Trash2 size={13} strokeWidth={1.5} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Progress & Status Row */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[12px]">
                    <span className="flex items-center gap-1.5" style={{ color: 'var(--md-on-surface-variant)' }}>
                      {job.status === 'completed' && (
                        <CheckCircle2 size={14} strokeWidth={1.6} style={{ color: 'var(--md-positive)' }} />
                      )}
                      {job.status === 'failed' && (
                        <XCircle size={14} strokeWidth={1.6} style={{ color: 'var(--md-negative)' }} />
                      )}
                      {(job.status === 'downloading' ||
                        job.status === 'parsing_chat' ||
                        job.status === 'rendering') && (
                        <Loader2 size={13} className="animate-spin" style={{ color: 'var(--md-primary)' }} />
                      )}
                      <span>{job.stage_label}</span>
                    </span>

                    <div className="font-mono-tabular flex items-center gap-3 text-[12px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                      {job.fps > 0 && <span>{job.fps.toFixed(1)} fps</span>}
                      {job.speed && <span>{job.speed}</span>}
                      {typeof job.eta_sec === 'number' && job.eta_sec > 0 && (
                        <span>残り {formatDuration(job.eta_sec)}</span>
                      )}
                      <span style={{ color: 'var(--md-on-surface)' }}>{pct}%</span>
                    </div>
                  </div>

                  <div
                    className="h-1.5 w-full overflow-hidden rounded-full"
                    style={{ backgroundColor: 'var(--md-surface-high)' }}
                  >
                    <div
                      className="ease-studio h-full rounded-full transition-[width] duration-200"
                      style={{
                        width: `${pct}%`,
                        backgroundColor:
                          job.status === 'failed'
                            ? 'var(--md-negative)'
                            : job.status === 'completed'
                              ? 'var(--md-positive)'
                              : 'var(--md-primary)',
                      }}
                    />
                  </div>

                  {job.error && (
                    <div className="text-[12px]" style={{ color: 'var(--md-negative)' }}>
                      {job.error}
                    </div>
                  )}

                  {job.output_files.length > 0 && (
                    <div className="flex flex-col gap-1 pt-0.5">
                      {job.output_files.map((f) => {
                        const fileName = f.split(/[/\\]/).pop() || f
                        const extBadge = (fileName.split('.').pop() || '').toUpperCase()
                        return (
                          <div
                            key={f}
                            className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-[11px]"
                            style={{
                              backgroundColor: 'var(--md-surface)',
                              borderColor: 'var(--md-outline-variant)',
                              color: 'var(--md-on-surface-muted)',
                            }}
                          >
                            <div className="flex min-w-0 items-center gap-2">
                              {extBadge && (
                                <span
                                  className="font-mono-tabular shrink-0 rounded px-1.5 py-0.5 text-[10px]"
                                  style={{
                                    backgroundColor: 'var(--md-surface-high)',
                                    color: 'var(--md-on-surface-variant)',
                                  }}
                                >
                                  {extBadge}
                                </span>
                              )}
                              {f === primaryFile && (
                                <span
                                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
                                  style={{
                                    backgroundColor: 'var(--md-primary-tonal)',
                                    color: 'var(--md-on-primary-tonal)',
                                  }}
                                >
                                  主出力
                                </span>
                              )}
                              <span className="font-mono-tabular truncate" title={f}>
                                {fileName}
                              </span>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                onClick={() => window.nicotube?.openPath(f)}
                                className="rounded px-2 py-0.5 text-[11px]"
                                style={{
                                  backgroundColor: 'var(--md-surface-high)',
                                  color: 'var(--md-on-surface)',
                                }}
                              >
                                開く
                              </button>
                              <button
                                type="button"
                                onClick={() => window.nicotube?.showInFolder(f)}
                                className="rounded px-2 py-0.5 text-[11px]"
                                style={{
                                  backgroundColor: 'var(--md-surface-high)',
                                  color: 'var(--md-on-surface-variant)',
                                }}
                              >
                                場所
                              </button>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
