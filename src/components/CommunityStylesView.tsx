import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileJson,
  Globe,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { DanmakuCanvas } from './DanmakuCanvas'
import { api } from '../lib/api'
import {
  normalizeCommentStyle,
  type CommentStyleConfig,
  type SharedStyleEntry,
} from '../types/studio'

interface CommunityStylesViewProps {
  currentStyle: CommentStyleConfig
  activePresetName?: string
  thumbnailUrl?: string | null
  defaultAuthorName?: string
  hasRelayServer?: boolean
  hasGithubToken?: boolean
  onApplyStyle: (config: CommentStyleConfig, openStudio?: boolean) => void
  onSaveAsPreset: (name: string, description: string, config: CommentStyleConfig) => Promise<void>
  onGoToSettings?: () => void
}

type PanelMode = 'browse' | 'share' | 'import'

function encodeShareCode(name: string, config: CommentStyleConfig): string {
  const payload = JSON.stringify({ v: 1, name, config })
  const bytes = new TextEncoder().encode(payload)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return `NTS1:${btoa(binary)}`
}

function decodeShareText(raw: string): { name: string; config: CommentStyleConfig } {
  const trimmed = raw.trim()
  let parsed: Record<string, unknown>
  if (trimmed.startsWith('NTS1:')) {
    const b64 = trimmed.slice(5).trim()
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
  } else {
    parsed = JSON.parse(trimmed) as Record<string, unknown>
  }
  const candidate = (parsed.config ?? parsed.style ?? parsed) as Partial<CommentStyleConfig>
  return {
    name: typeof parsed.name === 'string' && parsed.name ? parsed.name : 'インポートスタイル',
    config: normalizeCommentStyle(candidate),
  }
}

const SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub',
  relay: 'リレーサーバー',
  local: '自分の公開履歴',
}

