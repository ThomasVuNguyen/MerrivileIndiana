// Components: bought parts from vendor STEP files (a Raspberry Pi, a camera board, a lens) in an
// account-wide library, placed in assemblies next to the project's own parts. The geometry service
// reads the STEP once into a BREP (fast to load), a viewer mesh, renders and suggested datums; the
// files live in R2 under users/<uid>/components/<id>/ and the record in the Account object.
//
// Geometry calls name components by the hash of their BREP. The service keeps BREPs it has seen;
// when it lacks one it answers {need: [hash]}, geometryJson uploads it from R2 and asks again.

import { z } from 'zod'
import type { Attachment, ComponentDoc, Datum, KeepOut, LibraryItem, PartMetrics, SuggestedDatum, Vec3 } from '../shared/protocol'
import type { Env } from './env'
import { fileFetch, geometryFetch } from './geometry'
import type { Block } from './llm'

/** Biggest STEP one request carries (start_upload, import_component). */
export const MAX_COMPONENT = 95 * 1024 ** 2

/** What a geometry call needs for component("id"), and what assemblies need to place and check it. */
export type ComponentRef = {
  id: string
  name: string
  hash: string
  key: string
  mesh: string
  names: string[]
  datums: Record<string, Datum>
  keepouts: KeepOut[]
  /** For guides (where its centre is) and the bill of materials. */
  outline?: { min: Vec3; max: Vec3 }
  vendor?: string
  partNumber?: string
  link?: string
}

/** The Account object's component methods (RPC). */
export interface ComponentApi {
  listComponents(): ComponentDoc[] | Promise<ComponentDoc[]>
  component(id: string): ComponentDoc | null | Promise<ComponentDoc | null>
  saveComponent(doc: ComponentDoc, names?: string[]): ComponentDoc | Promise<ComponentDoc>
}

export const componentDir = (uid: string, id: string) => `users/${uid}/components/${id}`
const keyOf = (url: string) => url.replace(/^\/api\/files\//, '')

// ---------------------------------------------------------------- validation

const V3 = z.tuple([z.number(), z.number(), z.number()])
const Dir = V3.refine((v) => Math.hypot(...v) > 1e-9, 'a direction must not be zero')
export const DatumSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plane'), origin: V3, normal: Dir, x: Dir }),
  z.object({ kind: z.literal('axis'), origin: V3, direction: Dir }),
  z.object({ kind: z.literal('point'), at: V3 }),
  z.object({ kind: z.literal('pattern'), points: z.array(V3).min(2).max(200), normal: Dir, diameter: z.number().positive().optional() }),
])
export const KeepOutSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('box'), label: z.string().min(1).max(80), min: V3, max: V3 }),
  z.object({ kind: z.literal('cylinder'), label: z.string().min(1).max(80), origin: V3, direction: Dir, radius: z.number().positive(), length: z.number().positive() }),
  z.object({ kind: z.literal('cone'), label: z.string().min(1).max(80), origin: V3, direction: Dir, angle: z.number().gt(0).lt(89), length: z.number().positive(), radius: z.number().min(0).optional() }),
])
export const DatumName = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,59}$/, 'datum names: letters, digits, _ - . (no slashes)')
export const ComponentId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/)

export const ComponentDetails = z.object({
  name: z.string().min(1).max(80).optional(),
  vendor: z.string().max(80).optional(),
  part_number: z.string().max(80).optional(),
  link: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
})

export const SetComponentDatums = ComponentDetails.extend({
  component: ComponentId,
  datums: z.record(DatumName, DatumSchema.nullable()).optional(),
  replace_datums: z.boolean().optional(),
  keepouts: z.array(KeepOutSchema).max(40).optional(),
  outline: z.object({ min: V3, max: V3 }).optional(),
})

// ---------------------------------------------------------------- geometry calls

