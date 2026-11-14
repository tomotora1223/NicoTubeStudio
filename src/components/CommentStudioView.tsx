import { useMemo, useState, type ReactNode } from 'react'
import {
  ChevronRight,
  Compass,
  Layers,
  Maximize2,
  MoveHorizontal,
  Palette,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Type,
  Users,
} from 'lucide-react'
import { DanmakuCanvas } from './DanmakuCanvas'
import { FontPickerModal } from './FontPickerModal'
import {
  DEFAULT_SUPERCHAT_TIER_COLORS,
  SUPERCHAT_TIER_LABELS,
  normalizeCommentStyle,
  type CollisionMode,
  type CommentStyleConfig,
  type EventDisplayMode,
  type PinMode,
  type Preset,
  type SuperChatMode,
  type SuperChatTierKey,
} from '../types/studio'

interface CommentStudioViewProps {
  styleConfig: CommentStyleConfig
  onChangeStyle: (next: CommentStyleConfig) => void
  presets: Preset[]
  activePresetId: string
  onSelectPreset: (id: string) => void
  onCreatePreset: (name: string, description: string, cfg: CommentStyleConfig) => Promise<void>
  onUpdatePreset: (id: string, name: string, description: string, cfg: CommentStyleConfig) => Promise<void>
  onDeletePreset: (id: string) => Promise<void>
  onOpenFullscreenPreview: () => void
  onOpenCommunityGallery?: () => void
  thumbnailUrl?: string | null
}

type StudioSubTab = 'typography' | 'motion' | 'roles' | 'youtube'

const SUB_TABS: Array<{ id: StudioSubTab; label: string; icon: typeof Type }> = [
  { id: 'typography', label: '文字・装飾', icon: Type },
  { id: 'motion', label: '配置・弾幕', icon: MoveHorizontal },
  { id: 'roles', label: 'ユーザー種別', icon: Users },
  { id: 'youtube', label: 'チャット演出', icon: Sparkles },
]

const FONT_WEIGHT_OPTIONS = [
  { value: 400, label: 'Regular (400)' },
  { value: 500, label: 'Medium (500)' },
  { value: 600, label: 'SemiBold (600)' },
  { value: 700, label: 'Bold (700)' },
  { value: 800, label: 'ExtraBold (800)' },
  { value: 900, label: 'Black (900)' },
]

const EVENT_MODE_OPTIONS: Array<{ id: EventDisplayMode; label: string }> = [
  { id: 'follow_superchat', label: 'スパチャに合わせる' },
  { id: 'card_scroll', label: '流れカード' },
  { id: 'card_top', label: '上部カード固定' },
  { id: 'text_color', label: '色付き弾幕' },
  { id: 'hide', label: '非表示' },
]

