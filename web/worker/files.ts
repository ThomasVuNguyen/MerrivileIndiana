// Files attached to chat messages: what kind they are, how big they may be, and
// how they become blocks the model can read.

import type { Attachment, FileKind } from '../shared/protocol'
import type { Env } from './env'
import { fileFetch } from './geometry'
import type { Block, HistoryItem } from './llm'

/** Anything up to 5 GB can be stored; what the AI can open is smaller. */
export const MAX_UPLOAD = 5 * 1024 ** 3
/** Single uploads stream through the Worker; bigger files come in multipart chunks. */
export const SINGLE_UPLOAD = 95 * 1024 ** 2
const MODEL_PDF = 25 * 1024 ** 2
export const MODEL_STEP = 45 * 1024 ** 2
const TEXT_BYTES = 200_000
const TEXT_CHARS = 100_000

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  json: 'application/json',
  log: 'text/plain',
  step: 'model/step',
  stp: 'model/step',
}
const VIDEOS: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', '3gp': 'video/3gpp', mpg: 'video/mpeg', mpeg: 'video/mpeg', ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t', ogv: 'video/ogg',
}
export const isVideoName = (name = '') => (name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '') in VIDEOS
// Read through the geometry container (pandas, python-docx…) and kept next to the original as text.
const SHEETS: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  xls: 'application/vnd.ms-excel',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  numbers: 'application/vnd.apple.numbers',
}
const DOCS: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
}
const IMAGES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif' }

/** Kind and content type from the browser's type and the file name. Anything else is a plain file. */
export function kindOf(name: string, type: string): { kind: FileKind; type: string; ext: string } {
  const ext = name.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1] ?? 'bin'
  if (IMAGES[ext] || type.startsWith('image/')) return { kind: 'image', type: IMAGES[ext] ?? type, ext: IMAGES[ext] ? ext : (type.split('/')[1] ?? 'img').replace(/[^a-z0-9]/g, '') }
  if (VIDEOS[ext] || type.startsWith('video/')) return { kind: 'video', type: VIDEOS[ext] ?? type, ext: VIDEOS[ext] ? ext : (type.split('/')[1] ?? 'video').replace(/[^a-z0-9]/g, '') }
  if (SHEETS[ext]) return { kind: 'sheet', type: SHEETS[ext], ext }
  if (DOCS[ext]) return { kind: 'doc', type: DOCS[ext], ext }
  if (ext === 'pdf' || type === 'application/pdf') return { kind: 'pdf', type: TYPES.pdf, ext: 'pdf' }
  if (ext === 'step' || ext === 'stp') return { kind: 'step', type: TYPES.step, ext }
  if (TYPES[ext]) return { kind: 'text', type: `${TYPES[ext]}; charset=utf-8`, ext }
  return { kind: 'file', type: type || 'application/octet-stream', ext }
}