/** POST JSON to the geometry service with components; uploads BREPs it doesn't have yet, then asks again. */
export async function geometryJson<T>(env: Env, path: string, body: Record<string, unknown>, refs: ComponentRef[], signal?: AbortSignal): Promise<T> {
  const text = JSON.stringify({ ...body, components: Object.fromEntries(refs.map((r) => [r.id, { hash: r.hash, names: r.names }])) })
  for (let attempt = 0; ; attempt++) {
    const res = await geometryFetch(env, path, { method: 'POST', body: text, signal })
    if (!res.ok) throw new Error(`geometry service answered HTTP ${res.status}`)
    const out = (await res.json()) as T & { need?: string[] }
    if (!out.need?.length) return out
    if (attempt >= 2) throw new Error('the geometry service keeps losing component shapes; try again')
    for (const h of out.need) {
      const ref = refs.find((r) => r.hash === h)
      const obj = ref ? await env.FILES.get(ref.key) : null
      if (!ref || !obj) throw new Error(`the shape of component ${ref?.id ?? h} is missing from storage`)
      const up = await fileFetch(env, 'geometry', `/cache/${h}`, obj, 'brep')
      if (!up.ok) throw new Error(`sending component ${ref.id} to the geometry service failed (HTTP ${up.status})`)
    }
  }
}

/** Stream a file the geometry service made (GET /cache/<name>) into R2. */
export async function keepOutput(env: Env, name: string, key: string, contentType: string, disposition?: string) {
  const res = await geometryFetch(env, `/cache/${name}`, { method: 'GET', body: '' })
  if (!res.ok || !res.body) throw new Error(`the geometry service lost ${name} (HTTP ${res.status})`)
  const length = Number(res.headers.get('content-length') ?? 0)
  const meta = { httpMetadata: { contentType, ...(disposition && { contentDisposition: disposition }) } }
  if (!length) return env.FILES.put(key, await res.arrayBuffer(), meta)
  const { readable, writable } = new FixedLengthStream(length)
  res.body.pipeTo(writable).catch(() => {})
  return env.FILES.put(key, readable, meta)
}

