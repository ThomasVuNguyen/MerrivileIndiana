import type { Attachment, ModelInfo, NewModel, ProjectInfo } from '../shared/protocol'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`)
  return body as T
}

const post = (body?: unknown): RequestInit => ({ method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export type User = { id: string; email: string }

export const api = {
  me: () => call<User>('/api/auth/me'),
  signUp: (email: string, password: string) => call<User>('/api/auth/signup', post({ email, password })),
  signIn: (email: string, password: string) => call<User>('/api/auth/signin', post({ email, password })),
  signOut: () => call<{ ok: true }>('/api/auth/signout', post()),
  models: () => call<ModelInfo[]>('/api/models'),
  addModel: (m: NewModel) => call<ModelInfo>('/api/models', post(m)),
  removeModel: (id: string) => call<{ ok: true }>(`/api/models/${id}`, { method: 'DELETE' }),
  setDefault: (id: string) => call<{ ok: true }>(`/api/models/${id}/default`, post()),
  testModel: (id: string) => call<{ ok: true; name: string; ms: number } | { ok: false; error: string }>(`/api/models/${id}/test`, post()),
  projects: () => call<ProjectInfo[]>('/api/projects'),
  createProject: (name: string) => call<ProjectInfo>('/api/projects', post({ name })),
  importStep: (projectId: string, file: File) =>
    call<{ ok: true }>(`/api/projects/${projectId}/import`, { method: 'POST', body: file, headers: { 'x-filename': encodeURIComponent(file.name) } }),
}

export const socketUrl = (projectId: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/projects/${projectId}/socket`

/** A prompt typed on the projects page, sent once the new project's socket opens. */
export const pendingPrompt = {
  set: (projectId: string, prompt: { text: string; images: Attachment[] }) => sessionStorage.setItem(`merrivile:prompt:${projectId}`, JSON.stringify(prompt)),
  take: (projectId: string): { text: string; images: Attachment[] } | null => {
    const key = `merrivile:prompt:${projectId}`
    const raw = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    try {
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  },
}