/** 75 → "1:15". */
export function clock(seconds?: number) {
  const t = Math.round(seconds ?? 0)
  return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

// Files stored before a kind existed (an .xlsx was a plain "file") are read by their name now.
export const kind = (a: Attachment): FileKind => (a.kind === 'file' ? kindOf(a.name ?? a.key, '').kind : (a.kind ?? 'image'))

/** The image the AI and the page use: the preview, or the original when it is already web-friendly and small. */
export function imageKey(a: Attachment) {
  if (a.previewKey) return a.previewKey
  if (kind(a) !== 'image') return null
  return !/\.(heic|heif)$/i.test(a.key) && (a.size ?? 0) <= 5 * 1024 ** 2 ? a.key : null
}

export function sizeLabel(bytes?: number) {
  if (!bytes) return ''
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

/** One line per attachment so the model can refer to them by number. */
export function labels(attachments: Attachment[]) {
  return attachments.map((a, i) => {
    const n = i + 1
    const k = kind(a)
    if (k === 'image') return imageKey(a) ? `[Attachment ${n}: image, ${a.width}×${a.height} px]` : `[Attachment ${n}: image "${a.name}" with no preview yet]`
    if (k === 'video') return a.framesKey ? `[Attachment ${n}: video "${a.name}", ${clock(a.duration)}; you see six frames across it in one picture, each marked with its time]` : `[Attachment ${n}: video "${a.name}", ${sizeLabel(a.size)}, with no frames to look at yet]`
    if (k === 'pdf') return `[Attachment ${n}: PDF "${a.name}", ${sizeLabel(a.size)}${(a.size ?? 0) > MODEL_PDF ? ', too large for you to read; ask for the pages that matter' : ''}]`
    if (k === 'step') return `[Attachment ${n}: STEP "${a.name}", ${sizeLabel(a.size)}]`
    if (k === 'text') return `[Attachment ${n}: text file "${a.name}", shown below]`
    if (k === 'sheet') return `[Attachment ${n}: spreadsheet "${a.name}", every sheet shown below as CSV; use run_python for anything bigger or messier]`
    if (k === 'doc') return `[Attachment ${n}: document "${a.name}", its text and tables shown below]`
    return `[Attachment ${n}: file "${a.name}", ${sizeLabel(a.size)}; stored, but not something you can open]`
  })
}

/**
 * Blocks for the history: images and PDFs by key (hydrated later), text files
 * inline. STEP files are handled by the caller (imported as parts in a project).
 */
export async function attachmentBlocks(env: Env, attachments: Attachment[], vision: boolean): Promise<Block[]> {
  const out: Block[] = []
  for (const [i, a] of attachments.entries()) {
    const k = kind(a)
    if (k === 'image') {
      const key = imageKey(a)
      if (key) out.push({ type: 'image', mediaType: (await env.FILES.head(key))?.httpMetadata?.contentType ?? 'image/jpeg', key })
    } else if (k === 'video' && a.framesKey) {
      out.push({ type: 'image', mediaType: 'image/jpeg', key: a.framesKey })
    } else if (k === 'pdf' && (a.size ?? 0) <= MODEL_PDF) {
      if (vision) out.push({ type: 'document', mediaType: 'application/pdf', name: a.name ?? 'file.pdf', key: a.key })
      else out.push({ type: 'text', text: `[Attachment ${i + 1} is a PDF this model can't read. Ask for the relevant numbers as text.]` })
    } else if (k === 'text') {
      out.push({ type: 'text', text: `--- Attachment ${i + 1}: ${a.name} ---\n${await readText(env, a.key)}\n--- end of ${a.name} ---` })
    } else if (k === 'sheet' || k === 'doc') {
      out.push({ type: 'text', text: `--- Attachment ${i + 1}: ${a.name} ---\n${await officeText(env, a.key)}\n--- end of ${a.name} ---` })
    }
  }
  return out
}

/** The start of a text file: big logs are read only up to their first 200 KB. */
export async function readText(env: Env, key: string) {
  const obj = await env.FILES.get(key, { range: { offset: 0, length: TEXT_BYTES } })
  if (!obj) return '(the file is missing)'
  let text = await obj.text()
  const more = obj.size > TEXT_BYTES || text.length > TEXT_CHARS
  if (text.length > TEXT_CHARS) text = text.slice(0, TEXT_CHARS)
  return more ? `${text}\n… [the rest of the file, ${sizeLabel(obj.size)} in all, is not shown]` : text
}

/**
 * A spreadsheet or document as text: each sheet as CSV, or the text and tables. Converted once
 * and stored next to the original; the AI reads the first 200 KB like any text file.
 */
export async function officeText(env: Env, key: string): Promise<string> {
  const textKey = `${key}.text.txt`
  if (!(await env.FILES.head(textKey))) {
    const obj = await env.FILES.get(key)
    if (!obj) return '(the file is missing)'
    if (obj.size > 60 * 1024 ** 2) return `(too large to convert here, ${sizeLabel(obj.size)}; use run_python on it)`
    const res = await fileFetch(env, 'geometry', '/convert', obj, key.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '')
    const out = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string; error?: string }
    if (!out.ok || out.text === undefined) return `(couldn't read this file: ${out.error ?? `error ${res.status}`})`
    await env.FILES.put(textKey, out.text, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } })
  }
  return readText(env, textKey)
}

/** Loads the data for blocks stored by key, once per run. */
export function hydrator(env: Env) {
  const cache = new Map<string, string>()
  const load = async (key: string) => {
    let data = cache.get(key)
    if (data === undefined) {
      const obj = await env.FILES.get(key)
      data = obj ? toBase64(new Uint8Array(await obj.arrayBuffer())) : ''
      cache.set(key, data)
    }
    return data
  }
  const block = async (b: Block): Promise<Block> => {
    if ((b.type === 'image' || b.type === 'document') && !b.data && b.key) {
      const data = await load(b.key)
      return data ? { ...b, data } : { type: 'text', text: `[${b.type === 'image' ? 'An image' : `"${b.name}"`} that is no longer stored]` }
    }
    return b
  }
  return async (items: HistoryItem[]): Promise<HistoryItem[]> =>
    Promise.all(
      items.map(async (item) =>
        item.role === 'tool'
          ? { ...item, results: await Promise.all(item.results.map(async (r) => ({ ...r, content: await Promise.all(r.content.map(block)) }))) }
          : { ...item, content: await Promise.all(item.content.map(block)) },
      ),
    ) as Promise<HistoryItem[]>
}

export function toBase64(data: Uint8Array) {
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(bin)
}