/** Components the code names with component("id"), as geometry refs; unknown ids are left for the script to report. */
export function componentsIn(code: string): string[] {
  return [...new Set([...code.matchAll(/\bcomponent\(\s*["']([a-z0-9][a-z0-9-]{0,40})["']\s*\)/g)].map((m) => m[1]))]
}

export function refOf(doc: ComponentDoc, names: string[] = []): ComponentRef {
  return {
    id: doc.id,
    name: doc.name,
    hash: doc.hash,
    key: keyOf(doc.files.brep),
    mesh: doc.files.mesh,
    names,
    datums: doc.datums,
    keepouts: doc.keepouts,
    outline: doc.outline,
    ...(doc.vendor && { vendor: doc.vendor }),
    ...(doc.partNumber && { partNumber: doc.partNumber }),
    ...(doc.link && { link: doc.link }),
  }
}

// ---------------------------------------------------------------- import

type Imported = {
  ok: true
  hash: string
  brep_bytes: number
  mesh: string
  names: string[]
  metrics: PartMetrics
  suggested: Record<string, SuggestedDatum>
  holes: ComponentDoc['holes']
  outline: { min: Vec3; max: Vec3 }
  warnings: string[]
  render: string
  thumb: string
  ms: number
}

export type ImportSource =
  | { via: 'url' | 'text' | 'upload'; name: string; data: Uint8Array; url?: string }
  | { via: 'library' | 'upload'; name: string; key: string; libraryId?: string }

export type ImportMeta = { id?: string; name?: string; vendor?: string; partNumber?: string; link?: string; notes?: string }

/** A STEP becomes a component: stored, read by the geometry service, and saved in the account's library. */
export async function importComponent(
  env: Env,
  uid: string,
  api: ComponentApi,
  src: ImportSource,
  meta: ImportMeta,
): Promise<{ ok: true; doc: ComponentDoc; render: string; warnings: string[]; ms: number } | { ok: false; why: string }> {
  const stem = src.name.replace(/\.(step|stp)$/i, '').slice(0, 80) || 'component'
  const taken = new Set((await api.listComponents()).map((c) => c.id))
  let id = meta.id ?? (meta.name ?? stem).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36)
  if (!id) id = 'component'
  if (meta.id && taken.has(meta.id)) return { ok: false, why: `there's already a component "${meta.id}"; components never change, so import a new revision under a new id` }
  for (let n = 2, base = id; taken.has(id); n++) id = `${base}-${n}`
  const dir = componentDir(uid, id)
  const ext = /\.stp$/i.test(src.name) ? 'stp' : 'step'
  const stepKey = `${dir}/original.${ext}`
  const disposition = `attachment; filename="${src.name.replace(/["\\\r\n]/g, '')}"`
  if ('data' in src) {
    if (src.data.length > MAX_COMPONENT) return { ok: false, why: 'STEP files up to 95 MB' }
    await env.FILES.put(stepKey, src.data, { httpMetadata: { contentType: 'model/step', contentDisposition: disposition } })
  } else {
    const obj = await env.FILES.get(src.key)
    if (!obj) return { ok: false, why: 'the file is no longer stored' }
    const { readable, writable } = new FixedLengthStream(obj.size)
    obj.body.pipeTo(writable).catch(() => {})
    await env.FILES.put(stepKey, readable, { httpMetadata: { contentType: 'model/step', contentDisposition: disposition } })
  }
  const stored = await env.FILES.get(stepKey)
  if (!stored) return { ok: false, why: 'storing the file failed' }
  const head = new TextDecoder().decode(await (await env.FILES.get(stepKey, { range: { offset: 0, length: 200 } }))!.arrayBuffer())
  if (!head.includes('ISO-10303')) {
    await env.FILES.delete(stepKey)
    return { ok: false, why: `that isn't a STEP file (it starts with "${head.slice(0, 60).replace(/\s+/g, ' ')}")` }
  }
  const res = await fileFetch(env, 'geometry', '/component', stored, ext)
  const out = (await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status}` } }))) as Imported | { ok: false; error: { type?: string; message: string } }
  if (!out.ok) {
    await env.FILES.delete(stepKey)
    return { ok: false, why: `the geometry service couldn't read it: ${out.error.message}` }
  }
  await Promise.all([
    keepOutput(env, `${out.hash}.brep`, `${dir}/shape.brep`, 'application/octet-stream'),
    keepOutput(env, out.mesh, `${dir}/mesh.json`, 'application/json'),
    env.FILES.put(`${dir}/render.png`, bytes(out.render), { httpMetadata: { contentType: 'image/png' } }),
    env.FILES.put(`${dir}/thumb.png`, bytes(out.thumb), { httpMetadata: { contentType: 'image/png' } }),
  ])
  const url = (name: string) => `/api/files/${dir}/${name}`
  const now = Date.now()
  const datums: Record<string, Datum> = {}
  for (const [k, v] of Object.entries(out.suggested)) {
    const { note: _note, ...d } = v
    datums[k] = d as Datum
  }
  const doc: ComponentDoc = {
    id,
    name: meta.name ?? stem,
    ...(meta.vendor && { vendor: meta.vendor }),
    ...(meta.partNumber && { partNumber: meta.partNumber }),
    ...((meta.link ?? ('url' in src ? src.url : undefined)) && { link: meta.link ?? (src as { url: string }).url }),
    ...(meta.notes && { notes: meta.notes }),
    source: { kind: src.via, name: src.name, ...('url' in src && src.url && { url: src.url }), ...('libraryId' in src && src.libraryId && { libraryId: src.libraryId }) },
    hash: out.hash,
    metrics: out.metrics,
    datums,
    suggested: out.suggested,
    holes: out.holes,
    outline: out.outline,
    keepouts: [],
    files: { step: url(`original.${ext}`), brep: url('shape.brep'), mesh: url('mesh.json'), render: url('render.png'), thumb: url('thumb.png') },
    createdAt: now,
    updatedAt: now,
  }
  return { ok: true, doc: await api.saveComponent(doc, out.names), render: out.render, warnings: out.warnings, ms: out.ms }
}

// ---------------------------------------------------------------- text for the AI

const r3 = (v: number[]) => `[${v.map((x) => +x.toFixed(3)).join(', ')}]`

export function datumLine(name: string, d: Datum, note?: string) {
  const extra = note ? ` · ${note}` : ''
  if (d.kind === 'plane') return `${name}: plane at ${r3(d.origin)}, normal ${r3(d.normal)}, x ${r3(d.x)}${extra}`
  if (d.kind === 'axis') return `${name}: axis through ${r3(d.origin)}, direction ${r3(d.direction)}${extra}`
  if (d.kind === 'point') return `${name}: point ${r3(d.at)}${extra}`
  const pts = d.points.length <= 8 ? d.points.map(r3).join(' ') : `${d.points.slice(0, 6).map(r3).join(' ')} … (${d.points.length} points)`
  return `${name}: pattern of ${d.points.length}${d.diameter ? ` Ø${d.diameter}` : ''}, normal ${r3(d.normal)}: ${pts}${extra}`
}

export function keepoutLine(k: KeepOut) {
  if (k.kind === 'box') return `"${k.label}": box ${r3(k.min)} to ${r3(k.max)}`
  if (k.kind === 'cylinder') return `"${k.label}": cylinder r ${k.radius} × ${k.length} from ${r3(k.origin)} along ${r3(k.direction)}`
  return `"${k.label}": cone ${k.angle}° half-angle × ${k.length} from ${r3(k.origin)} along ${r3(k.direction)}${k.radius ? `, r ${k.radius} at the start` : ''}`
}

/** A component for list_components (short) or read_component (everything). */
export function describeComponent(c: ComponentDoc, full = false) {
  const m = c.metrics
  const size = m.bbox.size.map((x) => +x.toFixed(2)).join(' × ')
  const lines = [
    `${c.id} "${c.name}"${c.vendor ? ` · ${c.vendor}` : ''}${c.partNumber ? ` ${c.partNumber}` : ''} · ${m.solids} solid${m.solids === 1 ? '' : 's'}, ${m.faces} faces · ${size} mm (min ${r3(m.bbox.min)}, max ${r3(m.bbox.max)}) in its own frame`,
  ]
  const names = Object.keys(c.datums)
  if (!full) {
    lines.push(`datums: ${names.join(', ') || 'none'}${c.keepouts.length ? ` · keep-outs: ${c.keepouts.map((k) => `"${k.label}"`).join(', ')}` : ''}`)
    return lines.join('\n')
  }
  if (c.link) lines.push(`link: ${c.link}`)
  if (c.notes) lines.push(`notes: ${c.notes}`)
  lines.push(`source: ${c.source.kind} ${c.source.name}${c.source.url ? ` (${c.source.url})` : ''}`)
  lines.push(`datums (snap to these as "<instance>.<name>"):`, ...(names.length ? names.map((n) => `- ${datumLine(n, c.datums[n], c.suggested[n] && sameDatum(c.suggested[n], c.datums[n]) ? `found on import: ${c.suggested[n].note}` : undefined)}`) : ['- none; set them with set_component_datums']))
  const unused = Object.keys(c.suggested).filter((n) => !c.datums[n])
  if (unused.length) lines.push('suggested on import, not in datums:', ...unused.map((n) => `- ${datumLine(n, c.suggested[n], c.suggested[n].note)}`))
  lines.push(`keep-outs: ${c.keepouts.length ? '' : 'none'}`, ...c.keepouts.map((k) => `- ${keepoutLine(k)}`))
  lines.push(`outline: ${r3(c.outline.min)} to ${r3(c.outline.max)}`)
  if (c.holes.length) {
    const byDia = new Map<number, number>()
    for (const h of c.holes) byDia.set(h.diameter, (byDia.get(h.diameter) ?? 0) + 1)
    lines.push(`round holes found: ${[...byDia].sort((a, b) => b[0] - a[0]).map(([d, n]) => `${n}× Ø${d}`).join(', ')}`)
  }
  return lines.join('\n')
}

function sameDatum(a: Datum, b: Datum) {
  const { note: _n, ...rest } = a as SuggestedDatum
  return JSON.stringify(rest) === JSON.stringify(b)
}

function bytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------------------------------------------------------------- tools (in-app AI and outside agents)

export interface ComponentToolApi extends ComponentApi {
  libraryItem(id: string): LibraryItem | null | Promise<LibraryItem | null>
}

export type ComponentToolCtx = { env: Env; uid: string; api: ComponentToolApi; attachments?: Attachment[] }
export type ComponentToolOut = { content: Block[]; isError?: boolean; detail: string }

/** import_component, list_components, read_component, set_component_datums. */
export async function runComponentTool(name: string, input: unknown, ctx: ComponentToolCtx): Promise<ComponentToolOut> {
  const { env, uid, api } = ctx
  const fail = (text: string, detail: string): ComponentToolOut => ({ content: [{ type: 'text', text }], isError: true, detail })
  const ok = (text: string, detail: string, image?: string): ComponentToolOut => ({ content: [{ type: 'text', text }, ...(image ? [{ type: 'image' as const, mediaType: 'image/png', data: image }] : [])], detail })
  if (name === 'list_components') {
    const all = await api.listComponents()
    return ok(all.length ? all.map((c) => describeComponent(c)).join('\n\n') : 'No components yet. Bring vendor STEP files in with import_component.', `${all.length} components`)
  }
  if (name === 'read_component') {
    const f = ReadComponentInput.safeParse(input)
    if (!f.success) return fail(badInput(input, f.error), 'invalid input')
    const c = await api.component(f.data.component)
    if (!c) return fail(`No component "${f.data.component}". Components: ${(await api.listComponents()).map((x) => x.id).join(', ') || 'none'}.`, `${f.data.component} · not found`)
    const png = await env.FILES.get(keyOf(c.files.render))
    return ok(describeComponent(c, true), c.id, png ? toB64(new Uint8Array(await png.arrayBuffer())) : undefined)
  }
  if (name === 'set_component_datums') {
    const f = SetComponentDatums.safeParse(input)
    if (!f.success) return fail(badInput(input, f.error), 'invalid input')
    const c = await api.component(f.data.component)
    if (!c) return fail(`No component "${f.data.component}".`, `${f.data.component} · not found`)
    const doc = patchComponent(c, f.data)
    await api.saveComponent(doc)
    const changed = [f.data.datums && `${Object.keys(f.data.datums).length} datums`, f.data.keepouts && `${f.data.keepouts.length} keep-outs`, f.data.outline && 'outline'].filter(Boolean).join(', ')
    return ok(`Saved ${c.id}${changed ? ` (${changed})` : ''}. Assemblies using it pick this up on their next save.\n${describeComponent(doc, true)}`, `${c.id} · ${changed || 'details'}`)
  }
  if (name === 'import_component') {
    const f = ImportInput.safeParse(input)
    if (!f.success) return fail(badInput(input, f.error), 'invalid input')
    const i = f.data
    let src: ImportSource
    if (i.library) {
      const item = await api.libraryItem(i.library)
      if (!item) return fail(`No Library item ${i.library}.`, `${i.library} · not found`)
      if (!/\.(step|stp)$/i.test(item.name ?? item.key)) return fail(`Library item ${i.library} (${item.name}) isn't a STEP file.`, 'not a STEP')
      src = { via: 'library', name: item.name ?? 'component.step', key: item.key, libraryId: item.id }
    } else if (i.attachment) {
      const a = ctx.attachments?.[i.attachment - 1]
      if (!a) return fail(`There is no attachment ${i.attachment}.`, 'no such attachment')
      src = { via: 'upload', name: a.name ?? 'component.step', key: a.key }
    } else {
      const data = await stepBytes(i)
      if (typeof data === 'string') return fail(data, 'no file')
      src = { via: i.url ? 'url' : i.base64 ? 'upload' : 'text', name: i.name ? `${i.name}.step` : (i.url?.split('/').pop()?.split('?')[0] ?? 'component.step'), data, ...(i.url && { url: i.url }) }
    }
    const r = await importComponent(env, uid, api, src, { id: i.id, name: i.name, vendor: i.vendor, partNumber: i.part_number, link: i.link, notes: i.notes })
    if (!r.ok) return fail(`Couldn't import it: ${r.why}.`, 'failed')
    const warn = r.warnings.length ? `\nWarnings:\n- ${r.warnings.join('\n- ')}` : ''
    return ok(
      `Imported as component ${r.doc.id} in ${(r.ms / 1000).toFixed(1)} s. Its datums start as what the import found; check them against the datasheet and fix them with set_component_datums (keep-outs too).\n${describeComponent(r.doc, true)}${warn}`,
      `${r.doc.id} · ${r.doc.metrics.faces} faces`,
      r.render,
    )
  }
  return fail(`Unknown tool ${name}.`, 'unknown tool')
}

/** Apply set_component_datums (or the app's PATCH) to a component's record. */
export function patchComponent(c: ComponentDoc, p: Omit<z.infer<typeof SetComponentDatums>, 'component'>): ComponentDoc {
  const datums: Record<string, Datum> = p.replace_datums ? {} : { ...c.datums }
  for (const [k, v] of Object.entries(p.datums ?? {})) {
    if (v === null) delete datums[k]
    else datums[k] = unitDirs(v as Datum)
  }
  return {
    ...c,
    ...(p.name !== undefined && { name: p.name }),
    ...(p.vendor !== undefined && { vendor: p.vendor }),
    ...(p.part_number !== undefined && { partNumber: p.part_number }),
    ...(p.link !== undefined && { link: p.link }),
    ...(p.notes !== undefined && { notes: p.notes }),
    datums,
    ...(p.keepouts && { keepouts: p.keepouts.map((k) => unitDirs(k as KeepOut)) }),
    ...(p.outline && { outline: p.outline as ComponentDoc['outline'] }),
    updatedAt: Date.now(),
  }
}

function unitDirs<T extends Datum | KeepOut>(d: T): T {
  const out = { ...d } as Record<string, unknown>
  for (const k of ['normal', 'x', 'direction']) {
    const v = out[k] as number[] | undefined
    if (v) {
      const n = Math.hypot(...v)
      out[k] = v.map((x) => x / n)
    }
  }
  return out as T
}

const ReadComponentInput = z.object({ component: ComponentId }).strict()
const ImportInput = ComponentDetails.extend({
  id: ComponentId.optional(),
  url: z.string().optional(),
  step: z.string().optional(),
  base64: z.string().optional(),
  library: z.string().optional(),
  attachment: z.number().int().min(1).optional(),
}).strict()

function badInput(input: unknown, error: z.ZodError) {
  return JSON.stringify({ INVALID_INPUT: input, problems: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
}

/** STEP bytes from text, base64 or a URL (vendors often serve a zip or a page instead). */
export async function stepBytes(input: { step?: string; base64?: string; url?: string }): Promise<Uint8Array | string> {
  if (input.step?.trim()) return new TextEncoder().encode(input.step)
  if (input.base64?.trim()) {
    try {
      return Uint8Array.from(atob(input.base64.replace(/\s+/g, '')), (c) => c.charCodeAt(0))
    } catch {
      return 'base64 is not valid base64.'
    }
  }
  if (!input.url || !/^https?:\/\//.test(input.url)) return 'Give the STEP file as url, step (text), base64, library or attachment.'
  const res = await fetch(input.url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Merrivile CAD import)' } }).catch((err: Error) => err)
  if (res instanceof Error) return `Couldn't fetch ${input.url}: ${res.message}`
  if (!res.ok) return `Fetching ${input.url} answered HTTP ${res.status}.`
  if (Number(res.headers.get('content-length') ?? 0) > MAX_COMPONENT) return 'That file is over the 95 MB limit.'
  const data = new Uint8Array(await res.arrayBuffer())
  if (data.length > MAX_COMPONENT) return 'That file is over the 95 MB limit.'
  if (data[0] === 0x50 && data[1] === 0x4b) return 'That URL serves a zip archive. Unzip it locally and send the STEP (start_upload for big files).'
  if (!new TextDecoder().decode(data.subarray(0, 200)).includes('ISO-10303')) return `That URL didn't return a STEP file (it starts with "${new TextDecoder().decode(data.subarray(0, 60)).replace(/\s+/g, ' ')}").`
  return data
}

function toB64(data: Uint8Array) {
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(bin)
}
