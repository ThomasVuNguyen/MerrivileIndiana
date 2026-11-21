import type { Attachment, FileKind } from '../shared/protocol'

export const MAX_BYTES = 5 * 1024 ** 3
// Up to this size a file goes in one request; above it, in parts (R2 multipart).
const SINGLE = 90 * 1024 ** 2
const PART = 50 * 1024 ** 2
// How many files, and how many parts of one big file, go up at once.
export const FILES_AT_ONCE = 4
const PARTS_AT_ONCE = 3
// Claude reads images up to ~1568 px on the long edge; the preview is that size.
const PREVIEW_EDGE = 1568

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', '3gp', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'ogv']

/** What the app does with a file, from its type and name. Anything unknown is just stored. */
export function kindOf(file: File): FileKind {
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  if (file.type.startsWith('image/') || ['heic', 'heif', 'jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return 'image'
  if (file.type.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video'
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf'
  if (ext === 'step' || ext === 'stp') return 'step'
  if (['txt', 'csv', 'tsv', 'md', 'json', 'log'].includes(ext)) return 'text'
  return 'file'
}

/**
 * Uploads a file of up to 5 GB. Photos keep their original (HEIC included) and
 * get a JPEG preview for the page and the AI. `onProgress` gets 0–1.
 */
export async function uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<Attachment> {
  if (file.size > MAX_BYTES) throw new Error(`${file.name} is over 5 GB.`)
  if (!file.size) throw new Error(`${file.name} is empty.`)
  const kind = kindOf(file)
  const name = file.name || 'image'
  const progress = (f: number) => onProgress?.(kind === 'image' || kind === 'video' ? f * 0.9 : f)
  const original = file.size <= SINGLE ? await putSingle(file, name, progress) : await putMultipart(file, name, progress)
  const out: Attachment = { key: original.key, url: original.url, kind, name, size: file.size }
  if (kind === 'image') Object.assign(out, await preview(file, name, original.key))
  if (kind === 'video') Object.assign(out, await videoPreview(file, name, original.key))
  onProgress?.(1)
  return out
}

async function preview(file: File, name: string, key: string): Promise<Partial<Attachment>> {
  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    // HEIC in Chrome and other formats the browser can't decode: the server converts.
  }
  if (!bitmap) {
    const res = await fetch('/api/uploads/preview', { method: 'POST', body: JSON.stringify({ key }) })
    const body = (await res.json()) as { previewKey?: string; previewUrl?: string; width?: number; height?: number; error?: string }
    if (!res.ok || !body.previewKey) return {}
    return { previewKey: body.previewKey, previewUrl: body.previewUrl, width: body.width, height: body.height }
  }
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, width, height)
  g.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const blob = await jpeg(canvas)
  const up = await send<{ key: string; url: string }>('POST', '/api/uploads', blob, { 'content-type': 'image/jpeg', 'x-filename': encodeURIComponent(name), 'x-preview-of': key })
  return { previewKey: up.key, previewUrl: up.url, width, height }
}

/**
 * A video's poster (for the page) and a 3×2 sheet of frames with their times (for the AI).
 * The browser makes them when it can play the file; otherwise the server does, with ffmpeg.
 */
async function videoPreview(file: File, name: string, key: string): Promise<Partial<Attachment>> {
  const local = await framesInBrowser(file).catch(() => null)
  if (!local) {
    const res = await fetch('/api/uploads/video', { method: 'POST', body: JSON.stringify({ key }) })
    const body = (await res.json().catch(() => ({}))) as Partial<Attachment> & { error?: string }
    return res.ok ? body : { problem: body.error ?? "Couldn't read this video." }
  }
  const put = (blob: Blob, as: string) =>
    send<{ key: string; url: string }>('POST', '/api/uploads', blob, { 'content-type': 'image/jpeg', 'x-filename': encodeURIComponent(name), 'x-preview-of': key, 'x-preview-as': as })
  const [poster, frames] = await Promise.all([put(local.poster, 'preview'), put(local.sheet, 'frames')])
  // Playing here isn't playing everywhere: only MP4, MOV and WebM go without a converted copy.
  const needsCopy = !['mp4', 'm4v', 'mov', 'webm'].includes(name.toLowerCase().split('.').pop() ?? '')
  return { previewKey: poster.key, previewUrl: poster.url, framesKey: frames.key, width: local.width, height: local.height, duration: local.duration, needsCopy }
}

async function framesInBrowser(file: File) {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  const src = URL.createObjectURL(file)
  const wait = (event: string) =>
    new Promise<void>((resolve, reject) => {
      const t = window.setTimeout(() => reject(new Error('timed out')), 20_000)
      video.addEventListener(event, () => (window.clearTimeout(t), resolve()), { once: true })
      video.addEventListener('error', () => (window.clearTimeout(t), reject(new Error("can't play"))), { once: true })
    })
  const at = async (t: number) => {
    video.currentTime = t
    await wait('seeked')
  }
  try {
    video.src = src
    await wait('loadeddata')
    // Audio-only or a codec this browser can't decode: no picture.
    if (!video.videoWidth) throw new Error('no picture')
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    await at(Math.min(1, duration * 0.1))
    const scale = Math.min(1, PREVIEW_EDGE / Math.max(video.videoWidth, video.videoHeight))
    const poster = canvasOf(Math.round(video.videoWidth * scale), Math.round(video.videoHeight * scale))
    poster.g.drawImage(video, 0, 0, poster.c.width, poster.c.height)
    const cell = Math.min(1, 512 / Math.max(video.videoWidth, video.videoHeight))
    const cw = Math.round(video.videoWidth * cell)
    const ch = Math.round(video.videoHeight * cell)
    const times = duration > 0 ? [0, 1, 2, 3, 4, 5].map((i) => (duration * (i + 0.5)) / 6) : [0]
    const cols = Math.min(3, times.length)
    const sheet = canvasOf(cols * cw, Math.ceil(times.length / cols) * ch)
    sheet.g.font = '22px ui-monospace, monospace'
    sheet.g.textBaseline = 'top'
    for (const [i, t] of times.entries()) {
      await at(t)
      const x = (i % cols) * cw
      const y = Math.floor(i / cols) * ch
      sheet.g.drawImage(video, x, y, cw, ch)
      const label = clock(t)
      sheet.g.fillStyle = '#000'
      sheet.g.fillRect(x + 4, y + 4, sheet.g.measureText(label).width + 8, 28)
      sheet.g.fillStyle = '#fff'
      sheet.g.fillText(label, x + 8, y + 7)
    }
    return { poster: await jpeg(poster.c), sheet: await jpeg(sheet.c), width: poster.c.width, height: poster.c.height, duration: Math.round(duration * 100) / 100 }
  } finally {
    URL.revokeObjectURL(src)
    video.removeAttribute('src')
    video.load()
  }
}

function canvasOf(width: number, height: number) {
  const c = document.createElement('canvas')
  c.width = width
  c.height = height
  const g = c.getContext('2d')!
  g.fillStyle = '#fff'
  g.fillRect(0, 0, width, height)
  return { c, g }
}

const jpeg = (c: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not make a preview'))), 'image/jpeg', 0.86))

/** 75 → "1:15". */
export function clock(seconds?: number) {
  const t = Math.round(seconds ?? 0)
  const mm = String(Math.floor(t / 60) % 60)
  const ss = String(t % 60).padStart(2, '0')
  return t >= 3600 ? `${Math.floor(t / 3600)}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

function putSingle(file: Blob, name: string, onProgress: (f: number) => void) {
  return send<{ key: string; url: string }>('POST', '/api/uploads', file, { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, (sent) => onProgress(sent / file.size))
}

async function putMultipart(file: File, name: string, onProgress: (f: number) => void) {
  const start = await json<{ key: string; uploadId: string }>('/api/uploads/multipart', { name, type: file.type, size: file.size })
  const sent = new Array<number>(Math.ceil(file.size / PART)).fill(0)
  try {
    const parts = await pool(sent, PARTS_AT_ONCE, (_, n) => {
      const chunk = file.slice(n * PART, Math.min(file.size, (n + 1) * PART))
      const q = new URLSearchParams({ key: start.key, uploadId: start.uploadId, part: String(n + 1) })
      return send<{ partNumber: number; etag: string }>('PUT', `/api/uploads/multipart/part?${q}`, chunk, { 'content-type': 'application/octet-stream' }, (bytes) => {
        sent[n] = bytes
        onProgress(sent.reduce((a, b) => a + b, 0) / file.size)
      })
    })
    return await json<{ key: string; url: string }>('/api/uploads/multipart/complete', { key: start.key, uploadId: start.uploadId, parts })
  } catch (err) {
    await json('/api/uploads/multipart/abort', { key: start.key, uploadId: start.uploadId }).catch(() => {})
    throw err
  }
}

/** Runs `fn` over `items` with at most `limit` running at once. Results keep the input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

async function json<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(body) })
  const out = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(out.error ?? `Upload failed (${res.status})`)
  return out
}

// XMLHttpRequest, because fetch can't report upload progress.
function send<T>(method: string, url: string, body: Blob, headers: Record<string, string>, onSent?: (bytes: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method, url)
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => onSent?.(e.loaded)
    xhr.onload = () => {
      let out: T & { error?: string }
      try {
        out = JSON.parse(xhr.responseText)
      } catch {
        return reject(new Error(`Upload failed (${xhr.status})`))
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(out)
      else reject(new Error(out.error ?? `Upload failed (${xhr.status})`))
    }
    xhr.onerror = () => reject(new Error('Upload failed: network error'))
    xhr.send(body)
  })
}

/** Files from a paste or drop, in order. */
export function filesFrom(data: DataTransfer | null): File[] {
  return data ? [...data.files] : []
}

export function sizeLabel(bytes?: number) {
  if (!bytes) return ''
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** The picture to show for an attachment: its preview when it has one. */
export const shownUrl = (a: Attachment) => a.previewUrl ?? a.url

/** Shown as a picture: photos, and videos once they have a poster. */
export const pictured = (a: Attachment) => (a.kind ?? 'image') === 'image' || (a.kind === 'video' && !!a.previewUrl)