export function CommentStudioView({
  styleConfig,
  onChangeStyle,
  presets,
  activePresetId,
  onSelectPreset,
  onCreatePreset,
  onUpdatePreset,
  onDeletePreset,
  onOpenFullscreenPreview,
  onOpenCommunityGallery,
  thumbnailUrl,
}: CommentStudioViewProps) {
  const [subTab, setSubTab] = useState<StudioSubTab>('typography')
  const [fontModalOpen, setFontModalOpen] = useState(false)
  const [newPresetOpen, setNewPresetOpen] = useState(false)
  const [newPresetName, setNewPresetName] = useState('')
  const [saveNotice, setSaveNotice] = useState<string | null>(null)
  const [ngWordInput, setNgWordInput] = useState('')

  const activePreset = useMemo(
    () => presets.find((p) => p.id === activePresetId),
    [presets, activePresetId]
  )

  const setField = <K extends keyof CommentStyleConfig>(key: K, value: CommentStyleConfig[K]) => {
    onChangeStyle({ ...styleConfig, [key]: value })
  }

  const showToast = (msg: string) => {
    setSaveNotice(msg)
    setTimeout(() => setSaveNotice(null), 2400)
  }

  const handleSavePreset = async () => {
    if (!activePreset || activePreset.is_builtin) return
    await onUpdatePreset(activePreset.id, activePreset.name, activePreset.description, styleConfig)
    showToast('プリセットを上書き保存しました')
  }

  const handleCreate = async () => {
    const trimmed = newPresetName.trim()
    if (!trimmed) return
    await onCreatePreset(trimmed, 'ユーザー作成スタイル', styleConfig)
    setNewPresetName('')
    setNewPresetOpen(false)
    showToast(`「${trimmed}」を作成しました`)
  }

  const handleAddNgWord = () => {
    const word = ngWordInput.trim()
    if (!word) return
    if (!styleConfig.ng_words.includes(word)) {
      setField('ng_words', [...styleConfig.ng_words, word])
    }
    setNgWordInput('')
  }

  const renderTierColorRow = (tier: { key: SuperChatTierKey; label: string; sampleAmount: string }) => {
    const val = styleConfig.superchat_tier_colors?.[tier.key] || DEFAULT_SUPERCHAT_TIER_COLORS[tier.key]
    return (
      <div
        key={tier.key}
        className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5"
        style={{ backgroundColor: 'var(--md-surface)', borderColor: 'var(--md-outline-variant)' }}
      >
        <div className="min-w-0">
          <div className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
            {tier.label}
          </div>
          <div className="text-[10px] tabular-nums" style={{ color: 'var(--md-on-surface-muted)' }}>
            {tier.sampleAmount}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="color"
            value={val}
            onChange={(e) =>
              setField('superchat_tier_colors', {
                ...(styleConfig.superchat_tier_colors || DEFAULT_SUPERCHAT_TIER_COLORS),
                [tier.key]: e.target.value,
              })
            }
            className="h-6 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
          />
          <span className="w-[54px] font-mono text-[10px] uppercase" style={{ color: 'var(--md-on-surface-muted)' }}>
            {val}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header
        className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-3"
        style={{
          backgroundColor: 'var(--md-surface-low)',
          borderColor: 'var(--md-outline-variant)',
        }}
      >
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-[17px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
            コメント演出スタジオ
          </h1>
          <select
            value={activePresetId}
            onChange={(e) => onSelectPreset(e.target.value)}
            className="h-8 min-w-[200px] rounded-lg border px-2.5 text-[12px] outline-none"
            style={{
              backgroundColor: 'var(--md-surface)',
              borderColor: 'var(--md-outline-variant)',
              color: 'var(--md-on-surface)',
            }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.is_builtin ? ' (標準)' : ''}
              </option>
            ))}
          </select>

          {!activePreset?.is_builtin && (
            <button
              type="button"
              onClick={() => void handleSavePreset()}
              className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition-colors"
              style={{
                backgroundColor: 'var(--md-primary-tonal)',
                borderColor: 'var(--md-primary)',
                color: 'var(--md-on-primary-tonal)',
              }}
            >
              <Save className="h-3.5 w-3.5" />
              上書き保存
            </button>
          )}

          <button
            type="button"
            onClick={() => setNewPresetOpen((v) => !v)}
            className="flex h-8 items-center gap-1 rounded-lg border px-2.5 text-[12px]"
            style={{
              backgroundColor: 'var(--md-surface-high)',
              borderColor: 'var(--md-outline-variant)',
              color: 'var(--md-on-surface)',
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            新規保存
          </button>

          {!activePreset?.is_builtin && (
            <button
              type="button"
              onClick={() => void onDeletePreset(activePresetId)}
              className="flex h-8 w-8 items-center justify-center rounded-lg border"
              style={{
                backgroundColor: 'var(--md-surface)',
                borderColor: 'var(--md-outline-variant)',
                color: 'var(--md-error)',
              }}
              title="このプリセットを削除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}

          {saveNotice && (
            <span className="text-[12px] font-medium" style={{ color: 'var(--md-primary)' }}>
              {saveNotice}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onChangeStyle(normalizeCommentStyle(null))}
            className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px]"
            style={{
              backgroundColor: 'var(--md-surface)',
              borderColor: 'var(--md-outline-variant)',
              color: 'var(--md-on-surface-variant)',
            }}
            title="ニコニコ標準設定に戻す"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            初期化
          </button>
          <button
            type="button"
            onClick={onOpenFullscreenPreview}
            className="flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-medium"
            style={{
              backgroundColor: 'var(--md-primary)',
              color: 'var(--md-on-primary)',
            }}
          >
            <Maximize2 className="h-3.5 w-3.5" />
            全画面プレビュー
          </button>
        </div>
      </header>

      {newPresetOpen && (
        <div
          className="flex items-center gap-2 border-b px-6 py-2.5"
          style={{
            backgroundColor: 'var(--md-surface)',
            borderColor: 'var(--md-outline-variant)',
          }}
        >
          <input
            type="text"
            value={newPresetName}
            onChange={(e) => setNewPresetName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
            placeholder="新しいプリセット名を入力"
            className="h-8 w-64 rounded-lg border px-3 text-[12px] outline-none"
            style={{
              backgroundColor: 'var(--md-surface-low)',
              borderColor: 'var(--md-outline-variant)',
              color: 'var(--md-on-surface)',
            }}
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            className="h-8 rounded-lg px-3 text-[12px] font-medium"
            style={{ backgroundColor: 'var(--md-primary)', color: 'var(--md-on-primary)' }}
          >
            保存
          </button>
          <button
            type="button"
            onClick={() => setNewPresetOpen(false)}
            className="h-8 rounded-lg px-2.5 text-[12px]"
            style={{ color: 'var(--md-on-surface-muted)' }}
          >
            キャンセル
          </button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-h-0 flex-col justify-between gap-4 overflow-y-auto p-6">
          <DanmakuCanvas
            styleConfig={styleConfig}
            thumbnailUrl={thumbnailUrl}
            onOpenFullscreen={onOpenFullscreenPreview}
          />
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-2.5 text-[12px]"
            style={{
              backgroundColor: 'var(--md-surface-low)',
              borderColor: 'var(--md-outline-variant)',
              color: 'var(--md-on-surface-variant)',
            }}
          >
            <span>右側のタブで設定を変えるとリアルタイムに弾幕へ反映されます</span>
            {onOpenCommunityGallery && (
              <button
                type="button"
                onClick={onOpenCommunityGallery}
                className="flex items-center gap-1.5 font-medium"
                style={{ color: 'var(--md-primary)' }}
              >
                <Compass className="h-3.5 w-3.5" strokeWidth={1.5} />
                <span>みんなのスタイルで公開・書き出し</span>
                <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.5} />
              </button>
            )}
          </div>
        </div>

        <aside
          className="flex min-h-0 flex-col border-t lg:border-t-0 lg:border-l"
          style={{
            backgroundColor: 'var(--md-surface-low)',
            borderColor: 'var(--md-outline-variant)',
          }}
        >
          <div
            className="grid grid-cols-4 border-b"
            style={{ borderColor: 'var(--md-outline-variant)' }}
          >
            {SUB_TABS.map((t) => {
              const Icon = t.icon
              const active = subTab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSubTab(t.id)}
                  className="flex flex-col items-center justify-center gap-1 border-b-2 px-1 py-2.5 text-[11px] font-medium transition-colors"
                  style={{
                    borderColor: active ? 'var(--md-primary)' : 'transparent',
                    color: active ? 'var(--md-primary)' : 'var(--md-on-surface-muted)',
                    backgroundColor: active ? 'var(--md-primary-tonal)' : 'transparent',
                  }}
                >
                  <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
                  <span className="truncate">{t.label}</span>
                </button>
              )
            })}
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            {/* TAB 1: TYPOGRAPHY / OUTLINE / SHADOW */}
            {subTab === 'typography' && (
              <>
                <InspectorCard title="フォントと文字基本" icon={<Type className="h-3.5 w-3.5" />}>
                  <div>
                    <div className="mb-1.5 text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      使用フォント（端末インストール済み全対応）
                    </div>
                    <button
                      type="button"
                      onClick={() => setFontModalOpen(true)}
                      className="flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors"
                      style={{
                        backgroundColor: 'var(--md-surface)',
                        borderColor: 'var(--md-outline-variant)',
                        color: 'var(--md-on-surface)',
                      }}
                    >
                      <div className="min-w-0">
                        <div
                          className="truncate text-[14px] font-semibold"
                          style={{ fontFamily: `"${styleConfig.font_family}", sans-serif` }}
                        >
                          {styleConfig.font_family}
                        </div>
                        <div
                          className="truncate text-[11px]"
                          style={{
                            color: 'var(--md-on-surface-muted)',
                            fontFamily: `"${styleConfig.font_family}", sans-serif`,
                          }}
                        >
                          日本語プレビュー: 888888 草 ナイスプレイ
                        </div>
                      </div>
                      <span
                        className="ml-2 flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium"
                        style={{
                          backgroundColor: 'var(--md-primary-tonal)',
                          color: 'var(--md-on-primary-tonal)',
                        }}
                      >
                        一覧を開く
                        <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    </button>
                    <p className="mt-1 text-[11px]" style={{ color: 'var(--md-on-surface-muted)' }}>
                      新しく入れたフォントも一覧内の「再スキャン」から再起動なしで即反映できます
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="mb-1 block text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                        フォントウェイト
                      </label>
                      <select
                        value={styleConfig.font_weight}
                        onChange={(e) => setField('font_weight', Number(e.target.value))}
                        className="h-8 w-full rounded-lg border px-2 text-[12px] outline-none"
                        style={{
                          backgroundColor: 'var(--md-surface)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-on-surface)',
                        }}
                      >
                        {FONT_WEIGHT_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <ColorField
                      label="通常コメント文字色"
                      value={styleConfig.default_color}
                      onChange={(v) => setField('default_color', v)}
                    />
                  </div>

                  <SliderField
                    label="文字サイズ倍率"
                    value={styleConfig.font_scale}
                    min={0.5}
                    max={2.0}
                    step={0.05}
                    format={(v) => `${v.toFixed(2)}x`}
                    onChange={(v) => setField('font_scale', v)}
                  />
                  <SliderField
                    label="文字の不透明度"
                    value={styleConfig.opacity}
                    min={0.2}
                    max={1.0}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => setField('opacity', v)}
                  />
                </InspectorCard>

                <InspectorCard title="縁取り（1段目・2段目）" icon={<Layers className="h-3.5 w-3.5" />}>
                  <div className="grid grid-cols-2 gap-3">
                    <ColorField
                      label="第1縁取りの色"
                      value={styleConfig.outline_color}
                      onChange={(v) => setField('outline_color', v)}
                    />
                    <SliderField
                      label="第1縁取り不透明度"
                      value={styleConfig.outline_opacity}
                      min={0}
                      max={1}
                      step={0.05}
                      format={(v) => `${Math.round(v * 100)}%`}
                      onChange={(v) => setField('outline_opacity', v)}
                    />
                  </div>
                  <SliderField
                    label="第1縁取りの太さ"
                    value={styleConfig.outline_width}
                    min={0}
                    max={8}
                    step={0.25}
                    format={(v) => `${v.toFixed(2)} px`}
                    onChange={(v) => setField('outline_width', v)}
                  />

                  <div className="border-t pt-3" style={{ borderColor: 'var(--md-outline-variant)' }}>
                    <div className="mb-2 text-[11px] font-medium" style={{ color: 'var(--md-on-surface-variant)' }}>
                      二重縁取り（外側フチ・0 px で無効）
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <ColorField
                        label="第2縁取りの色"
                        value={styleConfig.outline2_color}
                        onChange={(v) => setField('outline2_color', v)}
                      />
                      <SliderField
                        label="第2縁取り不透明度"
                        value={styleConfig.outline2_opacity}
                        min={0}
                        max={1}
                        step={0.05}
                        format={(v) => `${Math.round(v * 100)}%`}
                        onChange={(v) => setField('outline2_opacity', v)}
                      />
                    </div>
                    <div className="mt-2">
                      <SliderField
                        label="第2縁取りの追加幅"
                        value={styleConfig.outline2_width}
                        min={0}
                        max={8}
                        step={0.25}
                        format={(v) => `${v.toFixed(2)} px`}
                        onChange={(v) => setField('outline2_width', v)}
                      />
                    </div>
                  </div>
                </InspectorCard>

                <InspectorCard title="ドロップシャドウ" icon={<Palette className="h-3.5 w-3.5" />}>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      文字シャドウを有効にする
                    </span>
                    <ToggleButton
                      active={styleConfig.shadow_enabled}
                      onLabel="有効"
                      offLabel="無効"
                      onClick={() => setField('shadow_enabled', !styleConfig.shadow_enabled)}
                    />
                  </div>

                  {styleConfig.shadow_enabled && (
                    <div className="space-y-2.5 pt-1">
                      <div className="grid grid-cols-2 gap-3">
                        <ColorField
                          label="シャドウ色"
                          value={styleConfig.shadow_color}
                          onChange={(v) => setField('shadow_color', v)}
                        />
                        <SliderField
                          label="シャドウ不透明度"
                          value={styleConfig.shadow_opacity}
                          min={0}
                          max={1}
                          step={0.05}
                          format={(v) => `${Math.round(v * 100)}%`}
                          onChange={(v) => setField('shadow_opacity', v)}
                        />
                      </div>
                      <SliderField
                        label="ぼかし半径 (Blur)"
                        value={styleConfig.shadow_blur}
                        min={0}
                        max={12}
                        step={0.5}
                        format={(v) => `${v.toFixed(1)} px`}
                        onChange={(v) => setField('shadow_blur', v)}
                      />
                      <div className="grid grid-cols-2 gap-3">
                        <SliderField
                          label="横オフセット X"
                          value={styleConfig.shadow_offset_x}
                          min={-8}
                          max={8}
                          step={0.5}
                          format={(v) => `${v.toFixed(1)} px`}
                          onChange={(v) => setField('shadow_offset_x', v)}
                        />
                        <SliderField
                          label="縦オフセット Y"
                          value={styleConfig.shadow_offset_y}
                          min={-8}
                          max={8}
                          step={0.5}
                          format={(v) => `${v.toFixed(1)} px`}
                          onChange={(v) => setField('shadow_offset_y', v)}
                        />
                      </div>
                    </div>
                  )}
                </InspectorCard>
              </>
            )}

            {/* TAB 2: MOTION & LAYOUT */}
            {subTab === 'motion' && (
              <>
                <InspectorCard title="弾幕速度と表示時間" icon={<MoveHorizontal className="h-3.5 w-3.5" />}>
                  <SliderField
                    label="スクロール横断時間 (ニコニコ標準 4.0秒)"
                    value={styleConfig.scroll_duration_sec}
                    min={2.0}
                    max={9.0}
                    step={0.2}
                    format={(v) => `${v.toFixed(1)} 秒`}
                    onChange={(v) => setField('scroll_duration_sec', v)}
                  />
                  <SliderField
                    label="固定コメント表示時間 (ue / shita)"
                    value={styleConfig.fixed_duration_sec}
                    min={1.5}
                    max={8.0}
                    step={0.2}
                    format={(v) => `${v.toFixed(1)} 秒`}
                    onChange={(v) => setField('fixed_duration_sec', v)}
                  />
                  <SliderField
                    label="表示縦幅エリア"
                    value={styleConfig.display_area_ratio}
                    min={0.25}
                    max={1.0}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => setField('display_area_ratio', v)}
                  />
                </InspectorCard>

                <InspectorCard title="行間・レーン・衝突制御" icon={<Layers className="h-3.5 w-3.5" />}>
                  <SliderField
                    label="1行あたり高さ比率"
                    value={styleConfig.line_height_ratio}
                    min={1.0}
                    max={1.6}
                    step={0.05}
                    format={(v) => `${v.toFixed(2)}x`}
                    onChange={(v) => setField('line_height_ratio', v)}
                  />
                  <SliderField
                    label="レーン間の余白"
                    value={styleConfig.lane_gap_px}
                    min={0}
                    max={24}
                    step={1}
                    format={(v) => `${Math.round(v)} px`}
                    onChange={(v) => setField('lane_gap_px', v)}
                  />
                  <SliderField
                    label="同時表示上限数"
                    value={styleConfig.max_concurrent}
                    min={15}
                    max={250}
                    step={5}
                    format={(v) => `${Math.round(v)} 件`}
                    onChange={(v) => setField('max_concurrent', v)}
                  />

                  <div className="space-y-1.5 pt-1">
                    <label className="block text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      コメント過密時の衝突ルール
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {([
                        { id: 'danmaku', label: '空レーン探し' },
                        { id: 'stagger', label: '少し重ねて維持' },
                        { id: 'drop', label: '満杯時スキップ' },
                      ] as Array<{ id: CollisionMode; label: string }>).map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setField('collision_mode', opt.id)}
                          className="h-8 rounded-lg border text-[11px] font-medium"
                          style={{
                            backgroundColor:
                              styleConfig.collision_mode === opt.id
                                ? 'var(--md-primary-tonal)'
                                : 'var(--md-surface)',
                            borderColor:
                              styleConfig.collision_mode === opt.id
                                ? 'var(--md-primary)'
                                : 'var(--md-outline-variant)',
                            color:
                              styleConfig.collision_mode === opt.id
                                ? 'var(--md-on-primary-tonal)'
                                : 'var(--md-on-surface-variant)',
                          }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <PinSelector
                    label="通常コメントの基本配置"
                    value={styleConfig.normal_pin_mode}
                    onChange={(v) => setField('normal_pin_mode', v)}
                  />
                </InspectorCard>
              </>
            )}

            {/* TAB 3: USER ROLES */}
            {subTab === 'roles' && (
              <>
                <InspectorCard title="メンバーシップ会員" icon={<Users className="h-3.5 w-3.5" />}>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      メンバー専用カラーを適用
                    </span>
                    <ToggleButton
                      active={styleConfig.member_color_enabled}
                      onLabel="適用する"
                      offLabel="通常色"
                      onClick={() => setField('member_color_enabled', !styleConfig.member_color_enabled)}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <ColorField
                      label="メンバー文字色"
                      value={styleConfig.member_color}
                      onChange={(v) => setField('member_color', v)}
                    />
                    <div>
                      <label className="mb-1 block text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                        バッジ表記 (空白可)
                      </label>
                      <input
                        type="text"
                        value={styleConfig.member_badge_text}
                        onChange={(e) => setField('member_badge_text', e.target.value)}
                        placeholder="[M] など"
                        className="h-8 w-full rounded-lg border px-2 text-[12px] outline-none"
                        style={{
                          backgroundColor: 'var(--md-surface)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-on-surface)',
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      コメント先頭にバッジを付与
                    </span>
                    <ToggleButton
                      active={styleConfig.member_badge_prefix}
                      onLabel="付与する"
                      offLabel="非表示"
                      onClick={() => setField('member_badge_prefix', !styleConfig.member_badge_prefix)}
                    />
                  </div>
                  <SliderField
                    label="メンバー文字サイズ倍率"
                    value={styleConfig.member_scale}
                    min={0.7}
                    max={1.6}
                    step={0.05}
                    format={(v) => `${v.toFixed(2)}x`}
                    onChange={(v) => setField('member_scale', v)}
                  />
                  <PinSelector
                    label="メンバーコメント配置"
                    value={styleConfig.member_pin_mode}
                    onChange={(v) => setField('member_pin_mode', v)}
                  />
                </InspectorCard>

                <InspectorCard title="モデレーター" icon={<Users className="h-3.5 w-3.5" />}>
                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { id: 'color' as const, label: '強調色+バッジ' },
                      { id: 'normal' as const, label: '通常コメント扱い' },
                      { id: 'hide' as const, label: '非表示' },
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() =>
                          onChangeStyle({
                            ...styleConfig,
                            moderator_mode: opt.id,
                            moderator_color_enabled: opt.id === 'color',
                          })
                        }
                        className="h-8 rounded-lg border text-[11px] font-medium"
                        style={{
                          backgroundColor:
                            styleConfig.moderator_mode === opt.id
                              ? 'var(--md-primary-tonal)'
                              : 'var(--md-surface)',
                          borderColor:
                            styleConfig.moderator_mode === opt.id
                              ? 'var(--md-primary)'
                              : 'var(--md-outline-variant)',
                          color:
                            styleConfig.moderator_mode === opt.id
                              ? 'var(--md-on-primary-tonal)'
                              : 'var(--md-on-surface-variant)',
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {styleConfig.moderator_mode === 'color' && (
                    <div className="space-y-2.5 pt-1">
                      <div className="grid grid-cols-2 gap-3">
                        <ColorField
                          label="モデレーター文字色"
                          value={styleConfig.moderator_color}
                          onChange={(v) => setField('moderator_color', v)}
                        />
                        <div>
                          <label className="mb-1 block text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                            バッジ表記
                          </label>
                          <input
                            type="text"
                            value={styleConfig.moderator_badge_text}
                            onChange={(e) => setField('moderator_badge_text', e.target.value)}
                            className="h-8 w-full rounded-lg border px-2 text-[12px] outline-none"
                            style={{
                              backgroundColor: 'var(--md-surface)',
                              borderColor: 'var(--md-outline-variant)',
                              color: 'var(--md-on-surface)',
                            }}
                          />
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                          バッジを先頭表示
                        </span>
                        <ToggleButton
                          active={styleConfig.moderator_badge_prefix}
                          onLabel="表示"
                          offLabel="オフ"
                          onClick={() => setField('moderator_badge_prefix', !styleConfig.moderator_badge_prefix)}
                        />
                      </div>
                      <SliderField
                        label="モデレーター文字サイズ倍率"
                        value={styleConfig.moderator_scale}
                        min={0.7}
                        max={1.6}
                        step={0.05}
                        format={(v) => `${v.toFixed(2)}x`}
                        onChange={(v) => setField('moderator_scale', v)}
                      />
                      <PinSelector
                        label="モデレーターコメント配置"
                        value={styleConfig.moderator_pin_mode}
                        onChange={(v) => setField('moderator_pin_mode', v)}
                      />
                    </div>
                  )}
                </InspectorCard>

                <InspectorCard title="配信者本人 (Owner)" icon={<Users className="h-3.5 w-3.5" />}>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      配信者専用カラーを適用
                    </span>
                    <ToggleButton
                      active={styleConfig.owner_color_enabled}
                      onLabel="適用する"
                      offLabel="通常色"
                      onClick={() => setField('owner_color_enabled', !styleConfig.owner_color_enabled)}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <ColorField
                      label="配信者文字色"
                      value={styleConfig.owner_color}
                      onChange={(v) => setField('owner_color', v)}
                    />
                    <div>
                      <label className="mb-1 block text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                        バッジ表記
                      </label>
                      <input
                        type="text"
                        value={styleConfig.owner_badge_text}
                        onChange={(e) => setField('owner_badge_text', e.target.value)}
                        className="h-8 w-full rounded-lg border px-2 text-[12px] outline-none"
                        style={{
                          backgroundColor: 'var(--md-surface)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-on-surface)',
                        }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      バッジを先頭表示
                    </span>
                    <ToggleButton
                      active={styleConfig.owner_badge_prefix}
                      onLabel="表示"
                      offLabel="オフ"
                      onClick={() => setField('owner_badge_prefix', !styleConfig.owner_badge_prefix)}
                    />
                  </div>
                  <SliderField
                    label="配信者文字サイズ倍率"
                    value={styleConfig.owner_scale}
                    min={0.7}
                    max={1.8}
                    step={0.05}
                    format={(v) => `${v.toFixed(2)}x`}
                    onChange={(v) => setField('owner_scale', v)}
                  />
                  <PinSelector
                    label="配信者コメント配置"
                    value={styleConfig.owner_pin_mode}
                    onChange={(v) =>
                      onChangeStyle({
                        ...styleConfig,
                        owner_pin_mode: v,
                        owner_pin_top: v === 'ue',
                      })
                    }
                  />
                </InspectorCard>
              </>
            )}

            {/* TAB 4: YOUTUBE SPECIAL EFFECTS */}
            {subTab === 'youtube' && (
              <>
                <InspectorCard title="スーパーチャット表示とカラー" icon={<Sparkles className="h-3.5 w-3.5" />}>
                  <div className="grid grid-cols-2 gap-1.5">
                    {([
                      { id: 'card_scroll', label: '流れカード' },
                      { id: 'card_top', label: '上部カード固定' },
                      { id: 'text_color', label: '色付き弾幕テキスト' },
                      { id: 'hide', label: '非表示' },
                    ] as Array<{ id: SuperChatMode; label: string }>).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setField('superchat_mode', opt.id)}
                        className="h-8 rounded-lg border text-[11px] font-medium"
                        style={{
                          backgroundColor:
                            styleConfig.superchat_mode === opt.id
                              ? 'var(--md-primary-tonal)'
                              : 'var(--md-surface)',
                          borderColor:
                            styleConfig.superchat_mode === opt.id
                              ? 'var(--md-primary)'
                              : 'var(--md-outline-variant)',
                          color:
                            styleConfig.superchat_mode === opt.id
                              ? 'var(--md-on-primary-tonal)'
                              : 'var(--md-on-surface-variant)',
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>

                  {styleConfig.superchat_mode !== 'hide' && (
                    <div className="space-y-3 pt-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                          金額バッジを表示する
                        </span>
                        <ToggleButton
                          active={styleConfig.superchat_show_amount}
                          onLabel="表示"
                          offLabel="非表示"
                          onClick={() => setField('superchat_show_amount', !styleConfig.superchat_show_amount)}
                        />
                      </div>

                      <div className="space-y-1.5">
                        <label className="block text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                          スパチャの配色ソース
                        </label>
                        <div className="grid grid-cols-3 gap-1.5">
                          {[
                            { id: 'official' as const, label: 'YouTube公式色' },
                            { id: 'custom' as const, label: '段階カスタム色' },
                            { id: 'youtube_raw' as const, label: '配信ログ元色' },
                          ].map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              onClick={() => setField('superchat_color_source', opt.id)}
                              className="h-8 rounded-lg border text-[11px] font-medium"
                              style={{
                                backgroundColor:
                                  styleConfig.superchat_color_source === opt.id
                                    ? 'var(--md-primary-tonal)'
                                    : 'var(--md-surface)',
                                borderColor:
                                  styleConfig.superchat_color_source === opt.id
                                    ? 'var(--md-primary)'
                                    : 'var(--md-outline-variant)',
                                color:
                                  styleConfig.superchat_color_source === opt.id
                                    ? 'var(--md-on-primary-tonal)'
                                    : 'var(--md-on-surface-variant)',
                              }}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {styleConfig.superchat_color_source === 'custom' && (
                        <div className="space-y-1.5 rounded-xl border p-2.5" style={{ borderColor: 'var(--md-outline-variant)' }}>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-medium" style={{ color: 'var(--md-on-surface-variant)' }}>
                              金額帯ごとのカラーカスタマイズ
                            </span>
                            <button
                              type="button"
                              onClick={() => setField('superchat_tier_colors', { ...DEFAULT_SUPERCHAT_TIER_COLORS })}
                              className="text-[11px]"
                              style={{ color: 'var(--md-primary)' }}
                            >
                              公式色へ戻す
                            </button>
                          </div>
                          <div className="space-y-1.5">
                            {SUPERCHAT_TIER_LABELS.map(renderTierColorRow)}
                          </div>
                        </div>
                      )}

                      <SliderField
                        label="スパチャ文字・カード倍率"
                        value={styleConfig.superchat_scale}
                        min={0.7}
                        max={1.6}
                        step={0.05}
                        format={(v) => `${v.toFixed(2)}x`}
                        onChange={(v) => setField('superchat_scale', v)}
                      />
                      <SliderField
                        label="スパチャ速度倍率 (1.0=通常, 0.7=ゆっくり)"
                        value={styleConfig.superchat_speed_multiplier}
                        min={0.5}
                        max={1.5}
                        step={0.05}
                        format={(v) => `${v.toFixed(2)}x`}
                        onChange={(v) => setField('superchat_speed_multiplier', v)}
                      />
                    </div>
                  )}
                </InspectorCard>

                <InspectorCard title="カード背景外観 (スパチャ / 加入 / ギフト)" icon={<Layers className="h-3.5 w-3.5" />}>
                  <SliderField
                    label="カード背景の不透明度"
                    value={styleConfig.card_opacity}
                    min={0.25}
                    max={1.0}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => setField('card_opacity', v)}
                  />
                  <SliderField
                    label="カード角丸 (Radius)"
                    value={styleConfig.card_radius_px}
                    min={0}
                    max={24}
                    step={1}
                    format={(v) => `${Math.round(v)} px`}
                    onChange={(v) => setField('card_radius_px', v)}
                  />
                  <SliderField
                    label="カード枠線の強さ"
                    value={styleConfig.card_border_opacity}
                    min={0}
                    max={1}
                    step={0.05}
                    format={(v) => `${Math.round(v * 100)}%`}
                    onChange={(v) => setField('card_border_opacity', v)}
                  />
                </InspectorCard>

                <InspectorCard title="ステッカー・メンバー加入・ギフト" icon={<Sparkles className="h-3.5 w-3.5" />}>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                        スーパーステッカー
                      </span>
                      <EventModeSelect
                        value={styleConfig.supersticker_mode}
                        onChange={(v) => setField('supersticker_mode', v)}
                      />
                    </div>
                    {styleConfig.supersticker_mode !== 'hide' && (
                      <SliderField
                        label="ステッカー表示倍率"
                        value={styleConfig.supersticker_scale}
                        min={0.7}
                        max={1.6}
                        step={0.05}
                        format={(v) => `${v.toFixed(2)}x`}
                        onChange={(v) => setField('supersticker_scale', v)}
                      />
                    )}
                  </div>

                  <div className="space-y-2 border-t pt-2.5" style={{ borderColor: 'var(--md-outline-variant)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                        メンバー新規加入 / マイルストーン
                      </span>
                      <EventModeSelect
                        value={styleConfig.membership_mode}
                        onChange={(v) =>
                          onChangeStyle({
                            ...styleConfig,
                            membership_mode: v,
                            membership_events_enabled: v !== 'hide',
                          })
                        }
                      />
                    </div>
                    {styleConfig.membership_mode !== 'hide' && (
                      <div className="space-y-2">
                        <ColorField
                          label="メンバー加入カード色"
                          value={styleConfig.membership_color}
                          onChange={(v) => setField('membership_color', v)}
                        />
                        <SliderField
                          label="メンバー加入倍率"
                          value={styleConfig.membership_scale}
                          min={0.7}
                          max={1.6}
                          step={0.05}
                          format={(v) => `${v.toFixed(2)}x`}
                          onChange={(v) => setField('membership_scale', v)}
                        />
                      </div>
                    )}
                  </div>

                  <div className="space-y-2 border-t pt-2.5" style={{ borderColor: 'var(--md-outline-variant)' }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-medium" style={{ color: 'var(--md-on-surface)' }}>
                        メンバーシップギフト
                      </span>
                      <EventModeSelect
                        value={styleConfig.gift_mode}
                        onChange={(v) => setField('gift_mode', v)}
                      />
                    </div>
                    {styleConfig.gift_mode !== 'hide' && (
                      <div className="space-y-2">
                        <ColorField
                          label="ギフト通知カード色"
                          value={styleConfig.gift_color}
                          onChange={(v) => setField('gift_color', v)}
                        />
                        <SliderField
                          label="ギフト通知倍率"
                          value={styleConfig.gift_scale}
                          min={0.7}
                          max={1.6}
                          step={0.05}
                          format={(v) => `${v.toFixed(2)}x`}
                          onChange={(v) => setField('gift_scale', v)}
                        />
                      </div>
                    )}
                  </div>
                </InspectorCard>

                <InspectorCard title="スタンプ・絵文字・NGワード" icon={<Type className="h-3.5 w-3.5" />}>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      YouTubeチャンネル固有スタンプ
                    </span>
                    <ToggleButton
                      active={styleConfig.custom_emotes_enabled}
                      onLabel="表示"
                      offLabel="非表示"
                      onClick={() => setField('custom_emotes_enabled', !styleConfig.custom_emotes_enabled)}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[12px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      Unicode絵文字を表示
                    </span>
                    <ToggleButton
                      active={styleConfig.unicode_emoji_enabled}
                      onLabel="表示"
                      offLabel="非表示"
                      onClick={() => setField('unicode_emoji_enabled', !styleConfig.unicode_emoji_enabled)}
                    />
                  </div>

                  <div className="space-y-2 border-t pt-2.5" style={{ borderColor: 'var(--md-outline-variant)' }}>
                    <label className="block text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
                      NGワード（含まれるコメントを除外）
                    </label>
                    <div className="flex gap-1.5">
                      <input
                        type="text"
                        value={ngWordInput}
                        onChange={(e) => setNgWordInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleAddNgWord()}
                        placeholder="除外したい語句を入力"
                        className="h-8 flex-1 rounded-lg border px-2.5 text-[12px] outline-none"
                        style={{
                          backgroundColor: 'var(--md-surface)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-on-surface)',
                        }}
                      />
                      <button
                        type="button"
                        onClick={handleAddNgWord}
                        className="h-8 rounded-lg border px-3 text-[12px] font-medium"
                        style={{
                          backgroundColor: 'var(--md-surface-high)',
                          borderColor: 'var(--md-outline-variant)',
                          color: 'var(--md-on-surface)',
                        }}
                      >
                        追加
                      </button>
                    </div>
                    {styleConfig.ng_words.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {styleConfig.ng_words.map((word) => (
                          <button
                            key={word}
                            type="button"
                            onClick={() =>
                              setField(
                                'ng_words',
                                styleConfig.ng_words.filter((w) => w !== word)
                              )
                            }
                            className="rounded-full border px-2.5 py-0.5 text-[11px]"
                            style={{
                              backgroundColor: 'var(--md-surface)',
                              borderColor: 'var(--md-outline-variant)',
                              color: 'var(--md-on-surface-variant)',
                            }}
                            title="クリックで削除"
                          >
                            {word} ×
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </InspectorCard>
              </>
            )}

          </div>
        </aside>
      </div>

      <FontPickerModal
        open={fontModalOpen}
        selectedFamily={styleConfig.font_family}
        onSelect={(family) => setField('font_family', family)}
        onClose={() => setFontModalOpen(false)}
      />
    </div>
  )
}

function InspectorCard({
  title,
  icon,
  children,
}: {
  title: string
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      className="space-y-3 rounded-2xl border p-3.5"
      style={{
        backgroundColor: 'var(--md-surface)',
        borderColor: 'var(--md-outline-variant)',
      }}
    >
      <h3
        className="flex items-center gap-1.5 text-[12px] font-semibold tracking-wide"
        style={{ color: 'var(--md-on-surface)' }}
      >
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span style={{ color: 'var(--md-on-surface-variant)' }}>{label}</span>
        <span className="font-mono tabular-nums" style={{ color: 'var(--md-on-surface)' }}>
          {format(value)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="m3-slider w-full cursor-pointer"
      />
    </div>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="mb-1 block text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
        {label}
      </label>
      <div
        className="flex h-8 items-center gap-2 rounded-lg border px-2"
        style={{
          backgroundColor: 'var(--md-surface)',
          borderColor: 'var(--md-outline-variant)',
        }}
      >
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        <span className="font-mono text-[11px] uppercase" style={{ color: 'var(--md-on-surface-variant)' }}>
          {value}
        </span>
      </div>
    </div>
  )
}

function ToggleButton({
  active,
  onLabel,
  offLabel,
  onClick,
}: {
  active: boolean
  onLabel: string
  offLabel: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-full border px-3 text-[11px] font-medium transition-colors"
      style={{
        backgroundColor: active ? 'var(--md-primary-tonal)' : 'var(--md-surface-high)',
        borderColor: active ? 'var(--md-primary)' : 'var(--md-outline-variant)',
        color: active ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-muted)',
      }}
    >
      {active ? onLabel : offLabel}
    </button>
  )
}

function PinSelector({
  label,
  value,
  onChange,
}: {
  label: string
  value: PinMode
  onChange: (v: PinMode) => void
}) {
  return (
    <div className="space-y-1">
      <span className="block text-[11px]" style={{ color: 'var(--md-on-surface-variant)' }}>
        {label}
      </span>
      <div className="grid grid-cols-3 gap-1.5">
        {[
          { id: 'naka' as const, label: '流す (naka)' },
          { id: 'ue' as const, label: '上固定 (ue)' },
          { id: 'shita' as const, label: '下固定 (shita)' },
        ].map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            className="h-7 rounded-lg border text-[11px] font-medium"
            style={{
              backgroundColor: value === opt.id ? 'var(--md-primary-tonal)' : 'var(--md-surface)',
              borderColor: value === opt.id ? 'var(--md-primary)' : 'var(--md-outline-variant)',
              color: value === opt.id ? 'var(--md-on-primary-tonal)' : 'var(--md-on-surface-variant)',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function EventModeSelect({
  value,
  onChange,
}: {
  value: EventDisplayMode
  onChange: (v: EventDisplayMode) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as EventDisplayMode)}
      className="h-7 rounded-lg border px-2 text-[11px] outline-none"
      style={{
        backgroundColor: 'var(--md-surface)',
        borderColor: 'var(--md-outline-variant)',
        color: 'var(--md-on-surface)',
      }}
    >
      {EVENT_MODE_OPTIONS.map((opt) => (
        <option key={opt.id} value={opt.id}>
          {opt.label}
        </option>
      ))}
    </select>
  )
}
