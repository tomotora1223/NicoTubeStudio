import { Compass, Download, Layers, MessageSquareText, Settings2, TvMinimalPlay } from 'lucide-react'
import type { AuthStatus, EncoderProbeResult } from '../types/studio'

export type NavTab = 'capture' | 'comments' | 'gallery' | 'queue' | 'settings'

interface NavRailProps {
  activeTab: NavTab
  onSelectTab: (tab: NavTab) => void
  activeJobCount: number
  authStatus: AuthStatus | null
  encoders?: EncoderProbeResult | null
  appVersion?: string
}

export function NavRail({
  activeTab,
  onSelectTab,
  activeJobCount,
  authStatus,
  encoders,
  appVersion = '0.2.4',
}: NavRailProps) {
  const items: Array<{ id: NavTab; label: string; icon: typeof Download; badge?: number }> = [
    { id: 'capture', label: '取り込み・切り抜き', icon: Download },
    { id: 'comments', label: 'コメントスタジオ', icon: MessageSquareText },
    { id: 'gallery', label: 'みんなのスタイル', icon: Compass },
    { id: 'queue', label: '処理キュー', icon: Layers, badge: activeJobCount },
    { id: 'settings', label: 'アカウント・設定', icon: Settings2 },
  ]

  const hwBadge = encoders?.ffmpeg_found
    ? encoders.available_hw?.length
      ? encoders.available_hw.map((h) => h.toUpperCase()).join('/')
      : 'CPU'
    : '未導入'

  return (
    <aside
      className="flex h-full w-60 shrink-0 flex-col justify-between border-r px-3 py-4"
      style={{
        backgroundColor: 'var(--md-surface-dim)',
        borderColor: 'var(--md-outline-variant)',
      }}
    >
      <div>
        {/* Quiet wordmark + flat glyph */}
        <div className="mb-6 flex items-center gap-2.5 px-2.5">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ backgroundColor: 'var(--md-primary-tonal)', color: 'var(--md-primary)' }}
          >
            <TvMinimalPlay size={18} strokeWidth={1.5} />
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[15px] font-medium tracking-tight" style={{ color: 'var(--md-on-surface)' }}>
              NicoTube Studio
            </div>
            <div className="font-mono-tabular text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              v{appVersion} · Broadcast
            </div>
          </div>
        </div>

        {/* Nav items */}
        <nav className="flex flex-col gap-1">
          {items.map((it) => {
            const Icon = it.icon
            const active = activeTab === it.id
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => onSelectTab(it.id)}
                className="ease-studio flex h-9 w-full items-center justify-between rounded-lg px-2.5 text-left text-[13px] font-medium transition-[background-color,color,transform] duration-150 hover:bg-[var(--md-surface)] active:scale-[0.98]"
                style={{
                  backgroundColor: active ? 'var(--md-surface-high)' : undefined,
                  color: active ? 'var(--md-on-surface)' : 'var(--md-on-surface-variant)',
                  boxShadow: active ? 'inset 0 1px 0 rgba(255,255,255,0.06)' : 'none',
                }}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    size={17}
                    strokeWidth={1.5}
                    style={{ color: active ? 'var(--md-primary)' : 'var(--md-on-surface-muted)' }}
                  />
                  <span>{it.label}</span>
                </span>
                {typeof it.badge === 'number' && it.badge > 0 && (
                  <span
                    className="font-mono-tabular rounded px-1.5 py-0.5 text-[11px]"
                    style={{
                      backgroundColor: 'var(--md-primary-tonal)',
                      color: 'var(--md-on-primary-tonal)',
                    }}
                  >
                    {it.badge}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </div>

      {/* Bottom system telemetry block */}
      <div
        className="flex flex-col gap-2 rounded-xl border p-3 text-[12px]"
        style={{
          backgroundColor: 'var(--md-surface-low)',
          borderColor: 'var(--md-outline-variant)',
        }}
      >
        <div className="flex items-center justify-between">
          <span style={{ color: 'var(--md-on-surface-muted)' }}>Google認証</span>
          <span className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--md-on-surface-variant)' }}>
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: authStatus?.logged_in ? 'var(--md-positive)' : 'var(--md-on-surface-muted)',
              }}
            />
            {authStatus?.logged_in ? '接続済み' : '未ログイン'}
          </span>
        </div>
        <div
          className="flex items-center justify-between border-t pt-2"
          style={{ borderColor: 'var(--md-outline-variant)' }}
        >
          <span style={{ color: 'var(--md-on-surface-muted)' }}>FFmpeg</span>
          <span
            className="font-mono-tabular flex items-center gap-1.5 text-[11px] font-medium"
            style={{ color: 'var(--md-on-surface-variant)' }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: encoders?.ffmpeg_found ? 'var(--md-positive)' : 'var(--md-warning)',
              }}
            />
            {hwBadge}
          </span>
        </div>
      </div>
    </aside>
  )
}
