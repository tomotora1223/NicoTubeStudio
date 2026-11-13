import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { CaptureWorkspace } from './components/CaptureWorkspace'
import { CommentStudioView } from './components/CommentStudioView'
import { FullscreenPreviewModal } from './components/FullscreenPreviewModal'
import { NavRail, type NavTab } from './components/NavRail'
import { QueueView } from './components/QueueView'
import { SettingsAuthView } from './components/SettingsAuthView'
import { api, resolveApiBase } from './lib/api'
import {
  DEFAULT_COMMENT_STYLE,
  DEFAULT_ENCODE_CONFIG,
  normalizeCommentStyle,
  type AppSettings,
  type AppUpdateState,
  type AuthStatus,
  type CommentStyleConfig,
  type EncodeConfig,
  type EncoderProbeResult,
  type Preset,
  type QueueJob,
  type ToolUpdateStatus,
} from './types/studio'

export default function App() {
  const [ready, setReady] = useState(false)
  const [activeTab, setActiveTab] = useState<NavTab>('capture')

  const [settings, setSettings] = useState<AppSettings>({
    output_dir: '',
    theme: 'dark',
    active_preset_id: 'niconico-official',
    keep_temp_files: false,
    max_concurrent_jobs: 1,
    auto_update_tools: true,
    auto_update_app: true,
    update_feed_url: 'tomotora1223/NicoTubeStudio',
    style_server_url: '',
    encode_config: DEFAULT_ENCODE_CONFIG,
    last_comment_style: null,
  })
  const settingsRef = useRef<AppSettings>(settings)
  settingsRef.current = settings
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [presets, setPresets] = useState<Preset[]>([])
  const [activePresetId, setActivePresetId] = useState('niconico-official')
  const [commentStyle, setCommentStyle] = useState<CommentStyleConfig>(DEFAULT_COMMENT_STYLE)
  const [encodeConfig, setEncodeConfig] = useState<EncodeConfig>(DEFAULT_ENCODE_CONFIG)
  const [encoders, setEncoders] = useState<EncoderProbeResult | null>(null)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const [jobs, setJobs] = useState<QueueJob[]>([])
  const [toolProgress, setToolProgress] = useState<{ progress: number; label: string } | null>(null)
  const [toolUpdateStatus, setToolUpdateStatus] = useState<ToolUpdateStatus | null>(null)
  const [appUpdateState, setAppUpdateState] = useState<AppUpdateState | null>(null)

  const [fullscreenOpen, setFullscreenOpen] = useState(false)
  const [previewThumb, setPreviewThumb] = useState<string | null | undefined>(null)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme)
  }, [settings.theme])

  const loadInitial = useCallback(async () => {
    try {
      const [s, pList, enc, auth, q, upd] = await Promise.all([
        api.getSettings(),
        api.getPresets(),
        api.getEncoders(),
        api.getAuthStatus(),
        api.getQueue(),
        api.getToolUpdateStatus().catch(() => null),
      ])
      settingsRef.current = s
      setSettings(s)
      setPresets(pList)
      if (s.encode_config) {
        setEncodeConfig({ ...DEFAULT_ENCODE_CONFIG, ...s.encode_config })
      }
      const chosen = pList.find((p) => p.id === s.active_preset_id) || pList[0]
      if (chosen) {
        setActivePresetId(chosen.id)
      }
      if (s.last_comment_style) {
        setCommentStyle(normalizeCommentStyle(s.last_comment_style))
      } else if (chosen) {
        setCommentStyle(normalizeCommentStyle(chosen.config))
      }
      setEncoders(enc)
      setAuthStatus(auth)
      setJobs(q)
      if (upd) setToolUpdateStatus(upd)
      setReady(true)
    } catch (_) {
      setTimeout(loadInitial, 500)
    }
  }, [])

  useEffect(() => {
    loadInitial()
  }, [loadInitial])

  // WebSocket live updates
  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false

    const connect = async () => {
      const base = await resolveApiBase()
      const wsUrl = base.replace(/^http/, 'ws') + '/ws/events'
      if (closed) return
      ws = new WebSocket(wsUrl)
      ws.onopen = () => {
        api.getToolUpdateStatus().then(setToolUpdateStatus).catch(() => {})
      }
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'queue_snapshot') {
            setJobs(msg.payload)
          } else if (msg.type === 'job_updated') {
            const updated: QueueJob = msg.payload
            setJobs((prev) => {
              const idx = prev.findIndex((j) => j.id === updated.id)
              if (idx === -1) return [...prev, updated]
              const copy = [...prev]
              copy[idx] = updated
              return copy
            })
          } else if (msg.type === 'job_removed') {
            setJobs((prev) => prev.filter((j) => j.id !== msg.payload.id))
          } else if (msg.type === 'tool_progress') {
            setToolProgress({ progress: msg.payload.progress, label: msg.payload.label })
          } else if (msg.type === 'tool_update_status') {
            setToolUpdateStatus(msg.payload)
          }
        } catch (_) {}
      }
      ws.onclose = () => {
        if (!closed) setTimeout(connect, 1500)
      }
    }

    connect()
    return () => {
      closed = true
      ws?.close()
    }
  }, [])

  // Electron auth & app update listeners
  useEffect(() => {
    const cleanups: Array<() => void> = []
    if (window.nicotube?.onAuthUpdated) {
      cleanups.push(
        window.nicotube.onAuthUpdated(() => {
          api.getAuthStatus().then(setAuthStatus).catch(() => {})
        })
      )
    }
    if (window.nicotube?.getAppUpdateStatus) {
      window.nicotube.getAppUpdateStatus().then(setAppUpdateState).catch(() => {})
    }
    if (window.nicotube?.onAppUpdateStatus) {
      cleanups.push(window.nicotube.onAppUpdateStatus(setAppUpdateState))
    }
    return () => {
      cleanups.forEach((fn) => fn())
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    if (activeTab === 'settings') {
      api.getToolUpdateStatus().then(setToolUpdateStatus).catch(() => {})
    }
  }, [activeTab, ready])

  useEffect(() => {
    if (!ready) return
    const isBusy =
      Boolean(toolUpdateStatus?.checking) ||
      Boolean(toolUpdateStatus?.ffmpeg_status?.includes('確認中')) ||
      Boolean(toolUpdateStatus?.ytdlp_status?.includes('確認中'))
    if (!isBusy) return
    const timer = setInterval(() => {
      api.getToolUpdateStatus().then(setToolUpdateStatus).catch(() => {})
    }, 1500)
    return () => clearInterval(timer)
  }, [
    ready,
    toolUpdateStatus?.checking,
    toolUpdateStatus?.ffmpeg_status,
    toolUpdateStatus?.ytdlp_status,
  ])

  const persistSettingsPatch = useCallback((patch: Partial<AppSettings>) => {
    const merged: AppSettings = { ...settingsRef.current, ...patch }
    settingsRef.current = merged
    setSettings(merged)
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      api.updateSettings(settingsRef.current).catch(() => {})
    }, 250)
  }, [])

  const handleChangeEncode = useCallback(
    (next: EncodeConfig) => {
      setEncodeConfig(next)
      persistSettingsPatch({ encode_config: next })
    },
    [persistSettingsPatch],
  )

  const handleChangeCommentStyle = useCallback(
    (next: CommentStyleConfig) => {
      setCommentStyle(next)
      persistSettingsPatch({ last_comment_style: next })
    },
    [persistSettingsPatch],
  )

  const handleSelectPreset = async (id: string) => {
    const found = presets.find((p) => p.id === id)
    if (!found) return
    const normalized = normalizeCommentStyle(found.config)
    setActivePresetId(id)
    setCommentStyle(normalized)
    const nextSettings: AppSettings = {
      ...settingsRef.current,
      active_preset_id: id,
      last_comment_style: normalized,
    }
    settingsRef.current = nextSettings
    setSettings(nextSettings)
    api.updateSettings(nextSettings).catch(() => {})
  }

  const handleCreatePreset = async (name: string, description: string, cfg: CommentStyleConfig) => {
    const created = await api.createPreset(name, description, cfg)
    const list = await api.getPresets()
    setPresets(list)
    setActivePresetId(created.id)
    const nextSettings: AppSettings = {
      ...settingsRef.current,
      active_preset_id: created.id,
      last_comment_style: cfg,
    }
    settingsRef.current = nextSettings
    setSettings(nextSettings)
    await api.updateSettings(nextSettings)
  }

  const handleUpdatePreset = async (
    id: string,
    name: string,
    description: string,
    cfg: CommentStyleConfig
  ) => {
    await api.updatePreset(id, name, description, cfg)
    const list = await api.getPresets()
    setPresets(list)
    persistSettingsPatch({ last_comment_style: cfg })
  }

  const handleDeletePreset = async (id: string) => {
    await api.deletePreset(id)
    const list = await api.getPresets()
    setPresets(list)
    if (list[0]) {
      handleSelectPreset(list[0].id)
    }
  }

  const handleUpdateSettings = async (next: AppSettings) => {
    const merged: AppSettings = {
      ...next,
      encode_config: next.encode_config ?? settingsRef.current.encode_config,
      last_comment_style: next.last_comment_style ?? settingsRef.current.last_comment_style,
    }
    settingsRef.current = merged
    const saved = await api.updateSettings(merged)
    settingsRef.current = saved
    setSettings(saved)
  }

  const activeJobCount = jobs.filter(
    (j) =>
      j.status === 'queued' ||
      j.status === 'downloading' ||
      j.status === 'parsing_chat' ||
      j.status === 'rendering'
  ).length

  if (!ready) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-3"
        style={{ backgroundColor: 'var(--md-background)', color: 'var(--md-on-surface-variant)' }}
      >
        <Loader2 size={24} className="animate-spin" style={{ color: 'var(--md-primary)' }} />
        <div className="text-[13px]">バックエンドエンジンを起動中...</div>
      </div>
    )
  }

  return (
    <div className="flex h-full w-full overflow-hidden" style={{ backgroundColor: 'var(--md-background)' }}>
      <NavRail
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        activeJobCount={activeJobCount}
        authStatus={authStatus}
      />

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className={activeTab === 'capture' ? 'block' : 'hidden'}>
          <CaptureWorkspace
            encodeConfig={encodeConfig}
            onChangeEncode={handleChangeEncode}
            presets={presets}
            activePresetId={activePresetId}
            onSelectPreset={handleSelectPreset}
            commentStyle={commentStyle}
            encoders={encoders}
            outputDir={settings.output_dir}
            onOpenCommentStudio={() => setActiveTab('comments')}
            onOpenFullscreenPreview={(thumb) => {
              setPreviewThumb(thumb || null)
              setFullscreenOpen(true)
            }}
            onJobQueued={() => api.getQueue().then(setJobs).catch(() => {})}
            onGoToSettings={() => setActiveTab('settings')}
            onVideoProbed={(info) => setPreviewThumb(info?.thumbnail || null)}
          />
        </div>

        <div className={activeTab === 'comments' ? 'block' : 'hidden'}>
          <CommentStudioView
            styleConfig={commentStyle}
            onChangeStyle={handleChangeCommentStyle}
            presets={presets}
            activePresetId={activePresetId}
            onSelectPreset={handleSelectPreset}
            onCreatePreset={handleCreatePreset}
            onUpdatePreset={handleUpdatePreset}
            onDeletePreset={handleDeletePreset}
            onOpenFullscreenPreview={() => setFullscreenOpen(true)}
            thumbnailUrl={previewThumb}
          />
        </div>

        <div className={activeTab === 'queue' ? 'block' : 'hidden'}>
          <QueueView
            jobs={jobs}
            onRefresh={() => api.getQueue().then(setJobs).catch(() => {})}
          />
        </div>

        <div className={activeTab === 'settings' ? 'block' : 'hidden'}>
          <SettingsAuthView
            settings={settings}
            onUpdateSettings={handleUpdateSettings}
            authStatus={authStatus}
            onRefreshAuth={async () => setAuthStatus(await api.getAuthStatus())}
            encoders={encoders}
            onRefreshEncoders={async (force) => setEncoders(await api.getEncoders(force))}
            toolProgress={toolProgress}
            toolUpdateStatus={toolUpdateStatus}
            onCheckToolUpdates={async () => setToolUpdateStatus(await api.checkToolUpdates())}
            appUpdateState={appUpdateState}
            onCheckAppUpdate={async (feedUrl?: string) => {
              if (window.nicotube?.checkAppUpdate) {
                setAppUpdateState(
                  await window.nicotube.checkAppUpdate(feedUrl ?? settings.update_feed_url),
                )
              }
            }}
            onInstallAppUpdate={async () => {
              await window.nicotube?.installAppUpdate()
            }}
          />
        </div>
      </main>

      <FullscreenPreviewModal
        open={fullscreenOpen}
        onClose={() => setFullscreenOpen(false)}
        styleConfig={commentStyle}
        onChangeStyle={handleChangeCommentStyle}
        thumbnailUrl={previewThumb}
      />
    </div>
  )
}
