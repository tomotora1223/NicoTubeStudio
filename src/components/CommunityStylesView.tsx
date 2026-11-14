import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Layers,
  Plus,
  RefreshCw,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
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
  thumbnailUrl?: string | null
  defaultAuthorName?: string
  hasRelayServer?: boolean
  hasGithubToken?: boolean
  onApplyStyle: (config: CommentStyleConfig, openStudio?: boolean) => void
  onSaveAsPreset: (name: string, description: string, config: CommentStyleConfig) => Promise<void>
}

function encodeShareCode(name: string, config: CommentStyleConfig): string {
  const payload = JSON.stringify({ v: 1, name, config })
  const bytes = new TextEncoder().encode(payload)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return `NTS1:${btoa(binary)}`
}

const SOURCE_LABELS: Record<string, string> = {
  github: 'GitHub共有',
  relay: 'リレーサーバー',
  local: 'ローカル保存',
}

export function CommunityStylesView({
  currentStyle,
  thumbnailUrl,
  defaultAuthorName = '',
  hasRelayServer = false,
  hasGithubToken = false,
  onApplyStyle,
  onSaveAsPreset,
}: CommunityStylesViewProps) {
  const [styles, setStyles] = useState<SharedStyleEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string>('すべて')
  const [actionPanel, setActionPanel] = useState<'none' | 'publish' | 'import'>('none')

  const [pubName, setPubName] = useState('')
  const [pubAuthor, setPubAuthor] = useState(defaultAuthorName || '')
  const [pubTags, setPubTags] = useState('配信向け, 高視認性')
  const [pubDesc, setPubDesc] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [publishResult, setPublishResult] = useState<{ message: string; url?: string } | null>(null)

  const [importInput, setImportInput] = useState('')
  const [importing, setImporting] = useState(false)
  const [importedPreview, setImportedPreview] = useState<SharedStyleEntry | null>(null)
  const [statusNotice, setStatusNotice] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [savingPreset, setSavingPreset] = useState(false)

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
      setSelectedId((prev) => {
        if (prev && list.some((s) => s.id === prev)) return prev
        return list[0]?.id || null
      })
    } catch {
      setStatusNotice('カタログの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

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
    return ['すべて', ...Array.from(counts.keys()).slice(0, 10)]
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

  const selectedEntry = useMemo(() => {
    if (importedPreview && selectedId === importedPreview.id) return importedPreview
    return styles.find((s) => s.id === selectedId) || filteredStyles[0] || null
  }, [styles, filteredStyles, selectedId, importedPreview])

  const previewConfig = useMemo(
    () => normalizeCommentStyle(selectedEntry?.config || currentStyle),
    [selectedEntry, currentStyle]
  )

  const notify = (msg: string) => {
    setStatusNotice(msg)
    window.setTimeout(() => {
      setStatusNotice((cur) => (cur === msg ? null : cur))
    }, 3200)
  }

  const handleCopyCode = async (entry: SharedStyleEntry) => {
    const code = encodeShareCode(entry.name, normalizeCommentStyle(entry.config))
    await navigator.clipboard.writeText(code)
    setCopiedId(entry.id)
    notify(`「${entry.name}」の共有コードをコピーしました`)
    window.setTimeout(() => setCopiedId(null), 1600)
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
    if (!pubName.trim()) {
      notify('公開するスタイル名を入力してください')
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
        name: pubName.trim(),
        author: pubAuthor.trim() || 'Anonymous',
        description: pubDesc.trim(),
        tags,
        config: currentStyle,
      })
      setStyles((prev) => [res.entry, ...prev.filter((p) => p.id !== res.entry.id)])
      setSelectedId(res.entry.id)
      if (res.method === 'gist') {
        setPublishResult({
          message: hasRelayServer
            ? 'Gist 公開およびリレーサーバーへ送信しました'
            : 'GitHub Gist に公開しました',
          url: res.url,
        })
      } else {
        setPublishResult({
          message: hasRelayServer
            ? 'リレーサーバーへ送信しました。GitHub全体カタログ登録用ページを開けます。'
            : 'GitHub コミュニティ掲載リクエストを作成しました。開いたページから送信できます。',
          url: res.url,
        })
        if (window.nicotube?.openExternal) {
          await window.nicotube.openExternal(res.url)
        } else {
          window.open(res.url, '_blank')
        }
      }
      setPubName('')
      setPubDesc('')
    } catch (err) {
      notify(err instanceof Error ? err.message : 'スタイル公開に失敗しました')
    } finally {
      setPublishing(false)
    }
  }

  const handleImportPreview = async () => {
    const raw = importInput.trim()
    if (!raw) return
    setImporting(true)
    try {
      const imported = await api.importStyleFromUrl(raw)
      const entry: SharedStyleEntry = {
        id: `import-${Date.now()}`,
        name: imported.name,
        author: imported.author,
        description: imported.description,
        tags: imported.tags || ['インポート'],
        source: 'local',
        created_at: Date.now() / 1000,
        config: normalizeCommentStyle(imported.config),
      }
      setImportedPreview(entry)
      setSelectedId(entry.id)
      setImportInput('')
      notify(`「${entry.name}」をプレビューに読み込みました`)
    } catch (err) {
      notify(err instanceof Error ? err.message : '読込に失敗しました')
    } finally {
      setImporting(false)
    }
  }

  const handleDeleteLocal = async (entry: SharedStyleEntry) => {
    try {
      await api.deleteSharedStyle(entry.id)
      setStyles((prev) => prev.filter((s) => s.id !== entry.id))
      if (selectedId === entry.id) {
        setSelectedId(styles.find((s) => s.id !== entry.id)?.id || null)
      }
      notify('ローカル共有エントリーを削除しました')
    } catch (err) {
      notify(err instanceof Error ? err.message : '削除に失敗しました')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-[var(--md-on-surface)]">
            みんなのコメントスタイル
          </h1>
          <p className="mt-0.5 text-xs text-[var(--md-on-surface-muted)]">
            GitHubカタログや共有サーバー上のスタイルをライブプレビューで確認し、そのまま適用または公開できます
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setActionPanel((v) => (v === 'import' ? 'none' : 'import'))}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              actionPanel === 'import'
                ? 'border-[var(--md-primary)] bg-[var(--md-primary-tonal)] text-[var(--md-on-primary-tonal)]'
                : 'border-[var(--md-outline-variant)] bg-[var(--md-surface)] text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-high)]'
            }`}
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>URL / コード読込</span>
          </button>
          <button
            type="button"
            onClick={() => setActionPanel((v) => (v === 'publish' ? 'none' : 'publish'))}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              actionPanel === 'publish'
                ? 'border-[var(--md-primary)] bg-[var(--md-primary)] text-[var(--md-on-primary)]'
                : 'border-[var(--md-outline-variant)] bg-[var(--md-surface)] text-[var(--md-on-surface)] hover:bg-[var(--md-surface-high)]'
            }`}
          >
            <Share2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            <span>自分の設定を公開</span>
          </button>
          <button
            type="button"
            onClick={() => loadCatalog(true)}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-1.5 text-xs font-medium text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-high)]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
            <span>更新</span>
          </button>
        </div>
      </div>

      {statusNotice && (
        <div className="rounded-lg border border-[var(--md-primary)]/40 bg-[var(--md-primary-tonal)] px-3 py-2 text-xs text-[var(--md-on-primary-tonal)]">
          {statusNotice}
        </div>
      )}

      {actionPanel === 'import' && (
        <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-low)] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs font-medium text-[var(--md-on-surface)]">
              GitHub Gist / Raw JSON URL / 共有コード (NTS1:...) からインポート
            </span>
          </div>
          <div className="mt-2.5 flex gap-2">
            <input
              type="text"
              value={importInput}
              onChange={(e) => setImportInput(e.target.value)}
              placeholder="https://gist.github.com/... または https://raw.githubusercontent.com/... または NTS1:..."
              className="flex-1 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-dim)] px-3 py-2 text-xs text-[var(--md-on-surface)] placeholder:text-[var(--md-on-surface-muted)] focus:border-[var(--md-primary)] focus:outline-none"
            />
            <button
              type="button"
              onClick={handleImportPreview}
              disabled={importing || !importInput.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--md-primary)] px-4 py-2 text-xs font-medium text-[var(--md-on-primary)] disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span>{importing ? '読込中...' : 'プレビュー表示'}</span>
            </button>
          </div>
        </div>
      )}

      {actionPanel === 'publish' && (
        <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-low)] p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-medium text-[var(--md-on-surface)]">
                現在のコメントスタイルを公開する
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--md-on-surface-muted)]">
                {hasGithubToken
                  ? 'GitHubトークン設定済み: 公開Gistを自動作成しURLを発行します'
                  : '公開用GitHub Issue投稿ページを生成します（リレーサーバー設定時は即時反映）'}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="block space-y-1">
              <span className="text-[11px] text-[var(--md-on-surface-muted)]">スタイル名</span>
              <input
                type="text"
                value={pubName}
                onChange={(e) => setPubName(e.target.value)}
                placeholder="例: 夜雑談パステル弾幕"
                className="w-full rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-dim)] px-3 py-2 text-xs text-[var(--md-on-surface)] focus:border-[var(--md-primary)] focus:outline-none"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-[var(--md-on-surface-muted)]">作成者名</span>
              <input
                type="text"
                value={pubAuthor}
                onChange={(e) => setPubAuthor(e.target.value)}
                placeholder="ハンドルネーム"
                className="w-full rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-dim)] px-3 py-2 text-xs text-[var(--md-on-surface)] focus:border-[var(--md-primary)] focus:outline-none"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-[var(--md-on-surface-muted)]">タグ (カンマ区切り)</span>
              <input
                type="text"
                value={pubTags}
                onChange={(e) => setPubTags(e.target.value)}
                placeholder="FPS, Twitch, 太縁"
                className="w-full rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-dim)] px-3 py-2 text-xs text-[var(--md-on-surface)] focus:border-[var(--md-primary)] focus:outline-none"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={pubDesc}
              onChange={(e) => setPubDesc(e.target.value)}
              placeholder="特徴やおすすめの配信ジャンルを入力..."
              className="flex-1 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-dim)] px-3 py-2 text-xs text-[var(--md-on-surface)] focus:border-[var(--md-primary)] focus:outline-none"
            />
            <button
              type="button"
              onClick={handlePublish}
              disabled={publishing || !pubName.trim()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--md-primary)] px-4 py-2 text-xs font-medium text-[var(--md-on-primary)] disabled:opacity-50"
            >
              <Globe className="h-3.5 w-3.5" strokeWidth={1.5} />
              <span>{publishing ? '送信中...' : '公開する'}</span>
            </button>
          </div>
          {publishResult && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--md-positive)]/30 bg-[var(--md-positive)]/10 px-3 py-2 text-xs text-[var(--md-on-surface)]">
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
                  className="inline-flex items-center gap-1 text-xs font-medium text-[var(--md-primary)] hover:underline"
                >
                  <span>URLを開く</span>
                  <ExternalLink className="h-3 w-3" strokeWidth={1.5} />
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left: Live Danmaku Preview Stage */}
        <div className="xl:col-span-7 space-y-3">
          <DanmakuCanvas
            styleConfig={previewConfig}
            thumbnailUrl={thumbnailUrl}
          />

          {selectedEntry && (
            <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-low)] p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-[var(--md-on-surface)]">
                      {selectedEntry.name}
                    </h2>
                    <span className="rounded-md bg-[var(--md-surface-high)] px-2 py-0.5 text-[10px] font-medium text-[var(--md-on-surface-variant)]">
                      {SOURCE_LABELS[selectedEntry.source || 'github'] || selectedEntry.source}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[var(--md-on-surface-variant)]">
                    {selectedEntry.description || '説明なし'}
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] font-mono tabular-nums text-[var(--md-on-surface-muted)]">
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
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--md-outline-variant)] pt-3">
                <button
                  type="button"
                  onClick={() => {
                    onApplyStyle(previewConfig, false)
                    notify(`「${selectedEntry.name}」を現在の合成スタイルに適用しました`)
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--md-primary)] px-3.5 py-2 text-xs font-medium text-[var(--md-on-primary)] transition-opacity hover:opacity-90"
                >
                  <Sparkles className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>このスタイルを適用</span>
                </button>
                <button
                  type="button"
                  onClick={() => onApplyStyle(previewConfig, true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-2 text-xs font-medium text-[var(--md-on-surface)] hover:bg-[var(--md-surface-high)]"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>適用して詳細調整へ</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleSavePreset(selectedEntry)}
                  disabled={savingPreset}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-2 text-xs font-medium text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-high)]"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span>プリセット保存</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleCopyCode(selectedEntry)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] px-3 py-2 text-xs font-medium text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-high)]"
                >
                  {copiedId === selectedEntry.id ? (
                    <Check className="h-3.5 w-3.5 text-[var(--md-positive)]" strokeWidth={1.5} />
                  ) : (
                    <Copy className="h-3.5 w-3.5" strokeWidth={1.5} />
                  )}
                  <span>共有コード</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Search, Tags & Style Directory */}
        <div className="xl:col-span-5 space-y-3">
          <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-low)] p-3 space-y-2.5">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--md-on-surface-muted)]"
                strokeWidth={1.5}
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="スタイル名・タグ・作成者で絞り込み"
                className="w-full rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface-dim)] py-2 pl-8 pr-3 text-xs text-[var(--md-on-surface)] placeholder:text-[var(--md-on-surface-muted)] focus:border-[var(--md-primary)] focus:outline-none"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => setActiveTag(tag)}
                  className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                    activeTag === tag
                      ? 'bg-[var(--md-primary-tonal)] text-[var(--md-on-primary-tonal)]'
                      : 'bg-[var(--md-surface)] text-[var(--md-on-surface-muted)] hover:text-[var(--md-on-surface)]'
                  }`}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          <div className="max-h-[540px] space-y-2 overflow-y-auto pr-1">
            {importedPreview && (
              <button
                type="button"
                onClick={() => setSelectedId(importedPreview.id)}
                className={`w-full rounded-xl border p-3 text-left transition-colors ${
                  selectedId === importedPreview.id
                    ? 'border-[var(--md-primary)] bg-[var(--md-primary-tonal)]'
                    : 'border-[var(--md-outline-variant)] bg-[var(--md-surface-low)] hover:bg-[var(--md-surface)]'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[var(--md-on-surface)]">
                    {importedPreview.name}
                  </span>
                  <span className="rounded bg-[var(--md-surface-high)] px-1.5 py-0.5 text-[10px] text-[var(--md-on-surface-variant)]">
                    インポートプレビュー
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] text-[var(--md-on-surface-muted)]">
                  {importedPreview.description}
                </p>
              </button>
            )}

            {filteredStyles.map((item) => {
              const isSelected = selectedEntry?.id === item.id
              const cfg = normalizeCommentStyle(item.config)
              return (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedId(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setSelectedId(item.id)
                  }}
                  className={`cursor-pointer rounded-xl border p-3 transition-colors ${
                    isSelected
                      ? 'border-[var(--md-primary)] bg-[var(--md-primary-tonal)]'
                      : 'border-[var(--md-outline-variant)] bg-[var(--md-surface-low)] hover:bg-[var(--md-surface)]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Layers className="h-3.5 w-3.5 shrink-0 text-[var(--md-primary)]" strokeWidth={1.5} />
                        <span className="truncate text-xs font-semibold text-[var(--md-on-surface)]">
                          {item.name}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--md-on-surface-variant)]">
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
                        title="ローカル共有を削除"
                        className="rounded-md p-1 text-[var(--md-on-surface-muted)] hover:bg-[var(--md-surface-high)] hover:text-[var(--md-error)]"
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
                          className="rounded bg-[var(--md-surface-high)] px-1.5 py-0.5 text-[10px] text-[var(--md-on-surface-variant)]"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                    <span className="font-mono text-[10px] tabular-nums text-[var(--md-on-surface-muted)]">
                      {item.author} · {cfg.font_family}
                    </span>
                  </div>
                </div>
              )
            })}

            {!loading && filteredStyles.length === 0 && (
              <div className="rounded-xl border border-dashed border-[var(--md-outline-variant)] p-6 text-center text-xs text-[var(--md-on-surface-muted)]">
                該当する共有スタイルが見つかりませんでした
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