export function CommunityStylesView({
  currentStyle,
  activePresetName = '現在の調整スタイル',
  thumbnailUrl,
  defaultAuthorName = '',
  hasRelayServer = false,
  hasGithubToken = false,
  onApplyStyle,
  onSaveAsPreset,
  onGoToSettings,
}: CommunityStylesViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [styles, setStyles] = useState<SharedStyleEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [panelMode, setPanelMode] = useState<PanelMode>('browse')

  // Preview target can either be an entry ID or 'current' (user's live studio style)
  const [previewTarget, setPreviewTarget] = useState<string>('first')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string>('すべて')

  // Publish form (always publishes currentStyle)
  const [pubName, setPubName] = useState('')
  const [pubAuthor, setPubAuthor] = useState(defaultAuthorName || '')
  const [pubTags, setPubTags] = useState('配信向け, 高視認性')
  const [pubDesc, setPubDesc] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<{ message: string; url?: string } | null>(null)

  // Import form (URL, NTS1 code, or .nicostyle.json)
  const [importInput, setImportInput] = useState('')
  const [importing, setImporting] = useState(false)
  const [importedEntry, setImportedEntry] = useState<SharedStyleEntry | null>(null)

  const [statusNotice, setStatusNotice] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [savingPreset, setSavingPreset] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  const noticeTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (defaultAuthorName && !pubAuthor) {
      setPubAuthor(defaultAuthorName)
    }
  }, [defaultAuthorName])

  const loadCatalog = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    try {
      const list = await api.getCommunityStyles(forceRefresh)
      setStyles(list)
      setPreviewTarget((prev) => {
        if (prev === 'current' || prev === importedEntry?.id) return prev
        if (prev !== 'first' && list.some((s) => s.id === prev)) return prev
        return list[0]?.id || 'current'
      })
    } catch {
      setStatusNotice('カタログの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [importedEntry?.id])

  useEffect(() => {
    void loadCatalog(false)
  }, [loadCatalog])

  const allTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of styles) {
      for (const t of s.tags || []) {
        counts.set(t, (counts.get(t) || 0) + 1)
      }
    }
    return ['すべて', ...Array.from(counts.keys()).slice(0, 8)]
  }, [styles])

  const filteredStyles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return styles.filter((item) => {
      if (activeTag !== 'すべて' && !(item.tags || []).includes(activeTag)) {
        return false
      }
      if (!q) return true
      const hay = `${item.name} ${item.author} ${item.description} ${(item.tags || []).join(' ')}`.toLowerCase()
      return hay.includes(q)
    })
  }, [styles, searchQuery, activeTag])

  const selectedEntry: SharedStyleEntry | null = useMemo(() => {
    if (previewTarget === 'current') return null
    if (importedEntry && previewTarget === importedEntry.id) return importedEntry
    return styles.find((s) => s.id === previewTarget) || filteredStyles[0] || null
  }, [previewTarget, importedEntry, styles, filteredStyles])

  const previewConfig = useMemo(
    () => normalizeCommentStyle(previewTarget === 'current' ? currentStyle : selectedEntry?.config || currentStyle),
    [previewTarget, selectedEntry, currentStyle]
  )

  const notify = (msg: string) => {
    setStatusNotice(msg)
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current)
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setStatusNotice(null)
      noticeTimerRef.current = null
    }, 3200)
  }

  const handleSwitchMode = (mode: PanelMode) => {
    setPanelMode(mode)
    if (mode === 'share') {
      setPreviewTarget('current')
      if (!pubName.trim()) {
        setPubName(activePresetName)
      }
    }
  }

  const handleCopyCode = async (name: string, cfg: CommentStyleConfig, idKey: string) => {
    const code = encodeShareCode(name, normalizeCommentStyle(cfg))
    await navigator.clipboard.writeText(code)
    setCopiedId(idKey)
    notify(`「${name}」の共有コードをコピーしました`)
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current)
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedId(null)
      copyTimerRef.current = null
    }, 1600)
  }

  const handleExportJsonFile = (name: string, cfg: CommentStyleConfig) => {
    const baseName = (name || 'nicotube-style').replace(/[\\/:*?"<>|]/g, '_')
    const payload = {
      schema: 'nicotube-style-v1',
      name: name || 'カスタムスタイル',
      author: pubAuthor.trim() || defaultAuthorName || 'Anonymous',
      description: pubDesc.trim(),
      exported_at: new Date().toISOString(),
      config: cfg,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${baseName}.nicostyle.json`
    a.click()
    URL.revokeObjectURL(url)
    notify(`${baseName}.nicostyle.json を書き出しました`)
  }

  const handleSavePreset = async (entry: SharedStyleEntry) => {
    setSavingPreset(true)
    try {
      await onSaveAsPreset(entry.name, entry.description || `by ${entry.author}`, normalizeCommentStyle(entry.config))
      notify(`「${entry.name}」をマイプリセットに保存しました`)
    } finally {
      setSavingPreset(false)
    }
  }

  const handlePublish = async () => {
    const targetName = pubName.trim() || activePresetName
    if (!targetName) {
      notify('スタイル名を入力してください')
      return
    }
    setPublishing(true)
    setPublishResult(null)
    try {
      const tags = pubTags
        .split(/[,、\s]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 6)
      const res = await api.shareStyleToGithub({
        name: targetName,
        author: pubAuthor.trim() || 'Anonymous',
        description: pubDesc.trim(),
        tags,
        config: currentStyle,
      })
      setStyles((prev) => [res.entry, ...prev.filter((p) => p.id !== res.entry.id)])
      if (res.method === 'gist') {
        setPublishResult({
          message: hasRelayServer
            ? 'Gist とリレーサーバーへ公開しました'
            : 'GitHub Gist に公開しました',
          url: res.url,
        })
      } else {
        setPublishResult({
          message: hasRelayServer
            ? 'リレーサーバーへ送信しました（GitHub カタログ掲載ページも開きました）'
            : 'GitHub カタログ掲載リクエスト画面を開きました',
          url: res.url,
        })
        if (window.nicotube?.openExternal) {
          await window.nicotube.openExternal(res.url)
        } else {
          window.open(res.url, '_blank')
        }
      }
      setPubDesc('')
    } catch (err) {
      notify(err instanceof Error ? err.message : '公開に失敗しました')
    } finally {
      setPublishing(false)
    }
  }

  const handleImportTextOrUrl = async () => {
    const raw = importInput.trim()
    if (!raw) return
    setImporting(true)
    try {
      let entry: SharedStyleEntry
      if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('NTS1:')) {
        const imported = await api.importStyleFromUrl(raw)
        entry = {
          id: `import-${Date.now()}`,
          name: imported.name,
          author: imported.author,
          description: imported.description,
          tags: imported.tags || ['インポート'],
          source: 'local',
          created_at: Date.now() / 1000,
          config: normalizeCommentStyle(imported.config),
        }
      } else {
        const decoded = decodeShareText(raw)
        entry = {
          id: `import-${Date.now()}`,
          name: decoded.name,
          author: 'Paste',
          description: '貼り付けた JSON から読み込み',
          tags: ['インポート'],
          source: 'local',
          created_at: Date.now() / 1000,
          config: decoded.config,
        }
      }
      setImportedEntry(entry)
      setPreviewTarget(entry.id)
      setImportInput('')
      notify(`「${entry.name}」を読み込みました`)
    } catch (err) {
      notify(err instanceof Error ? err.message : '読み込みに失敗しました')
    } finally {
      setImporting(false)
    }
  }

  const handleImportFile = async (file: File) => {
    try {
      const text = await file.text()
      const decoded = decodeShareText(text)
      const entry: SharedStyleEntry = {
        id: `import-${Date.now()}`,
        name: decoded.name || file.name.replace(/\.nicostyle\.json$|\.json$/i, ''),
        author: 'File',
        description: file.name,
        tags: ['ファイル'],
        source: 'local',
        created_at: Date.now() / 1000,
        config: decoded.config,
      }
      setImportedEntry(entry)
      setPreviewTarget(entry.id)
      notify(`「${entry.name}」を読み込みました`)
    } catch {
      notify('有効な .nicostyle.json ファイルではありません')
    }
  }

  const handleDeleteLocal = async (entry: SharedStyleEntry) => {
    try {
      await api.deleteSharedStyle(entry.id)
      setStyles((prev) => prev.filter((s) => s.id !== entry.id))
      if (previewTarget === entry.id) {
        setPreviewTarget(styles.find((s) => s.id !== entry.id)?.id || 'current')
      }
      notify('公開履歴から削除しました')
    } catch (err) {
      notify(err instanceof Error ? err.message : '削除に失敗しました')
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1320px] space-y-5 px-8 py-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-medium tracking-tight" style={{ color: 'var(--md-on-surface)' }}>
            みんなのスタイル
          </h1>
          <p className="mt-1 text-[13px]" style={{ color: 'var(--md-on-surface-variant)' }}>
            共有スタイルのライブ試聴、読み込み、および現在調整中のスタイルの公開・書き出しを行います
          </p>
        </div>

        <button
          type="button"
          onClick={() => loadCatalog(true)}
          disabled={loading}
          className="ease-studio flex h-9 items-center gap-2 rounded-lg border px-3 text-[12px] font-medium transition-colors duration-150"
          style={{
            backgroundColor: 'var(--md-surface-low)',
            borderColor: 'var(--md-outline-variant)',
            color: 'var(--md-on-surface-variant)',
          }}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
          <span>カタログ再読込</span>
        </button>
      </div>

      {statusNotice && (
        <div
          className="rounded-xl border px-4 py-2.5 text-[12px]"
          style={{
            backgroundColor: 'var(--md-primary-tonal)',
            borderColor: 'var(--md-primary)',
            color: 'var(--md-on-primary-tonal)',
          }}
        >
          {statusNotice}
        </div>
      )}

      <div className="grid grid-cols-12 gap-5">
        {/* Left Stage (7 cols): Live Preview Canvas + Active Inspected Style Card */}
        <div className="col-span-12 space-y-4 lg:col-span-7">
          <DanmakuCanvas styleConfig={previewConfig} thumbnailUrl={thumbnailUrl} />

          <div
            className="rounded-2xl border p-5"
            style={{
              backgroundColor: 'var(--md-surface-low)',
              borderColor: 'var(--md-outline-variant)',
            }}
          >
            {previewTarget === 'current' || !selectedEntry ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--md-primary-tonal)',
                        color: 'var(--md-on-primary-tonal)',
                      }}
                    >
                      編集中の自分の設定
                    </span>
                    <h2 className="text-[15px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                      {activePresetName}
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => onApplyStyle(currentStyle, true)}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] font-medium"
                    style={{
                      backgroundColor: 'var(--md-surface)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface)',
                    }}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span>スタジオで調整</span>
                  </button>
                </div>
                <div
                  className="font-mono-tabular flex flex-wrap items-center gap-2 text-[11px]"
                  style={{ color: 'var(--md-on-surface-muted)' }}
                >
                  <span>{previewConfig.font_family} ({previewConfig.font_weight})</span>
                  <span>·</span>
                  <span>倍率 {previewConfig.font_scale.toFixed(2)}x</span>
                  <span>·</span>
                  <span>縁取り {previewConfig.outline_width.toFixed(1)}px</span>
                  <span>·</span>
                  <span>領域 {Math.round(previewConfig.display_area_ratio * 100)}%</span>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[15px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                      {selectedEntry.name}
                    </h2>
                    <span
                      className="rounded-md px-2 py-0.5 text-[11px]"
                      style={{
                        backgroundColor: 'var(--md-surface-high)',
                        color: 'var(--md-on-surface-variant)',
                      }}
                    >
                      {SOURCE_LABELS[selectedEntry.source || 'github'] || selectedEntry.source}
                    </span>
                  </div>
                  <p className="mt-1 text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                    {selectedEntry.description || '説明なし'}
                  </p>
                  <div
                    className="font-mono-tabular mt-2 flex flex-wrap items-center gap-2 text-[11px]"
                    style={{ color: 'var(--md-on-surface-muted)' }}
                  >
                    <span>作者: {selectedEntry.author}</span>
                    <span>·</span>
                    <span>{previewConfig.font_family} ({previewConfig.font_weight})</span>
                    <span>·</span>
                    <span>倍率 {previewConfig.font_scale.toFixed(2)}x</span>
                    <span>·</span>
                    <span>縁取り {previewConfig.outline_width.toFixed(1)}px</span>
                    <span>·</span>
                    <span>領域 {Math.round(previewConfig.display_area_ratio * 100)}%</span>
                  </div>
                </div>

                <div
                  className="flex flex-wrap items-center gap-2 border-t pt-3"
                  style={{ borderColor: 'var(--md-outline-variant)' }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onApplyStyle(previewConfig, false)
                      notify(`「${selectedEntry.name}」を現在の設定に適用しました`)
                    }}
                    className="ease-studio inline-flex h-9 items-center gap-1.5 rounded-lg px-4 text-[12px] font-medium transition-opacity duration-150 hover:opacity-90"
                    style={{
                      backgroundColor: 'var(--md-primary)',
                      color: 'var(--md-on-primary)',
                    }}
                  >
                    <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span>このスタイルを使う</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onApplyStyle(previewConfig, true)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium"
                    style={{
                      backgroundColor: 'var(--md-surface)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface)',
                    }}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span>調整する</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSavePreset(selectedEntry)}
                    disabled={savingPreset}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium"
                    style={{
                      backgroundColor: 'var(--md-surface)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface-variant)',
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span>プリセット登録</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopyCode(selectedEntry.name, previewConfig, selectedEntry.id)}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-[12px] font-medium"
                    style={{
                      backgroundColor: 'var(--md-surface)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface-variant)',
                    }}
                  >
                    {copiedId === selectedEntry.id ? (
                      <Check className="h-3.5 w-3.5" style={{ color: 'var(--md-positive)' }} strokeWidth={1.5} />
                    ) : (
                      <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                    )}
                    <span>コードコピー</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Panel (5 cols): Single Unified Workspace (Browse / Publish & Export / Import) */}
        <div className="col-span-12 space-y-4 lg:col-span-5">
          {/* Segmented Mode Switcher */}
          <div
            className="grid grid-cols-3 gap-1 rounded-xl p-1"
            style={{
              backgroundColor: 'var(--md-surface-low)',
              border: '1px solid var(--md-outline-variant)',
            }}
          >
            {(
              [
                ['browse', '一覧から選ぶ', Layers],
                ['share', '今の設定を公開', Share2],
                ['import', '外部から読込', Download],
              ] as Array<[PanelMode, string, typeof Layers]>
            ).map(([mode, label, Icon]) => {
              const active = panelMode === mode
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => handleSwitchMode(mode)}
                  className="ease-studio flex h-9 items-center justify-center gap-1.5 rounded-lg text-[12px] font-medium transition-colors duration-150"
                  style={{
                    backgroundColor: active ? 'var(--md-surface-highest)' : 'transparent',
                    color: active ? 'var(--md-on-surface)' : 'var(--md-on-surface-muted)',
                  }}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>{label}</span>
                </button>
              )
            })}
          </div>

          {/* MODE 1: BROWSE CATALOG */}
          {panelMode === 'browse' && (
            <div className="space-y-3">
              <div
                className="space-y-2.5 rounded-2xl border p-4"
                style={{
                  backgroundColor: 'var(--md-surface-low)',
                  borderColor: 'var(--md-outline-variant)',
                }}
              >
                <div className="flex items-center gap-2">
                  <div
                    className="flex h-9 flex-1 items-center gap-2 rounded-lg border px-3"
                    style={{
                      backgroundColor: 'var(--md-surface)',
                      borderColor: 'var(--md-outline-variant)',
                    }}
                  >
                    <Search className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--md-on-surface-muted)' }} strokeWidth={1.5} />
                    <input
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="スタイル名・タグ・制作者で検索"
                      className="w-full bg-transparent text-[12px] outline-none"
                      style={{ color: 'var(--md-on-surface)' }}
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery('')}
                        className="rounded p-0.5 hover:bg-[var(--md-surface-high)]"
                        style={{ color: 'var(--md-on-surface-muted)' }}
                        title="検索をクリア"
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={1.5} />
                      </button>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreviewTarget(previewTarget === 'current' ? (styles[0]?.id || 'current') : 'current')}
                    className="h-9 shrink-0 rounded-lg border px-2.5 text-[11px] font-medium transition-colors duration-150"
                    style={{
                      backgroundColor: previewTarget === 'current' ? 'var(--md-primary-tonal)' : 'var(--md-surface)',
                      borderColor: previewTarget === 'current' ? 'var(--md-primary)' : 'var(--md-outline-variant)',
                      color: previewTarget === 'current' ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-variant)',
                    }}
                    title="現在スタジオで編集中の設定と比べられます"
                  >
                    自分の設定を試聴
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {allTags.map((tag) => {
                    const active = activeTag === tag
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => setActiveTag(tag)}
                        className="rounded-md px-2 py-1 text-[11px] font-medium transition-colors duration-150"
                        style={{
                          backgroundColor: active ? 'var(--md-primary-tonal)' : 'var(--md-surface)',
                          color: active ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-muted)',
                        }}
                      >
                        {tag}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="max-h-[540px] space-y-2 overflow-y-auto pr-1">
                {importedEntry && (
                  <button
                    type="button"
                    onClick={() => setPreviewTarget(importedEntry.id)}
                    className="w-full rounded-xl border p-3.5 text-left transition-colors duration-150"
                    style={{
                      backgroundColor:
                        previewTarget === importedEntry.id ? 'var(--md-primary-tonal)' : 'var(--md-surface-low)',
                      borderColor:
                        previewTarget === importedEntry.id ? 'var(--md-primary)' : 'var(--md-outline-variant)',
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                        {importedEntry.name}
                      </span>
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px]"
                        style={{
                          backgroundColor: 'var(--md-surface-high)',
                          color: 'var(--md-on-surface-variant)',
                        }}
                      >
                        読込済み
                      </span>
                    </div>
                  </button>
                )}

                {filteredStyles.map((item) => {
                  const isSelected = previewTarget !== 'current' && selectedEntry?.id === item.id
                  const cfg = normalizeCommentStyle(item.config)
                  return (
                    <div
                      key={item.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => setPreviewTarget(item.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') setPreviewTarget(item.id)
                      }}
                      className="cursor-pointer rounded-xl border p-3.5 transition-colors duration-150"
                      style={{
                        backgroundColor: isSelected ? 'var(--md-primary-tonal)' : 'var(--md-surface-low)',
                        borderColor: isSelected ? 'var(--md-primary)' : 'var(--md-outline-variant)',
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                              {item.name}
                            </span>
                          </div>
                          <p
                            className="mt-1 line-clamp-2 text-[11px] leading-relaxed"
                            style={{ color: 'var(--md-on-surface-variant)' }}
                          >
                            {item.description || '説明なし'}
                          </p>
                        </div>
                        {item.source === 'local' && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDeleteLocal(item)
                            }}
                            title="公開履歴から削除"
                            className="rounded-md p-1"
                            style={{ color: 'var(--md-on-surface-muted)' }}
                          >
                            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                          </button>
                        )}
                      </div>

                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-1">
                          {(item.tags || []).slice(0, 3).map((t) => (
                            <span
                              key={t}
                              className="rounded px-1.5 py-0.5 text-[10px]"
                              style={{
                                backgroundColor: 'var(--md-surface-high)',
                                color: 'var(--md-on-surface-variant)',
                              }}
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                        <span className="font-mono-tabular text-[10px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                          {item.author} · {cfg.font_family}
                        </span>
                      </div>
                    </div>
                  )
                })}

                {!loading && filteredStyles.length === 0 && (
                  <div
                    className="rounded-xl border border-dashed p-6 text-center text-[12px]"
                    style={{
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface-muted)',
                    }}
                  >
                    条件に一致するスタイルはありません
                  </div>
                )}
              </div>
            </div>
          )}

          {/* MODE 2: PUBLISH & EXPORT CURRENT STUDIO STYLE */}
          {panelMode === 'share' && (
            <div className="space-y-4">
              <div
                className="space-y-3 rounded-2xl border p-5"
                style={{
                  backgroundColor: 'var(--md-surface-low)',
                  borderColor: 'var(--md-outline-variant)',
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                      今のスタイルをコミュニティへ公開
                    </div>
                    <p className="mt-0.5 text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                      対象は左プレビューに表示中の「{activePresetName}」です
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreviewTarget('current')}
                    className="rounded-lg border px-2.5 py-1 text-[11px]"
                    style={{
                      backgroundColor: 'var(--md-surface)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface-variant)',
                    }}
                  >
                    対象を確認
                  </button>
                </div>

                <div className="space-y-2.5">
                  <label className="block space-y-1">
                    <span className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                      公開するスタイル名
                    </span>
                    <input
                      type="text"
                      value={pubName}
                      onChange={(e) => setPubName(e.target.value)}
                      placeholder="例: 夜雑談パステル弾幕"
                      className="h-9 w-full rounded-lg border px-3 text-[12px] outline-none"
                      style={{
                        backgroundColor: 'var(--md-surface)',
                        borderColor: 'var(--md-outline-variant)',
                        color: 'var(--md-on-surface)',
                      }}
                    />
                  </label>

                  <div className="grid grid-cols-2 gap-2.5">
                    <label className="block space-y-1">
                      <span className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                        制作者名
                      </span>
                      <input
                        type="text"
                        value={pubAuthor}
                        onChange={(e) => setPubAuthor(e.target.value)}
                        placeholder="ハンドルネーム"
                        className="h-9 w-full rounded-lg border px-3 text-[12px] outline-none"
                        style={{
                          backgroundColor: 'var(--md-surface)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-on-surface)',
                        }}
                      />
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                        タグ (カンマ区切り)
                      </span>
                      <input
                        type="text"
                        value={pubTags}
                        onChange={(e) => setPubTags(e.target.value)}
                        placeholder="FPS, Twitch, 太縁"
                        className="h-9 w-full rounded-lg border px-3 text-[12px] outline-none"
                        style={{
                          backgroundColor: 'var(--md-surface)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-on-surface)',
                        }}
                      />
                    </label>
                  </div>

                  <label className="block space-y-1">
                    <span className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                      特徴やおすすめ用途
                    </span>
                    <input
                      type="text"
                      value={pubDesc}
                      onChange={(e) => setPubDesc(e.target.value)}
                      placeholder="例: ゲーム画面の上半分だけに流れる控えめ表示"
                      className="h-9 w-full rounded-lg border px-3 text-[12px] outline-none"
                      style={{
                        backgroundColor: 'var(--md-surface)',
                        borderColor: 'var(--md-outline-variant)',
                        color: 'var(--md-on-surface)',
                      }}
                    />
                  </label>
                </div>

                <div
                  className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[11px]"
                  style={{
                    backgroundColor: 'var(--md-surface)',
                    borderColor: 'var(--md-outline-variant)',
                    color: 'var(--md-on-surface-muted)',
                  }}
                >
                  <span>
                    送信先:{' '}
                    {hasGithubToken
                      ? 'GitHub Gist (自動投稿)'
                      : 'GitHub カタログ掲載ページ'}
                    {hasRelayServer ? ' + 共有サーバー' : ''}
                  </span>
                  {onGoToSettings && (
                    <button
                      type="button"
                      onClick={onGoToSettings}
                      className="inline-flex items-center gap-1 font-medium"
                      style={{ color: 'var(--md-on-surface-variant)' }}
                    >
                      <Settings2 className="h-3 w-3" strokeWidth={1.5} />
                      <span>設定</span>
                    </button>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handlePublish}
                  disabled={publishing}
                  className="ease-studio flex h-10 w-full items-center justify-center gap-2 rounded-lg text-[13px] font-medium transition-opacity duration-150 disabled:opacity-50"
                  style={{
                    backgroundColor: 'var(--md-primary)',
                    color: 'var(--md-on-primary)',
                  }}
                >
                  <Globe className="h-4 w-4" strokeWidth={1.5} />
                  <span>{publishing ? '公開処理中...' : '今の設定を公開する'}</span>
                </button>

                {publishResult && (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[12px]"
                    style={{
                      backgroundColor: 'rgba(76, 195, 138, 0.1)',
                      borderColor: 'rgba(76, 195, 138, 0.25)',
                      color: 'var(--md-on-surface)',
                    }}
                  >
                    <span>{publishResult.message}</span>
                    {publishResult.url && (
                      <button
                        type="button"
                        onClick={() => {
                          if (window.nicotube?.openExternal) {
                            window.nicotube.openExternal(publishResult.url!)
                          } else {
                            window.open(publishResult.url, '_blank')
                          }
                        }}
                        className="inline-flex items-center gap-1 text-[11px] font-medium hover:underline"
                        style={{ color: 'var(--md-primary)' }}
                      >
                        <span>URLを開く</span>
                        <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Direct Export Box */}
              <div
                className="space-y-3 rounded-2xl border p-5"
                style={{
                  backgroundColor: 'var(--md-surface-low)',
                  borderColor: 'var(--md-outline-variant)',
                }}
              >
                <div className="text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                  ファイル / 共有コードで直接渡す
                </div>
                <p className="text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  Discord・X での共有や、自分の別 PC へのバックアップに使えます
                </p>
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => handleExportJsonFile(pubName.trim() || activePresetName, currentStyle)}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-lg border text-[12px] font-medium"
                    style={{
                      backgroundColor: 'var(--md-surface)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface)',
                    }}
                  >
                    <FileJson className="h-3.5 w-3.5" strokeWidth={1.5} />
                    <span>.nicostyle.json 保存</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopyCode(pubName.trim() || activePresetName, currentStyle, 'current-share')}
                    className="flex h-9 items-center justify-center gap-1.5 rounded-lg border text-[12px] font-medium"
                    style={{
                      backgroundColor: 'var(--md-surface)',
                      borderColor: 'var(--md-outline-variant)',
                      color: 'var(--md-on-surface)',
                    }}
                  >
                    {copiedId === 'current-share' ? (
                      <Check className="h-3.5 w-3.5" style={{ color: 'var(--md-positive)' }} strokeWidth={1.5} />
                    ) : (
                      <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                    )}
                    <span>共有コードコピー</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* MODE 3: IMPORT FROM URL / CODE / FILE */}
          {panelMode === 'import' && (
            <div
              className="space-y-4 rounded-2xl border p-5"
              style={{
                backgroundColor: 'var(--md-surface-low)',
                borderColor: 'var(--md-outline-variant)',
              }}
            >
              <div>
                <div className="text-[13px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                  URL / 共有コード / ファイルから読み込む
                </div>
                <p className="mt-1 text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                  読み込むと左のキャンバスですぐに動作確認できます
                </p>
              </div>

              <div className="space-y-2">
                <textarea
                  rows={3}
                  value={importInput}
                  onChange={(e) => setImportInput(e.target.value)}
                  placeholder="GitHub Gist / Raw URL、または NTS1:... 共有コードを貼り付け"
                  className="w-full rounded-lg border p-3 text-[12px] outline-none"
                  style={{
                    backgroundColor: 'var(--md-surface)',
                    borderColor: 'var(--md-outline-variant)',
                    color: 'var(--md-on-surface)',
                  }}
                />
                <button
                  type="button"
                  onClick={handleImportTextOrUrl}
                  disabled={importing || !importInput.trim()}
                  className="ease-studio flex h-9 w-full items-center justify-center gap-1.5 rounded-lg text-[12px] font-medium transition-opacity duration-150 disabled:opacity-45"
                  style={{
                    backgroundColor: 'var(--md-primary)',
                    color: 'var(--md-on-primary)',
                  }}
                >
                  <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>{importing ? '読み込み中...' : 'プレビューに読み込む'}</span>
                </button>
              </div>

              <div
                className="border-t pt-4"
                style={{ borderColor: 'var(--md-outline-variant)' }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,.nicostyle.json"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) void handleImportFile(f)
                    e.target.value = ''
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border text-[12px] font-medium"
                  style={{
                    backgroundColor: 'var(--md-surface)',
                    borderColor: 'var(--md-outline-variant)',
                    color: 'var(--md-on-surface)',
                  }}
                >
                  <FileJson className="h-4 w-4" strokeWidth={1.5} />
                  <span>.nicostyle.json ファイルを選択して読み込む</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
