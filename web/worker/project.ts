import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import { MATERIALS } from '../shared/protocol'
import type { Attachment, BuildError, CallState, ChangeNote, ChatEntry, ClientEvent, FaceRef, PartDoc, PartHardware, PartMetrics, ServerEvent } from '../shared/protocol'
import { endNote, runAgent } from './agent'
import { accountOf } from './env'
import type { Env } from './env'
import { geometryFetch } from './geometry'
import { Trace } from './langfuse'
import type { Block, HistoryItem, ToolResult } from './llm'
import { ModelError } from './llm'
import { SYSTEM, TOOLS } from './prompt'
import { attachmentBlocks, hydrator, labels, MODEL_STEP } from './files'
import { runShopTool, SHOP_TOOL_NAMES } from './tools-shop'
import type { ShopApi } from './tools-shop'

const DEFAULT_COLOR = '#b9bcc2'
const DEFAULT_MATERIAL = 'Aluminum 6061'

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
const Material = z.enum(Object.keys(MATERIALS) as [string, ...string[]])
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const Note = z.string().max(120).optional()
const WritePart = z.object({ id: Id, name: z.string().min(1).max(80), source: z.string().min(1), material: Material.optional(), color: Color.optional(), note: Note })
const EditPart = z.object({
  id: Id,
  edits: z.array(z.object({ old_str: z.string(), new_str: z.string() })),
  name: z.string().min(1).max(80).optional(),
  material: Material.optional(),
  color: Color.optional(),
  note: Note,
})
const ReadPart = z.object({ id: Id })
const Hardware = z.object({
  part: Id,
  hardware: z.array(
    z.object({
      item_id: z.string().optional(),
      name: z.string().min(1).max(60),
      kind: z.string().max(80).optional(),
      qty: z.number().int().min(1),
      tier: z.enum(['on-hand', 'prime', 'order']).optional(),
      source: z.string().max(80).optional(),
    }),
  ),
  made_with: z.array(z.string().max(80)).optional(),
})

type Build =
  | {
      ok: true
      ms: number
      warnings: string[]
      stdout: string
      metrics: PartMetrics
      mesh: unknown
      step: string
      stl: string
      render: string
      thumb: string
    }
  | { ok: false; ms: number; error: BuildError; stdout: string }

type AiEntry = Extract<ChatEntry, { role: 'ai' }>

