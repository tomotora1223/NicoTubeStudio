import type {
  AppSettings,
  AuthStatus,
  CommentStyleConfig,
  EncoderProbeResult,
  JobCreateRequest,
  Preset,
  QueueJob,
  SharedStyleCreate,
  SharedStyleEntry,
  SystemFontInfo,
  ToolUpdateStatus,
  VideoInfoResponse,
} from '../types/studio'

let cachedApiBase = 'http://127.0.0.1:18742'

export async function resolveApiBase(): Promise<string> {
  if (window.nicotube) {
    cachedApiBase = await window.nicotube.getApiBase()
  }
  return cachedApiBase
}

export function getApiBaseSync(): string {
  return cachedApiBase
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await resolveApiBase()
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const data = await res.json()
      if (data?.detail) msg = String(data.detail)
    } catch (_) {}
    throw new Error(msg)
  }
  return (await res.json()) as T
}

export const api = {
  health: () => req<{ status: string }>('/api/health'),
  getSettings: () => req<AppSettings>('/api/settings'),
  updateSettings: (s: AppSettings) =>
    req<AppSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
  getPresets: () => req<Preset[]>('/api/presets'),
  createPreset: (name: string, description: string, config: CommentStyleConfig) =>
    req<Preset>('/api/presets', {
      method: 'POST',
      body: JSON.stringify({ name, description, config }),
    }),
  updatePreset: (id: string, name: string, description: string, config: CommentStyleConfig) =>
    req<Preset>(`/api/presets/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ name, description, config }),
    }),
  deletePreset: (id: string) =>
    req<{ deleted: boolean }>(`/api/presets/${id}`, { method: 'DELETE' }),
  getFonts: () => req<SystemFontInfo[]>('/api/fonts'),
  refreshFonts: () => req<SystemFontInfo[]>('/api/fonts/refresh', { method: 'POST' }),
  getFontFileUrl: (family: string) =>
    `${getApiBaseSync()}/api/fonts/file?family=${encodeURIComponent(family)}`,
  getSharedStyles: () => req<SharedStyleEntry[]>('/api/styles/shared'),
  publishSharedStyle: (payload: SharedStyleCreate) =>
    req<SharedStyleEntry>('/api/styles/shared', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deleteSharedStyle: (id: string) =>
    req<{ deleted: boolean }>(`/api/styles/shared/${id}`, { method: 'DELETE' }),
  importStyleFromUrl: (url: string) =>
    req<SharedStyleCreate>('/api/styles/import-url', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  getEncoders: (refresh = false) =>
    req<EncoderProbeResult>(`/api/encoders?refresh=${refresh ? 'true' : 'false'}`),
  installFfmpeg: () => req<EncoderProbeResult>('/api/tools/install-ffmpeg', { method: 'POST' }),
  getToolUpdateStatus: () => req<ToolUpdateStatus>('/api/updates/status'),
  checkToolUpdates: () => req<ToolUpdateStatus>('/api/updates/check', { method: 'POST' }),
  probeUrl: (url: string) =>
    req<VideoInfoResponse>('/api/probe', { method: 'POST', body: JSON.stringify({ url }) }),
  getAuthStatus: () => req<AuthStatus>('/api/auth/status'),
  uploadCookiesFile: (file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return req<AuthStatus>('/api/auth/upload-cookies', { method: 'POST', body: fd })
  },
  clearAuthCookies: () => req<AuthStatus>('/api/auth/cookies', { method: 'DELETE' }),
  clearEmoteCache: () => req<{ cleared: number }>('/api/cache/emotes', { method: 'DELETE' }),
  getQueue: () => req<QueueJob[]>('/api/queue'),
  enqueueJob: (payload: JobCreateRequest) =>
    req<QueueJob>('/api/queue', { method: 'POST', body: JSON.stringify(payload) }),
  cancelJob: (id: string) => req<QueueJob>(`/api/queue/${id}/cancel`, { method: 'POST' }),
  retryJob: (id: string) => req<QueueJob>(`/api/queue/${id}/retry`, { method: 'POST' }),
  deleteJob: (id: string) => req<{ deleted: boolean }>(`/api/queue/${id}`, { method: 'DELETE' }),
  clearQueue: () => req<{ cleared: boolean }>('/api/queue/clear', { method: 'POST' }),
}

export async function loadDynamicFontFace(family: string): Promise<void> {
  const trimmed = family.trim()
  if (!trimmed || typeof FontFace === 'undefined') return
  const key = trimmed.toLowerCase()
  if (loadedFontFamilies.has(key)) return
  try {
    const base = await resolveApiBase()
    const url = `${base}/api/fonts/file?family=${encodeURIComponent(trimmed)}`
    const ff = new FontFace(trimmed, `url("${url}")`)
    const loaded = await ff.load()
    document.fonts.add(loaded)
    loadedFontFamilies.add(key)
  } catch (_) {}
}

const loadedFontFamilies = new Set<string>()

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}

export function parseTimecode(tc: string): number | null {
  const trimmed = tc.trim()
  if (!trimmed) return null
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  const parts = trimmed.split(':').map((p) => Number(p))
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return null
}
