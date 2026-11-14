import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, RefreshCw, Search, Type, X } from 'lucide-react'
import { api, loadDynamicFontFace } from '../lib/api'
import type { SystemFontInfo } from '../types/studio'

interface FontPickerModalProps {
  open: boolean
  selectedFamily: string
  onSelect: (family: string) => void
  onClose: () => void
}

type FontFilter = 'japanese' | 'all' | 'user'

function FontPreviewRow({
  font,
  selected,
  sampleText,
  onSelect,
}: {
  font: SystemFontInfo
  selected: boolean
  sampleText: string
  onSelect: () => void
}) {
  const rowRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const el = rowRef.current
    if (!el || !font.has_file) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          loadDynamicFontFace(font.family).catch(() => {})
          obs.disconnect()
        }
      },
      { rootMargin: '180px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [font.family, font.has_file])

  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onSelect}
      className="ease-studio flex w-full flex-col gap-1.5 rounded-xl border p-3 text-left transition-colors duration-150"
      style={{
        backgroundColor: selected ? 'var(--md-primary-tonal)' : 'var(--md-surface)',
        borderColor: selected ? 'var(--md-primary)' : 'var(--md-outline-variant)',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="truncate text-[12px] font-medium"
            style={{ color: selected ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface)' }}
          >
            {font.family}
          </span>
          {font.is_user_installed && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
              style={{
                backgroundColor: 'rgba(76, 195, 138, 0.14)',
                color: 'var(--md-positive)',
              }}
            >
              追加フォント
            </span>
          )}
          {font.has_japanese && (
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px]"
              style={{
                backgroundColor: 'var(--md-surface-high)',
                color: 'var(--md-on-surface-muted)',
              }}
            >
              日本語
            </span>
          )}
        </div>
        {selected && <Check size={15} strokeWidth={1.5} style={{ color: 'var(--md-primary)' }} />}
      </div>

      <div
        className="truncate text-[18px] leading-snug"
        style={{
          fontFamily: `"${font.family}", "Yu Gothic UI", sans-serif`,
          color: selected ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-variant)',
        }}
      >
        {sampleText}
      </div>
    </button>
  )
}

export function FontPickerModal({
  open,
  selectedFamily,
  onSelect,
  onClose,
}: FontPickerModalProps) {
  const [fonts, setFonts] = useState<SystemFontInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FontFilter>('japanese')
  const [sampleText, setSampleText] = useState('あいうえお コメント風 弾幕テスト 8888 ｗ')

  useEffect(() => {
    if (!open) return
    let active = true
    setLoading(true)
    api
      .getFonts()
      .then((list) => {
        if (active) setFonts(list)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      const list = await api.refreshFonts()
      setFonts(list)
    } catch (_) {
    } finally {
      setRefreshing(false)
    }
  }

  const jpCount = useMemo(() => fonts.filter((f) => f.has_japanese).length, [fonts])
  const userCount = useMemo(() => fonts.filter((f) => f.is_user_installed).length, [fonts])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return fonts.filter((f) => {
      if (filter === 'japanese' && !f.has_japanese) return false
      if (filter === 'user' && !f.is_user_installed) return false
      if (q && !f.family.toLowerCase().includes(q)) return false
      return true
    })
  }, [fonts, filter, query])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center p-6"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.72)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-3xl flex-col gap-4 rounded-2xl border p-5 shadow-2xl"
        style={{
          backgroundColor: 'var(--md-surface-low)',
          borderColor: 'var(--md-outline)',
        }}
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Type size={17} strokeWidth={1.5} style={{ color: 'var(--md-primary)' }} />
            <div>
              <div className="text-[15px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                システムフォント一覧・日本語プレビュー
              </div>
              <div className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                新しいフォントをインストールした直後は「再スキャン」でアプリ再起動なしに反映されます
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium disabled:opacity-50"
              style={{
                backgroundColor: 'var(--md-surface-high)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-on-surface)',
              }}
            >
              <RefreshCw size={13} strokeWidth={1.6} className={refreshing ? 'animate-spin' : ''} />
              <span>{refreshing ? '再スキャン中...' : '再スキャン (再起動不要)'}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="flex h-8 w-8 items-center justify-center rounded-lg border"
              style={{
                backgroundColor: 'var(--md-surface-high)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-on-surface)',
              }}
            >
              <X size={15} strokeWidth={1.6} />
            </button>
          </div>
        </div>

        {/* Search + Sample Text + Filter pills */}
        <div className="flex flex-col gap-2.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div
              className="flex h-9 items-center gap-2 rounded-lg border px-3"
              style={{ backgroundColor: 'var(--md-surface)', borderColor: 'var(--md-outline-variant)' }}
            >
              <Search size={14} style={{ color: 'var(--md-on-surface-muted)' }} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="フォント名で検索 (例: Noto, Meiryo, 源ノ角...)"
                className="w-full bg-transparent text-[12px] outline-none"
                style={{ color: 'var(--md-on-surface)' }}
              />
            </div>

            <input
              type="text"
              value={sampleText}
              onChange={(e) => setSampleText(e.target.value)}
              placeholder="プレビュー文字列をカスタマイズ"
              className="h-9 rounded-lg border px-3 text-[12px] outline-none"
              style={{
                backgroundColor: 'var(--md-surface)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-on-surface)',
              }}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(
              [
                ['japanese', `日本語対応 (${jpCount})`],
                ['all', `すべて (${fonts.length})`],
                ['user', `追加フォント (${userCount})`],
              ] as Array<[FontFilter, string]>
            ).map(([k, lbl]) => (
              <button
                key={k}
                type="button"
                onClick={() => setFilter(k)}
                className="h-7 rounded-full border px-3 text-[11px] font-medium"
                style={{
                  backgroundColor: filter === k ? 'var(--md-primary-tonal)' : 'var(--md-surface)',
                  borderColor: filter === k ? 'var(--md-primary)' : 'var(--md-outline-variant)',
                  color: filter === k ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-muted)',
                }}
              >
                {lbl}
              </button>
            ))}
            <span className="font-mono-tabular ml-auto text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              {filtered.length} 件表示
            </span>
          </div>
        </div>

        {/* Scrollable Font List */}
        <div className="grid min-h-[260px] flex-1 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {loading ? (
            <div className="col-span-2 flex items-center justify-center py-12 text-[13px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              端末のフォントを読み込み中...
            </div>
          ) : filtered.length === 0 ? (
            <div className="col-span-2 flex items-center justify-center py-12 text-[13px]" style={{ color: 'var(--md-on-surface-muted)' }}>
              条件に一致するフォントが見つかりませんでした
            </div>
          ) : (
            filtered.map((font) => (
              <FontPreviewRow
                key={font.family}
                font={font}
                selected={styleEquals(selectedFamily, font.family)}
                sampleText={sampleText || 'あいうえお コメント風 弾幕テスト'}
                onSelect={() => {
                  loadDynamicFontFace(font.family).catch(() => {})
                  onSelect(font.family)
                  onClose()
                }}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function styleEquals(a: string, b: string): boolean {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()
}