/** One project: its parts, its chat, and the agent loop that edits them. */
export class Project extends DurableObject<Env> {
  private sql: SqlStorage
  private abort: AbortController | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS parts (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (part TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (part, version));
      CREATE TABLE IF NOT EXISTS chat (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL);`)
    // Version notes arrived after the first projects were made.
    if (!this.sql.exec<{ name: string }>('PRAGMA table_info(versions)').toArray().some((c) => c.name === 'note')) {
      this.sql.exec("ALTER TABLE versions ADD COLUMN note TEXT NOT NULL DEFAULT ''")
    }
  }

  // The Worker checks the session and that the project belongs to the account before forwarding.
  async fetch(req: Request) {
    const projectId = req.headers.get('x-project-id')!
    this.sql.exec(
      "INSERT OR REPLACE INTO meta VALUES ('id', ?), ('owner', ?), ('email', ?)",
      projectId,
      req.headers.get('x-account-id')!,
      req.headers.get('x-user-email') ?? '',
    )
    if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/import')) return this.importStep(req)
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    const info = await this.account().project(projectId)
    if (!info) return new Response('no such project', { status: 404 })
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.send(JSON.stringify({ type: 'snapshot', project: info, parts: this.parts(), chat: this.chat(), running: !!this.abort } satisfies ServerEvent))
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    let event: ClientEvent
    try {
      event = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
    } catch {
      return
    }
    if (event.type === 'stop') this.abort?.abort()
    else if (event.type === 'undo') await this.toggleNote(event.index, event.changeId)
    else if (event.type === 'restore' && !this.abort) this.ctx.waitUntil(this.restore(event.part, event.version))
    else if (event.type === 'send' && (event.text.trim() || event.images?.length) && !this.abort) {
      // Keep the object alive for the whole run, not just this message.
      this.ctx.waitUntil(this.run(event.text.trim(), event.faces ?? [], event.modelId, (event.images ?? []).slice(0, 10)))
    }
  }

  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code, 'bye')
  }

  // ---------------------------------------------------------------- agent loop

  private async run(text: string, faces: FaceRef[], modelId: string | undefined, images: Attachment[]) {
    const abort = (this.abort = new AbortController())
    this.broadcast({ type: 'running', running: true })
    this.pushChat({ role: 'user', text, ...(faces.length && { faces }), ...(images.length && { images }) })
    const account = this.account()
    const cfg = await account.modelConfig(modelId)
    const entry: AiEntry = { role: 'ai', text: '', calls: [], model: cfg?.label }
    const index = this.pushChat(entry)
    const projectId = this.projectId()
    const projectName = (await account.project(projectId))?.name
    const trace = new Trace(this.env, {
      name: 'agent-run',
      userId: this.meta('email') || this.meta('owner'),
      sessionId: projectId,
      input: { text, ...(faces.length && { faces }), ...(images.length && { attachments: images.map((a) => a.name ?? `${a.width}×${a.height}`) }) },
      metadata: { model: cfg?.model, label: cfg?.label, provider: cfg?.provider, vision: cfg?.vision },
      tags: ['merrivile', cfg?.provider ?? 'no-model'],
    })
    let apiCalls = 0
    try {
      if (!cfg) throw new ModelError('No model is set up yet. Add one under Settings → Models, then send this again.')
      const context = await account.context(projectId, projectName)
      // STEP files become parts before the model sees the message.
      const imported: string[] = []
      for (const a of images.filter((x) => x.kind === 'step')) {
        const state: CallState = { id: `import-${a.key}`, tool: 'import_step', detail: `${a.name} · reading`, state: 'running' }
        entry.calls.push(state)
        this.broadcast({ type: 'call', index, call: state })
        const started = Date.now()
        const obj = (a.size ?? 0) <= MODEL_STEP ? await this.env.FILES.get(a.key) : null
        const r = obj
          ? await this.importPart(a.name ?? 'part.step', new Uint8Array(await obj.arrayBuffer()), abort.signal)
          : { ok: false as const, why: (a.size ?? 0) > MODEL_STEP ? 'over the 45 MB import limit; it is stored but not imported' : 'the file is missing' }
        Object.assign(state, r.ok ? { state: 'done', detail: `${a.name} → ${r.part.id} v1 · ${r.part.metrics?.faces} faces` } : { state: 'error', detail: `${a.name} · ${r.why}` }, { ms: Date.now() - started })
        this.broadcast({ type: 'call', index, call: state })
        imported.push(r.ok ? `[${a.name} was imported as part ${r.part.id} "${r.part.name}"; its source reads it with import_step(asset("${r.part.assets?.[0]}")).\n${describe(r.part, false)}]` : `[${a.name} could not be imported: ${r.why}.]`)
      }
      const blocks = await attachmentBlocks(this.env, images, cfg.vision)
      this.appendHistory({ role: 'user', content: [{ type: 'text', text: [this.decorate(text, faces, context, images), ...imported].join('\n') }, ...blocks] })
      const shopCtx = {
        api: account as unknown as ShopApi,
        env: this.env,
        uid: this.meta('owner'),
        attachments: this.attachments(images),
        files: this.files(),
        projectId,
        projectName,
        vision: cfg.vision,
        importStep: async (name: string, data: Uint8Array) => {
          const r = await this.importPart(name, data, abort.signal)
          return r.ok ? `Imported as part ${r.part.id} "${r.part.name}"; its source reads it with import_step(asset("${r.part.assets?.[0]}")).\n${describe(r.part, false)}` : `Couldn't import it: ${r.why}.`
        },
      }
      const r = await runAgent({
        cfg,
        system: SYSTEM,
        tools: TOOLS,
        signal: abort.signal,
        trace,
        onText: (delta) => {
          entry.text += delta
          this.broadcast({ type: 'text', index, delta })
        },
        host: {
          history: () => this.history(),
          hydrate: hydrator(this.env),
          append: (item) => this.appendHistory(item),
          afterRound: () => this.saveChat(index, entry),
          describe: (id) => entry.calls.find((c) => c.id === id)?.detail,
          execute: (call) =>
            SHOP_TOOL_NAMES.has(call.name) ? this.shopTool(call, entry, index, shopCtx) : this.execute(call, entry, index, cfg.vision, abort.signal),
        },
      })
      apiCalls = r.apiCalls
      const note = endNote(r)
      if (note) entry.text += `${entry.text ? '\n\n' : ''}${note}`
    } catch (err) {
      entry.error = true
      entry.text += `${entry.text ? '\n\n' : ''}${err instanceof ModelError ? err.message : `Something broke on our side: ${(err as Error).message}`}`
      if (!(err instanceof ModelError)) console.error(err)
    } finally {
      for (const c of entry.calls) if (c.state === 'running') c.state = 'error'
      this.saveChat(index, entry)
      this.broadcast({ type: 'chat', entry, index })
      this.abort = null
      this.broadcast({ type: 'running', running: false })
      await this.touch()
      await trace.end({
        output: entry.text,
        level: entry.error ? 'ERROR' : abort.signal.aborted ? 'WARNING' : 'DEFAULT',
        metadata: { apiCalls, toolCalls: entry.calls.length, stopped: abort.signal.aborted, notes: entry.notes?.length ?? 0 },
      })
    }
  }

  /** A shop or memory tool: same store as the Shop page, with a note and undo in the chat. */
  private async shopTool(call: Extract<Block, { type: 'tool_call' }>, entry: AiEntry, index: number, ctx: Parameters<typeof runShopTool>[2]): Promise<ToolResult> {
    const state: CallState = { id: call.id, tool: call.name, detail: '', state: 'running' }
    entry.calls.push(state)
    this.broadcast({ type: 'call', index, call: state })
    const started = Date.now()
    const out = await runShopTool(call.name, call.input, ctx, call.id).catch(
      (err: Error) => ({ result: { id: call.id, isError: true, content: [{ type: 'text' as const, text: `The tool failed: ${err.message}` }] }, detail: 'failed', ok: false }) as Awaited<ReturnType<typeof runShopTool>>,
    )
    Object.assign(state, { state: out.ok ? 'done' : 'error', detail: out.detail, ms: Date.now() - started })
    this.broadcast({ type: 'call', index, call: state })
    if (out.notes?.length) {
      entry.notes = [...(entry.notes ?? []), ...out.notes]
      this.broadcast({ type: 'notes', index, notes: entry.notes })
    }
    return out.result
  }

  /** Undo (or redo) a shop or memory change from its note in the chat. */
  private async toggleNote(index: number, changeId: string) {
    const row = this.sql.exec<{ entry: string }>('SELECT entry FROM chat WHERE seq = ?', index).toArray()[0]
    if (!row) return
    const entry = JSON.parse(row.entry) as ChatEntry
    const note = entry.role === 'ai' ? entry.notes?.find((n: ChangeNote) => n.changeId === changeId) : undefined
    if (!note || entry.role !== 'ai') return
    if (!(await this.account().toggleChange(changeId, !note.undone))) return
    note.undone = !note.undone
    this.saveChat(index, entry)
    this.broadcast({ type: 'notes', index, notes: entry.notes! })
  }

  /** Rebuild an earlier version's source as the newest version. */
  private async restore(partId: string, version: number) {
    const part = this.part(partId)
    const row = this.sql.exec<{ source: string }>('SELECT source FROM versions WHERE part = ? AND version = ?', partId, version).toArray()[0]
    if (!part || !row) return
    const abort = (this.abort = new AbortController())
    this.broadcast({ type: 'running', running: true })
    const entry: AiEntry = { role: 'ai', text: '', calls: [], model: 'Restore' }
    const index = this.pushChat(entry)
    const state: CallState = { id: `restore-${partId}-${version}`, tool: 'restore', detail: `${partId} v${version}`, state: 'running' }
    entry.calls.push(state)
    try {
      const result = await this.build(
        state.id,
        { id: partId, source: row.source, note: `Restored v${version}` },
        false,
        abort.signal,
        (patch) => {
          Object.assign(state, patch)
          this.broadcast({ type: 'call', index, call: state })
        },
        Date.now(),
      )
      const now = this.part(partId)!
      entry.text = result.isError ? `v${version} of ${part.name} didn't build again; the part is unchanged.` : `${part.name} is back to v${version}'s design, saved as v${now.version}.`
      if (!result.isError)
        this.appendHistory({ role: 'user', content: [{ type: 'text', text: `[The person restored ${partId} to the source of v${version}; it's now v${now.version}.]` }] })
    } finally {
      this.saveChat(index, entry)
      this.broadcast({ type: 'chat', entry, index })
      this.abort = null
      this.broadcast({ type: 'running', running: false })
      await this.touch()
    }
  }

  private async touch() {
    const parts = this.parts()
    const thumb = parts.filter((p) => p.files).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.files?.thumb
    await this.account().touchProject(this.projectId(), { parts: parts.length, thumb })
  }

  /** A STEP file becomes a part whose source imports it, so the AI can build on it. */
  private async importPart(filename: string, data: Uint8Array, signal: AbortSignal): Promise<{ ok: true; part: PartDoc } | { ok: false; why: string }> {
    if (data.length > 40 * 1024 * 1024) return { ok: false, why: 'STEP files up to 40 MB for now' }
    const clean = filename.replace(/[^\w. -]/g, '_')
    const stem = clean.replace(/\.(step|stp)$/i, '')
    const base = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'imported'
    let id = base
    for (let n = 2; this.part(id); n++) id = `${base}-${n}`
    const asset = `${id}.step`
    await this.env.FILES.put(`projects/${this.projectId()}/assets/${asset}`, data, { httpMetadata: { contentType: 'model/step' } })
    const source = `from build123d import *\n\n# Imported from ${clean}. Build on it below; keep the import line.\nresult = import_step(asset("${asset}"))\n`
    const result = await this.build(`import-${id}`, { id, name: stem.slice(0, 80), source, assets: [asset], note: `Imported ${clean}` }, false, signal, () => {}, Date.now())
    const part = this.part(id)!
    if (!result.isError) return { ok: true, part }
    this.sql.exec('DELETE FROM parts WHERE id = ?', id)
    this.broadcast({ type: 'part_removed', id })
    return { ok: false, why: part.error?.message.includes('no solids') ? 'no solids in it' : (part.error?.message ?? 'unknown error') }
  }

  private async importStep(req: Request) {
    if (this.abort) return Response.json({ error: 'The AI is working on this project. Import once it finishes.' }, { status: 409 })
    const filename = decodeURIComponent(req.headers.get('x-filename') ?? 'part.step')
    const data = new Uint8Array(await req.arrayBuffer())
    if (!data.length) return Response.json({ error: 'The file is empty.' }, { status: 400 })
    const abort = (this.abort = new AbortController())
    this.broadcast({ type: 'running', running: true })
    this.pushChat({ role: 'user', text: `Imported ${filename}` })
    const entry: AiEntry = { role: 'ai', text: '', calls: [], model: 'Import' }
    const index = this.pushChat(entry)
    const state: CallState = { id: `import-${Date.now()}`, tool: 'import_step', detail: `${filename} · reading`, state: 'running' }
    entry.calls.push(state)
    this.broadcast({ type: 'call', index, call: state })
    const started = Date.now()
    const trace = new Trace(this.env, {
      name: 'import-step',
      userId: this.meta('email') || this.meta('owner'),
      sessionId: this.projectId(),
      input: { filename, bytes: data.length },
      tags: ['merrivile', 'import'],
    })
    try {
      const r = await this.importPart(filename, data, abort.signal)
      Object.assign(state, r.ok ? { state: 'done', detail: `${filename} → ${r.part.id} v1 · ${r.part.metrics?.faces} faces` } : { state: 'error', detail: `${filename} · failed` }, { ms: Date.now() - started })
      trace.span({ name: 'build', startTime: new Date(started), endTime: new Date(), output: r.ok ? r.part.metrics : r.why, level: r.ok ? 'DEFAULT' : 'WARNING' })
      if (!r.ok) {
        entry.error = true
        entry.text = `Couldn't read ${filename}: ${r.why}. Is it a STEP (AP203/AP214/AP242) file?`
        return Response.json({ error: entry.text }, { status: 422 })
      }
      entry.text = `${r.part.name} is in the project as an imported solid (${r.part.metrics?.faces} faces). Ask me to modify it or design parts around it.`
      this.appendHistory({
        role: 'user',
        content: [{ type: 'text', text: `[The person imported ${filename} as part ${r.part.id} "${r.part.name}". Its source reads the STEP file with import_step(asset("${r.part.assets?.[0]}")).\n${describe(r.part, false)}]` }],
      })
      return Response.json({ ok: true, part: r.part })
    } finally {
      this.saveChat(index, entry)
      this.broadcast({ type: 'chat', entry, index })
      this.abort = null
      this.broadcast({ type: 'running', running: false })
      await this.touch()
      await trace.end({ output: entry.text, level: entry.error ? 'WARNING' : 'DEFAULT' })
    }
  }

  // Attachment numbers refer to the newest message that had images.
  private attachments(images: Attachment[]): Attachment[] {
    if (images.length) {
      // Every file sent in this chat lately, newest first, for run_python's working directory.
      const files = [...images, ...this.files().filter((f) => !images.some((a) => a.key === f.key))].slice(0, 20)
      this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('images', ?), ('files', ?)", JSON.stringify(images), JSON.stringify(files))
      return images
    }
    return JSON.parse(this.meta('images') || '[]')
  }

  private files(): Attachment[] {
    return JSON.parse(this.meta('files') || this.meta('images') || '[]')
  }

  private meta(key: string) {
    return this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', key).toArray()[0]?.v ?? ''
  }

  private account() {
    return accountOf(this.env, this.meta('owner'))
  }

  /** The person's message plus what the model needs to know right now. */
  private decorate(text: string, faces: FaceRef[], context: string, images: Attachment[]) {
    const lines = [text || '(no text, see the attachments)', ...labels(images)]
    for (const f of faces) {
      const fmt = (v: number[]) => `(${v.map((x) => +x.toFixed(2)).join(', ')})`
      lines.push(
        `[Selected in the viewer: ${f.part} face #${f.index}, ${f.type}, area ${f.area.toFixed(1)} mm², centre ${fmt(f.center)}` +
          `${f.normal ? `, normal ${fmt(f.normal)}` : ''}${f.radius ? `, radius ${f.radius}` : ''}]`,
      )
    }
    const parts = this.parts()
    lines.push(
      parts.length
        ? `[Parts in this project: ${parts.map((p) => `${p.id} "${p.name}" v${p.version} ${p.status === 'ok' ? 'builds' : 'has a build error'}`).join('; ')}]`
        : '[This project has no parts yet.]',
    )
    // Memory and shop go in only when they changed, so history stays small.
    const hash = String(hashOf(context))
    if (hash !== this.meta('context')) {
      lines.push(`[Current memory and shop:\n${context}]`)
      this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('context', ?)", hash)
    }
    return lines.join('\n')
  }

  private async execute(call: Extract<Block, { type: 'tool_call' }>, entry: AiEntry, index: number, vision: boolean, signal: AbortSignal): Promise<ToolResult> {
    const state: CallState = { id: call.id, tool: call.name, detail: '', state: 'running' }
    entry.calls.push(state)
    const started = Date.now()
    const update = (patch: Partial<CallState>) => {
      Object.assign(state, patch)
      this.broadcast({ type: 'call', index, call: state })
    }
    const fail = (text: string, detail: string): ToolResult => {
      update({ state: 'error', detail, ms: Date.now() - started })
      return { id: call.id, isError: true, content: [{ type: 'text', text }] }
    }
    try {
      if (call.name === 'read_part') {
        const input = ReadPart.safeParse(call.input)
        if (!input.success) return fail(invalid(call.input, input.error), 'invalid input')
        const part = this.part(input.data.id)
        update({ detail: input.data.id })
        if (!part) return fail(`No part "${input.data.id}". Parts: ${this.parts().map((p) => p.id).join(', ') || 'none'}.`, `${input.data.id} · not found`)
        update({ state: 'done', ms: Date.now() - started })
        return { id: call.id, content: [{ type: 'text', text: describe(part) }] }
      }
      if (call.name === 'set_part_hardware') {
        const input = Hardware.safeParse(call.input)
        if (!input.success) return fail(invalid(call.input, input.error), 'invalid input')
        const part = this.part(input.data.part)
        if (!part) return fail(`No part "${input.data.part}".`, `${input.data.part} · not found`)
        const items = await this.account().items()
        const hardware: PartHardware[] = input.data.hardware.map((h) => {
          const item = h.item_id ? items.find((i) => i.id === h.item_id) : undefined
          const source = item ? (item.tier === 'on-hand' ? [item.bin && `bin ${item.bin}`, item.qty !== undefined && `${item.qty} left`].filter(Boolean).join(' · ') : (item.price ?? '')) : (h.source ?? '')
          // The AI's name wins: "M3 × 12 SHCS" out of an M3 kit says more than the kit's name.
          const kind = h.kind ?? ''
          return { qty: h.qty, name: h.name, kind, tier: item?.tier ?? h.tier ?? 'order', source: item?.unit === 'kit' ? `from ${item.name} · ${source}` : source, itemId: item?.id }
        })
        this.savePart({ ...part, hardware, madeWith: input.data.made_with ?? part.madeWith })
        const toOrder = hardware.filter((h) => h.tier !== 'on-hand').length
        update({ state: 'done', detail: `${part.id} · ${hardware.length} lines${toOrder ? ` · ${toOrder} to buy` : ''}`, ms: Date.now() - started })
        return { id: call.id, content: [{ type: 'text', text: `Saved ${hardware.length} hardware lines and ${input.data.made_with?.length ?? 0} tools on ${part.id}.` }] }
      }
      if (call.name === 'write_part' || call.name === 'edit_part') {
        let id: string, name: string | undefined, source: string, material: string | undefined, color: string | undefined, note: string | undefined
        if (call.name === 'write_part') {
          const input = WritePart.safeParse(call.input)
          if (!input.success) return fail(invalid(call.input, input.error), 'invalid input')
          ;({ id, name, source, material, color, note } = input.data)
        } else {
          const input = EditPart.safeParse(call.input)
          if (!input.success) return fail(invalid(call.input, input.error), 'invalid input')
          ;({ id, name, material, color, note } = input.data)
          const part = this.part(id)
          if (!part) return fail(`No part "${id}" to edit. Use write_part to create it.`, `${id} · not found`)
          source = part.source
          for (const [i, e] of input.data.edits.entries()) {
            const n = source.split(e.old_str).length - 1
            if (n !== 1) return fail(`Edit ${i + 1}: old_str appears ${n} times in the current source of ${id}; it must appear exactly once. Nothing was changed.`, `${id} · edit didn't apply`)
            source = source.replace(e.old_str, () => e.new_str)
          }
        }
        update({ detail: `${id} · building` })
        const fallback = call.name === 'write_part' ? (this.part(id) ? 'Rewrote the part' : 'First build') : 'Edited'
        return await this.build(call.id, { id, name, source, material, color, note: note ?? fallback }, vision, signal, update, started)
      }
      return fail(`Unknown tool ${call.name}.`, 'unknown tool')
    } catch (err) {
      return fail(`The tool failed: ${(err as Error).message}`, signal.aborted ? 'stopped' : 'failed')
    }
  }

  private async build(
    callId: string,
    req: { id: string; name?: string; source: string; material?: string; color?: string; assets?: string[]; note?: string },
    withImage: boolean,
    signal: AbortSignal,
    update: (patch: Partial<CallState>) => void,
    started: number,
  ): Promise<ToolResult> {
    const prev = this.part(req.id)
    const base: PartDoc = prev ?? {
      id: req.id,
      name: req.name ?? req.id,
      color: req.color ?? DEFAULT_COLOR,
      material: req.material ?? DEFAULT_MATERIAL,
      density: MATERIALS[req.material ?? DEFAULT_MATERIAL],
      version: 0,
      source: req.source,
      status: 'ok',
      updatedAt: Date.now(),
    }
    const material = req.material ?? base.material
    const doc: PartDoc = {
      ...base,
      name: req.name ?? base.name,
      color: req.color ?? base.color,
      material,
      density: MATERIALS[material] ?? base.density,
      source: req.source,
      // Any asset("name") the source mentions, e.g. another part's imported STEP.
      assets: [...new Set([...(req.assets ?? base.assets ?? []), ...[...req.source.matchAll(/asset\(\s*["']([\w.-]+)["']\s*\)/g)].map((m) => m[1])])],
      updatedAt: Date.now(),
    }

    let out: Build
    try {
      // Files the script reads with asset(name), e.g. an imported STEP.
      const assets: Record<string, string> = {}
      for (const name of doc.assets ?? []) {
        const obj = await this.env.FILES.get(`projects/${this.projectId()}/assets/${name}`)
        if (obj) assets[name] = toBase64(new Uint8Array(await obj.arrayBuffer()))
      }
      const res = await geometryFetch(this.env, '/build', { method: 'POST', body: JSON.stringify({ source: req.source, timeout: 90, assets }), signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      out = await res.json()
    } catch (err) {
      if (signal.aborted) throw err
      update({ state: 'error', detail: `${req.id} · geometry service unreachable`, ms: Date.now() - started })
      return { id: callId, isError: true, content: [{ type: 'text', text: `The geometry service didn't respond (${(err as Error).message}). Nothing was built; tell the person it's down.` }] }
    }

    if (!out.ok) {
      const failed: PartDoc = { ...doc, status: 'error', error: out.error }
      this.savePart(failed)
      update({ state: 'error', detail: `${req.id} · ${out.error.type}${out.error.line ? ` line ${out.error.line}` : ''}`, ms: Date.now() - started })
      return { id: callId, isError: true, content: [{ type: 'text', text: formatError(req.id, out) }] }
    }

    const version = base.version + 1
    const key = `projects/${this.projectId()}/${req.id}/v${version}`
    await Promise.all([
      this.env.FILES.put(`${key}.json`, JSON.stringify(out.mesh), { httpMetadata: { contentType: 'application/json' } }),
      this.env.FILES.put(`${key}.step`, bytes(out.step), { httpMetadata: { contentType: 'model/step' } }),
      this.env.FILES.put(`${key}.stl`, bytes(out.stl), { httpMetadata: { contentType: 'model/stl' } }),
      this.env.FILES.put(`${key}.png`, bytes(out.render), { httpMetadata: { contentType: 'image/png' } }),
      this.env.FILES.put(`${key}.thumb.png`, bytes(out.thumb), { httpMetadata: { contentType: 'image/png' } }),
    ])
    const url = (ext: string) => `/api/files/${key}.${ext}`
    const built: PartDoc = {
      ...doc,
      version,
      status: 'ok',
      error: undefined,
      metrics: out.metrics,
      files: { mesh: url('json'), step: url('step'), stl: url('stl'), render: url('png'), thumb: url('thumb.png') },
    }
    this.sql.exec('INSERT OR REPLACE INTO versions (part, version, source, created_at, note) VALUES (?, ?, ?, ?, ?)', req.id, version, req.source, Date.now(), req.note ?? '')
    this.savePart(built)
    const m = out.metrics
    update({ state: 'done', detail: `${req.id} v${version} · ${m.faces} faces · ${(m.volume_mm3 / 1000).toFixed(1)} cm³`, ms: Date.now() - started })

    const content: Block[] = [{ type: 'text', text: `Built ${req.id} v${version} in ${(out.ms / 1000).toFixed(1)} s.\n${describe(built, false)}${out.warnings.length ? `\nWarnings:\n- ${out.warnings.join('\n- ')}` : ''}${out.stdout ? `\nstdout:\n${out.stdout}` : ''}` }]
    if (withImage) content.push({ type: 'image', mediaType: 'image/png', data: out.render })
    return { id: callId, content }
  }

  // ---------------------------------------------------------------- storage

  private projectId() {
    return this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'id'").one().v
  }

  private parts(): PartDoc[] {
    return this.sql.exec<{ doc: string }>('SELECT doc FROM parts').toArray().map((r) => JSON.parse(r.doc))
  }

  private part(id: string): PartDoc | null {
    const row = this.sql.exec<{ doc: string }>('SELECT doc FROM parts WHERE id = ?', id).toArray()[0]
    return row ? JSON.parse(row.doc) : null
  }

  private savePart(part: PartDoc) {
    const versions = this.sql
      .exec<{ version: number; note: string; created_at: number }>('SELECT version, note, created_at FROM versions WHERE part = ? ORDER BY version DESC LIMIT 12', part.id)
      .toArray()
      .map((v) => ({ version: v.version, note: v.note, at: v.created_at }))
    const doc = { ...part, versions }
    this.sql.exec('INSERT OR REPLACE INTO parts VALUES (?, ?)', part.id, JSON.stringify(doc))
    this.broadcast({ type: 'part', part: doc })
  }

  private chat(): ChatEntry[] {
    return this.sql.exec<{ entry: string }>('SELECT entry FROM chat ORDER BY seq').toArray().map((r) => JSON.parse(r.entry))
  }

  private pushChat(entry: ChatEntry) {
    const index = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM chat').one().n
    this.sql.exec('INSERT INTO chat VALUES (?, ?)', index, JSON.stringify(entry))
    this.broadcast({ type: 'chat', entry, index })
    return index
  }

  private saveChat(index: number, entry: ChatEntry) {
    this.sql.exec('UPDATE chat SET entry = ? WHERE seq = ?', JSON.stringify(entry), index)
  }

  private history(): HistoryItem[] {
    return this.sql.exec<{ item: string }>('SELECT item FROM history ORDER BY seq').toArray().map((r) => JSON.parse(r.item))
  }

  private appendHistory(item: HistoryItem) {
    this.sql.exec('INSERT INTO history (item) VALUES (?)', JSON.stringify(item))
  }

  private broadcast(event: ServerEvent) {
    const data = JSON.stringify(event)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data)
      } catch {
        // Closed sockets are cleaned up by the runtime.
      }
    }
  }
}

function describe(p: PartDoc, withSource = true) {
  const lines = [`${p.id} "${p.name}" v${p.version}, ${p.material}, status: ${p.status === 'ok' ? 'builds' : 'last build failed'}`]
  if (p.metrics) {
    const m = p.metrics
    const f = (v: number[]) => `[${v.map((x) => +x.toFixed(2)).join(', ')}]`
    lines.push(
      `bbox ${m.bbox.size.map((x) => +x.toFixed(2)).join(' × ')} mm (min ${f(m.bbox.min)}, max ${f(m.bbox.max)})`,
      `volume ${(m.volume_mm3 / 1000).toFixed(3)} cm³, mass ${((m.volume_mm3 / 1000) * p.density).toFixed(1)} g, area ${(m.area_mm2 / 100).toFixed(2)} cm²`,
      `${m.solids} solid${m.solids === 1 ? '' : 's'}, ${m.faces} faces, ${m.edges} edges, ${m.valid ? 'valid' : 'INVALID'} B-rep, centre of mass ${f(m.center)}`,
    )
  }
  if (p.status === 'error' && p.error) lines.push(`last error: ${p.error.type}: ${p.error.message}`)
  if (withSource) lines.push('source:', '```python', p.source, '```')
  return lines.join('\n')
}

function formatError(id: string, out: Extract<Build, { ok: false }>) {
  const e = out.error
  const trace = e.trace.map((t) => `  line ${t.line}: ${t.code}`).join('\n')
  return `Build of ${id} failed. The part keeps its last good version; the failing source is saved as the current draft.\n${e.type}: ${e.message}${trace ? `\n${trace}` : ''}${out.stdout ? `\nstdout:\n${out.stdout}` : ''}`
}

function invalid(input: unknown, error: z.ZodError) {
  return JSON.stringify({ INVALID_INPUT: input, problems: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
}

// A cheap string hash to notice when memory or shop changed.
function hashOf(text: string) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return h
}

function toBase64(data: Uint8Array) {
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(bin)
}

function bytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
