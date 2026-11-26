import { DurableObject } from 'cloudflare:workers'
import { z } from 'zod'
import { MATERIALS } from '../shared/protocol'
import type { Attachment, BuildError, CallState, ChangeNote, ChatEntry, ClientEvent, FaceRef, PartDoc, PartHardware, PartMetrics, ServerEvent } from '../shared/protocol'
import { endNote, runAgent } from './agent'
import { accountOf } from './env'
import type { Env } from './env'
import { geometryFetch } from './geometry'
import { runInspect } from './inspect'
import type { Section, View } from './inspect'
import { Trace } from './langfuse'
import type { Block, HistoryItem, ToolResult } from './llm'
import { ModelError } from './llm'
import { SYSTEM, TOOLS } from './prompt'
import { attachmentBlocks, hydrator, labels, MODEL_STEP } from './files'
import { runShopTool, SHOP_TOOL_NAMES } from './tools-shop'
import type { ShopApi } from './tools-shop'
import { Threads } from './threads'

const DEFAULT_COLOR = '#b9bcc2'
/** Names the chat, and its entries, where an outside agent's (MCP) work shows. */
const AGENT = 'Outside agent (MCP)'
const DEFAULT_MATERIAL = 'Aluminum 6061'

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
const Material = z.enum(Object.keys(MATERIALS) as [string, ...string[]])
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const Note = z.string().max(120).optional()
const Bodies = z.number().int().min(1).optional()
const WritePart = z.object({ id: Id, name: z.string().min(1).max(80), source: z.string().min(1), material: Material.optional(), color: Color.optional(), note: Note, bodies: Bodies })
const EditPart = z.object({
  id: Id,
  edits: z.array(z.object({ old_str: z.string(), new_str: z.string() })),
  name: z.string().min(1).max(80).optional(),
  material: Material.optional(),
  color: Color.optional(),
  note: Note,
  bodies: Bodies,
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

/** What an outside agent's tool call returns: text and pictures, and the R2 key of a render it made. */
export type AgentReply = { content: Extract<Block, { type: 'text' | 'image' }>[]; isError?: boolean; render?: string }

/** One project: its parts, its chat, and the agent loop that edits them. */
export class Project extends DurableObject<Env> {
  private sql: SqlStorage
  private threads: Threads
  private abort: AbortController | null = null
  /** The thread the current run, restore or import writes to (one at a time per project). */
  private thread = ''

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS parts (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS versions (part TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (part, version));
`)
    this.threads = new Threads(this.sql, { chat: 'chat', history: 'history' })
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
    const asked = new URL(req.url).searchParams.get('thread') ?? ''
    const thread = asked === 'new' ? '' : this.threads.has(asked) ? asked : this.threads.latest()
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ thread })
    server.send(
      JSON.stringify({
        type: 'snapshot',
        project: info,
        parts: this.parts(),
        assemblies: [],
        chat: this.threads.entries(thread),
        running: !!this.abort,
        threads: this.threads.list(),
        thread,
      } satisfies ServerEvent),
    )
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let event: ClientEvent
    try {
      event = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
    } catch {
      return
    }
    const thread = threadOf(ws)
    if (event.type === 'stop') this.abort?.abort()
    else if (event.type === 'undo') await this.toggleNote(thread, event.index, event.changeId)
    else if (event.type === 'open') this.show(ws, this.threads.has(event.thread) ? event.thread : '')
    else if (event.type === 'delete-thread') this.deleteThread(event.thread)
    else if (event.type === 'restore' && !this.abort) this.ctx.waitUntil(this.restore(this.ensure(ws), event.part, event.version))
    else if (event.type === 'send' && (event.text.trim() || event.images?.length) && !this.abort) {
      // Keep the object alive for the whole run, not just this message.
      this.ctx.waitUntil(this.run(this.ensure(ws), event.text.trim(), event.faces ?? [], event.modelId, (event.images ?? []).slice(0, 10)))
    }
  }

  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code, 'bye')
  }

  /** The socket's thread; a new chat exists from its first message on. */
  private ensure(ws: WebSocket) {
    const thread = threadOf(ws)
    if (thread) return thread
    const id = this.threads.create().id
    this.show(ws, id)
    return id
  }

  /** Point one socket at a thread ("" for a new chat) and send it that thread's messages. */
  private show(ws: WebSocket, thread: string) {
    ws.serializeAttachment({ thread })
    ws.send(JSON.stringify({ type: 'thread', thread, chat: this.threads.entries(thread) } satisfies ServerEvent))
  }

  private deleteThread(thread: string) {
    if (!this.threads.has(thread) || (this.abort && this.thread === thread)) return
    this.threads.remove(thread)
    for (const ws of this.ctx.getWebSockets()) if (threadOf(ws) === thread) this.show(ws, '')
    this.broadcast({ type: 'threads', threads: this.threads.list() })
  }

  // ---------------------------------------------------------------- agent loop

  private async run(thread: string, text: string, faces: FaceRef[], modelId: string | undefined, images: Attachment[]) {
    const abort = (this.abort = new AbortController())
    this.thread = thread
    this.broadcast({ type: 'running', running: true, thread })
    this.pushChat({ role: 'user', text, ...(faces.length && { faces }), ...(images.length && { images }) })
    const account = this.account()
    const cfg = await account.modelConfig(modelId)
    const entry: AiEntry = { role: 'ai', text: '', calls: [], model: cfg?.label, startedAt: Date.now() }
    const index = this.pushChat(entry)
    const projectId = this.projectId()
    const projectName = (await account.project(projectId))?.name
    const trace = new Trace(this.env, {
      name: 'agent-run',
      userId: this.meta('email') || this.meta('owner'),
      sessionId: `${projectId}-${thread}`,
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
        this.toThread({ type: 'call', index, call: state })
        const started = Date.now()
        const obj = (a.size ?? 0) <= MODEL_STEP ? await this.env.FILES.get(a.key) : null
        const r = obj
          ? await this.importPart(a.name ?? 'part.step', new Uint8Array(await obj.arrayBuffer()), abort.signal)
          : { ok: false as const, why: (a.size ?? 0) > MODEL_STEP ? 'over the 45 MB import limit; it is stored but not imported' : 'the file is missing' }
        Object.assign(state, r.ok ? { state: 'done', detail: `${a.name} → ${r.part.id} v1 · ${r.part.metrics?.faces} faces` } : { state: 'error', detail: `${a.name} · ${r.why}` }, { ms: Date.now() - started })
        this.toThread({ type: 'call', index, call: state })
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
          this.toThread({ type: 'text', index, delta })
        },
        host: {
          history: () => this.history(),
          hydrate: hydrator(this.env),
          append: (item) => this.appendHistory(item),
          afterRound: () => this.saveChat(index, entry),
          describe: (id) => entry.calls.find((c) => c.id === id)?.detail,
          execute: (call) =>
            SHOP_TOOL_NAMES.has(call.name) ? this.shopTool(call, entry, index, shopCtx) : this.execute(call, { entry, index, thread }, cfg.vision, abort.signal),
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
      entry.ms = Date.now() - entry.startedAt!
      this.saveChat(index, entry)
      this.toThread({ type: 'chat', entry, index })
      this.abort = null
      this.broadcast({ type: 'running', running: false, thread: this.thread })
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
    this.toThread({ type: 'call', index, call: state })
    const started = Date.now()
    const out = await runShopTool(call.name, call.input, ctx, call.id).catch(
      (err: Error) => ({ result: { id: call.id, isError: true, content: [{ type: 'text' as const, text: `The tool failed: ${err.message}` }] }, detail: 'failed', ok: false }) as Awaited<ReturnType<typeof runShopTool>>,
    )
    Object.assign(state, { state: out.ok ? 'done' : 'error', detail: out.detail, ms: Date.now() - started })
    this.toThread({ type: 'call', index, call: state })
    if (out.notes?.length) {
      entry.notes = [...(entry.notes ?? []), ...out.notes]
      this.toThread({ type: 'notes', index, notes: entry.notes })
    }
    return out.result
  }

  /** Undo (or redo) a shop or memory change from its note in the chat. */
  private async toggleNote(thread: string, index: number, changeId: string) {
    const entry = this.threads.entry(thread, index)
    const note = entry?.role === 'ai' ? entry.notes?.find((n: ChangeNote) => n.changeId === changeId) : undefined
    if (!note || entry?.role !== 'ai') return
    if (!(await this.account().toggleChange(changeId, !note.undone))) return
    note.undone = !note.undone
    this.threads.save(thread, index, entry)
    this.toThread({ type: 'notes', index, notes: entry.notes! }, thread)
  }

  /** Rebuild an earlier version's source as the newest version. */
  private async restore(thread: string, partId: string, version: number) {
    const part = this.part(partId)
    const row = this.sql.exec<{ source: string }>('SELECT source FROM versions WHERE part = ? AND version = ?', partId, version).toArray()[0]
    if (!part || !row) return
    const abort = (this.abort = new AbortController())
    this.thread = thread
    this.broadcast({ type: 'running', running: true, thread })
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
          this.toThread({ type: 'call', index, call: state })
        },
        Date.now(),
      )
      const now = this.part(partId)!
      entry.text = result.isError ? `v${version} of ${part.name} didn't build again; the part is unchanged.` : `${part.name} is back to v${version}'s design, saved as v${now.version}.`
      if (!result.isError)
        this.appendHistory({ role: 'user', content: [{ type: 'text', text: `[The person restored ${partId} to the source of v${version}; it's now v${now.version}.]` }] })
    } finally {
      this.saveChat(index, entry)
      this.toThread({ type: 'chat', entry, index })
      this.abort = null
      this.broadcast({ type: 'running', running: false, thread: this.thread })
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
    if (!result.isError) return { ok: true, part: this.part(id)! }
    return { ok: false, why: result.error?.message.includes('no solids') ? 'no solids in it' : (result.error?.message ?? 'unknown error') }
  }

  private async importStep(req: Request) {
    if (this.abort) return Response.json({ error: 'The AI is working on this project. Import once it finishes.' }, { status: 409 })
    const filename = decodeURIComponent(req.headers.get('x-filename') ?? 'part.step')
    const data = new Uint8Array(await req.arrayBuffer())
    if (!data.length) return Response.json({ error: 'The file is empty.' }, { status: 400 })
    const abort = (this.abort = new AbortController())
    // Into the chat the person is looking at, or a new one.
    const asked = req.headers.get('x-thread') ?? ''
    this.thread = this.threads.has(asked) ? asked : this.threads.create().id
    if (this.thread !== asked) for (const ws of this.ctx.getWebSockets()) if (!threadOf(ws)) this.show(ws, this.thread)
    this.broadcast({ type: 'running', running: true, thread: this.thread })
    this.pushChat({ role: 'user', text: `Imported ${filename}` })
    const entry: AiEntry = { role: 'ai', text: '', calls: [], model: 'Import' }
    const index = this.pushChat(entry)
    const state: CallState = { id: `import-${Date.now()}`, tool: 'import_step', detail: `${filename} · reading`, state: 'running' }
    entry.calls.push(state)
    this.toThread({ type: 'call', index, call: state })
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
      this.toThread({ type: 'chat', entry, index })
      this.abort = null
      this.broadcast({ type: 'running', running: false, thread: this.thread })
      await this.touch()
      await trace.end({ output: entry.text, level: entry.error ? 'WARNING' : 'DEFAULT' })
    }
  }

  // Attachment numbers refer to the newest message that had images.
  private attachments(images: Attachment[]): Attachment[] {
    if (images.length) {
      // Every file sent in this chat lately, newest first, for run_python's working directory.
      const files = [...images, ...this.files().filter((f) => !images.some((a) => a.key === f.key))].slice(0, 20)
      this.threads.setMeta(this.thread, 'images', JSON.stringify(images))
      this.threads.setMeta(this.thread, 'files', JSON.stringify(files))
      return images
    }
    return JSON.parse(this.threads.meta(this.thread, 'images') || '[]')
  }

  private files(): Attachment[] {
    return JSON.parse(this.threads.meta(this.thread, 'files') || this.threads.meta(this.thread, 'images') || '[]')
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
        ? `[Parts in this project: ${parts.map((p) => `${p.id} "${p.name}" v${p.version} ${p.status === 'ok' ? 'builds' : 'has a build error'}${p.stale?.length ? ', out of date' : ''}`).join('; ')}]`
        : '[This project has no parts yet.]',
    )
    // Memory and shop go in only when they changed since this chat saw them, so history stays small.
    const hash = String(hashOf(context))
    if (hash !== this.threads.meta(this.thread, 'context')) {
      lines.push(`[Current memory and shop:\n${context}]`)
      this.threads.setMeta(this.thread, 'context', hash)
    }
    return lines.join('\n')
  }

  /** A part tool, from the chat's AI or an outside agent; `log` is the chat entry that shows it. */
  private async execute(call: Extract<Block, { type: 'tool_call' }>, log: { entry: AiEntry; index: number; thread: string }, vision: boolean, signal: AbortSignal): Promise<ToolResult> {
    const state: CallState = { id: call.id, tool: call.name, detail: '', state: 'running' }
    log.entry.calls.push(state)
    const started = Date.now()
    const update = (patch: Partial<CallState>) => {
      Object.assign(state, patch)
      this.toThread({ type: 'call', index: log.index, call: state }, log.thread)
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
        let id: string, name: string | undefined, source: string, material: string | undefined, color: string | undefined, note: string | undefined, bodies: number | undefined
        let fallback = this.part(String((call.input as { id?: unknown }).id)) ? 'Rewrote the part' : 'First build'
        if (call.name === 'write_part') {
          const input = WritePart.safeParse(call.input)
          if (!input.success) return fail(invalid(call.input, input.error), 'invalid input')
          ;({ id, name, source, material, color, note, bodies } = input.data)
        } else {
          const input = EditPart.safeParse(call.input)
          if (!input.success) return fail(invalid(call.input, input.error), 'invalid input')
          ;({ id, name, material, color, note, bodies } = input.data)
          fallback = input.data.edits.length ? 'Edited' : 'Rebuilt'
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
        const r = await this.build(call.id, { id, name, source, material, color, bodies, note: note ?? fallback }, vision, signal, update, started)
        return { id: r.id, content: r.content, ...(r.isError && { isError: true }) }
      }
      return fail(`Unknown tool ${call.name}.`, 'unknown tool')
    } catch (err) {
      return fail(`The tool failed: ${(err as Error).message}`, signal.aborted ? 'stopped' : 'failed')
    }
  }

  private async build(
    callId: string,
    req: { id: string; name?: string; source: string; material?: string; color?: string; assets?: string[]; bodies?: number; note?: string },
    withImage: boolean,
    signal: AbortSignal,
    update: (patch: Partial<CallState>) => void,
    started: number,
  ): Promise<ToolResult & { error?: BuildError }> {
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
      uses: usesOf(req.source),
      bodies: req.bodies ?? base.bodies,
      updatedAt: Date.now(),
    }

    let out: Build
    try {
      // Other parts' sources for part(id), and files the script reads with asset(name), e.g. an imported STEP.
      const { parts, assets } = await this.partInputs(req.source, doc.assets)
      const res = await geometryFetch(this.env, '/build', {
        method: 'POST',
        body: JSON.stringify({ id: req.id, source: req.source, timeout: 90, parts, assets, bodies: doc.bodies }),
        signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      out = await res.json()
    } catch (err) {
      if (signal.aborted) throw err
      update({ state: 'error', detail: `${req.id} · geometry service unreachable`, ms: Date.now() - started })
      return { id: callId, isError: true, content: [{ type: 'text', text: `The geometry service didn't respond (${(err as Error).message}). Nothing was built; tell the person it's down.` }] }
    }

    // A failed build saves nothing: a new part isn't created, an existing one keeps its last good version.
    if (!out.ok) {
      if (prev && !prev.version) {
        // A draft that never built, stored before failed builds stopped being saved.
        this.sql.exec('DELETE FROM parts WHERE id = ?', req.id)
        this.broadcast({ type: 'part_removed', id: req.id })
      }
      update({ state: 'error', detail: `${req.id} · ${out.error.type}${out.error.line ? ` line ${out.error.line}` : ''}`, ms: Date.now() - started })
      return { id: callId, isError: true, content: [{ type: 'text', text: formatError(req.id, out, req.source, prev?.version) }], error: out.error }
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
      stale: undefined,
    }
    this.sql.exec('INSERT OR REPLACE INTO versions (part, version, source, created_at, note) VALUES (?, ?, ?, ?, ?)', req.id, version, req.source, Date.now(), req.note ?? '')
    const stale = this.markStale(req.id, version)
    this.savePart(built)
    const m = out.metrics
    update({ state: 'done', detail: `${req.id} v${version} · ${m.faces} faces · ${(m.volume_mm3 / 1000).toFixed(1)} cm³`, ms: Date.now() - started })

    const content: Block[] = [
      {
        type: 'text',
        text: `Built ${req.id} v${version} in ${(out.ms / 1000).toFixed(1)} s.\n${describe(built, false)}${out.warnings.length ? `\nWarnings:\n- ${out.warnings.join('\n- ')}` : ''}${stale.length ? `\nOut of date now:\n- ${stale.join('\n- ')}` : ''}${out.stdout ? `\nstdout:\n${out.stdout}` : ''}`,
      },
    ]
    if (withImage) content.push({ type: 'image', mediaType: 'image/png', data: out.render })
    return { id: callId, content }
  }

  /**
   * `id` has a new version: the parts that use it, directly or through others, are now out of date.
   * They aren't rebuilt (that could break them unseen); each gets a note until its next good build.
   */
  private markStale(id: string, version: number): string[] {
    const parts = this.parts()
    const done = new Set([id])
    const lines: string[] = []
    for (let changed = [id]; changed.length; ) {
      const next: string[] = []
      for (const p of parts) {
        const via = p.uses?.filter((u) => changed.includes(u)) ?? []
        if (done.has(p.id) || !via.length) continue
        done.add(p.id)
        next.push(p.id)
        // Quietly: the viewer follows parts that are broadcast, and nothing it shows changed.
        this.savePart({ ...p, stale: [...(p.stale ?? []).filter((s) => s.part !== id), { part: id, version }] }, false)
        lines.push(`${p.id} uses ${id}${via.includes(id) ? '' : ` through ${via.join(', ')}`} and is now out of date; rebuild it with edit_part edits: []`)
      }
      changed = next
    }
    return lines
  }

  // ---------------------------------------------------------------- outside agents (MCP)

  /**
   * A tool call from an outside agent over MCP; the Worker checked that the user owns the project.
   * What the agent changes shows in the project's "Outside agent (MCP)" chat, and the viewer updates live.
   */
  async mcp(who: { projectId: string; owner: string; email: string }, name: string, input: Record<string, unknown>): Promise<AgentReply> {
    this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('id', ?), ('owner', ?), ('email', ?)", who.projectId, who.owner, who.email)
    const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError && { isError }) })
    const id = String(input.part ?? input.id ?? '')
    const signal = AbortSignal.timeout(280_000)

    if (name === 'list_parts') {
      const parts = this.parts()
      if (!parts.length) return text('This project has no parts yet.')
      return text(parts.map((p) => describe(p, false)).join('\n\n'))
    }
    if (name === 'read_part') {
      const part = this.part(id)
      if (!part) return text(`No part "${id}". Parts: ${this.parts().map((p) => p.id).join(', ') || 'none'}.`, true)
      const all = this.sql
        .exec<{ version: number; note: string; created_at: number }>('SELECT version, note, created_at FROM versions WHERE part = ? ORDER BY version DESC', id)
        .toArray()
      const versions = `versions (newest first): ${all.map((v) => `v${v.version} ${new Date(v.created_at).toISOString().slice(0, 16)} ${v.note || '-'}`).join('; ')}`
      if (input.version === undefined) return text(`${describe(part)}\n${versions}`)
      const row = this.sql.exec<{ source: string }>('SELECT source FROM versions WHERE part = ? AND version = ?', id, Number(input.version)).toArray()[0]
      if (!row) return text(`${id} has no v${input.version}. ${versions}`, true)
      return text(`${id} v${input.version} source:\n\`\`\`python\n${row.source}\n\`\`\`\n${versions}`)
    }
    if (name === 'read_chats') {
      const thread = String(input.chat ?? '')
      if (!thread) return text(this.threads.list().map((t) => `${t.id} "${t.title}" · ${t.messages} messages · ${new Date(t.updatedAt).toISOString().slice(0, 16)}`).join('\n') || 'No chats yet.')
      if (!this.threads.has(thread)) return text(`No chat "${thread}".`, true)
      const entries = this.threads.entries(thread).slice(-Number(input.last ?? 30))
      return text(
        entries
          .map((e) => (e.role === 'user' ? `PERSON: ${e.text}${e.images?.length ? ` [${e.images.map((a) => a.name ?? 'file').join(', ')}]` : ''}` : `AI${e.model ? ` (${e.model})` : ''}: ${e.calls.map((c) => `[${c.tool} ${c.detail}]`).join(' ')} ${e.text}${e.images?.length ? ` [renders: ${e.images.map((a) => a.caption ?? a.name).join('; ')}]` : ''}`))
          .join('\n\n'),
      )
    }

    // Everything below changes or builds something; it shows in the agent's chat.
    const log = this.agentLog()
    const finish = (line?: string) => {
      if (line) log.entry.text += `${log.entry.text ? '\n' : ''}${line}`
      log.entry.ms = Date.now() - log.entry.startedAt!
      this.threads.save(log.thread, log.index, log.entry)
      this.toThread({ type: 'chat', entry: log.entry, index: log.index }, log.thread)
    }
    const tell = (fact: string) => this.threads.append(log.thread, { role: 'user', content: [{ type: 'text', text: `[An outside agent (MCP) ${fact}]` }] })
    try {
      if (name === 'write_part' || name === 'edit_part' || name === 'set_part_hardware') {
        const r = await this.execute({ type: 'tool_call', id: `mcp-${crypto.randomUUID().slice(0, 8)}`, name, input }, log, true, signal)
        const part = this.part(id)
        if (!r.isError && part && name !== 'set_part_hardware') {
          const note = part.versions?.[0]?.note || 'built'
          tell(`built ${id} v${part.version}: ${note}.`)
          finish(`${part.name} v${part.version}: ${note}`)
        } else finish()
        await this.touch()
        return { content: r.content as AgentReply['content'], isError: r.isError }
      }
      if (name === 'delete_part') {
        const part = this.part(id)
        if (!part) return text(`No part "${id}".`, true)
        this.sql.exec('DELETE FROM parts WHERE id = ?', id)
        this.sql.exec('DELETE FROM versions WHERE part = ?', id)
        this.broadcast({ type: 'part_removed', id })
        log.entry.calls.push({ id: `mcp-del-${id}`, tool: 'delete_part', detail: id, state: 'done', ms: 0 })
        tell(`deleted part ${id}.`)
        finish(`Deleted ${part.name}`)
        await this.touch()
        return text(`Deleted ${id} and its ${part.version} versions.`)
      }
      if (name === 'restore_part_version') {
        const version = Number(input.version)
        const row = this.sql.exec<{ source: string }>('SELECT source FROM versions WHERE part = ? AND version = ?', id, version).toArray()[0]
        if (!this.part(id) || !row) return text(`No ${id} v${version}.`, true)
        const state: CallState = { id: `mcp-restore-${id}-${version}`, tool: 'restore', detail: `${id} v${version}`, state: 'running' }
        log.entry.calls.push(state)
        const r = await this.build(state.id, { id, source: row.source, note: `Restored v${version}` }, true, signal, (patch) => {
          Object.assign(state, patch)
          this.toThread({ type: 'call', index: log.index, call: state }, log.thread)
        }, Date.now())
        if (!r.isError) tell(`restored ${id} to the source of v${version}; it's now v${this.part(id)!.version}.`)
        finish(r.isError ? undefined : `Restored ${id} to v${version}`)
        await this.touch()
        return { content: r.content as AgentReply['content'], isError: r.isError }
      }
      if (name === 'import_step') {
        const data = input.data as Uint8Array
        const state: CallState = { id: `mcp-import-${Date.now()}`, tool: 'import_step', detail: `${input.name} · reading`, state: 'running' }
        log.entry.calls.push(state)
        this.toThread({ type: 'call', index: log.index, call: state }, log.thread)
        const started = Date.now()
        const r = await this.importPart(String(input.name), data, signal)
        Object.assign(state, r.ok ? { state: 'done', detail: `${input.name} → ${r.part.id} v1 · ${r.part.metrics?.faces} faces` } : { state: 'error', detail: `${input.name} · failed` }, { ms: Date.now() - started })
        if (r.ok) tell(`imported ${input.name} as part ${r.part.id}; its source reads it with import_step(asset("${r.part.assets?.[0]}")).`)
        finish(r.ok ? `Imported ${input.name} as ${r.part.id}` : undefined)
        await this.touch()
        return r.ok
          ? text(`Imported as part ${r.part.id} "${r.part.name}"; its source reads it with import_step(asset("${r.part.assets?.[0]}")).\n${describe(r.part, false)}`)
          : text(`Couldn't import ${input.name}: ${r.why}.`, true)
      }
      if (name === 'inspect' || name === 'render_part') {
        const code = name === 'inspect' ? String(input.code ?? '') : `result = part(${JSON.stringify(id)})`
        // Renders show in the agent's chat, so the person sees what the agent looked at.
        const caption = typeof input.caption === 'string' ? input.caption.trim().slice(0, 500) : ''
        const show = (key: string, label: string) => {
          log.entry.images = [...(log.entry.images ?? []), { key, url: `/api/files/${key}`, kind: 'image', name: `${label}.png`, ...(caption && { caption }) }]
        }
        if (name === 'render_part') {
          const part = this.part(id)
          if (!part?.files) return text(`No built part "${id}".`, true)
          // The stored 4-view sheet when no particular view or section is asked for.
          if (!input.views && !input.size && !input.section) {
            const key = part.files.render.replace('/api/files/', '')
            const obj = await this.env.FILES.get(key)
            if (obj) {
              log.entry.calls.push({ id: `mcp-render_part-${Date.now()}`, tool: name, detail: `${id} v${part.version}`, state: 'done', ms: 0 })
              show(key, `${id}-v${part.version}`)
              finish()
              return { content: [{ type: 'text', text: describe(part, false) }, { type: 'image', mediaType: 'image/png', data: toBase64(new Uint8Array(await obj.arrayBuffer())) }], render: key }
            }
          }
        }
        const state: CallState = { id: `mcp-${name}-${Date.now()}`, tool: name, detail: name === 'inspect' ? 'running' : id, state: 'running' }
        log.entry.calls.push(state)
        this.toThread({ type: 'call', index: log.index, call: state }, log.thread)
        const started = Date.now()
        const r = await runInspect(
          this.env,
          { code, views: input.views as View[] | undefined, size: input.size as number | undefined, section: input.section as Section | undefined, timeout: input.timeout as number | undefined, ...(await this.partInputs(code)) },
          signal,
        )
        Object.assign(state, { state: r.isError ? 'error' : 'done', detail: name === 'inspect' ? r.summary : `${id} · ${r.summary}`, ms: Date.now() - started })
        let render: string | undefined
        if (r.png) {
          render = `projects/${this.projectId()}/renders/${crypto.randomUUID()}.png`
          await this.env.FILES.put(render, bytes(r.png), { httpMetadata: { contentType: 'image/png' } })
          show(render, name === 'inspect' ? 'inspect' : id)
        }
        finish()
        return { content: r.content as AgentReply['content'], isError: r.isError, render }
      }
      return text(`Unknown tool ${name}.`, true)
    } catch (err) {
      for (const c of log.entry.calls) if (c.state === 'running') c.state = 'error'
      finish()
      return text(`The tool failed: ${(err as Error).message}`, true)
    }
  }

  /** A part's stored document, for exports. */
  partDoc(id: string) {
    return this.part(id)
  }

  /** Delete everything this project holds (the Account forgets it and the Worker clears its files). */
  async destroy() {
    for (const ws of this.ctx.getWebSockets()) ws.close(4404, 'project deleted')
    await this.ctx.storage.deleteAll()
  }

  /**
   * For a part script or inspect code: each part's last good source for part(id) and its colour, and the
   * assets the code reads, plus those of the parts it names and of the parts their sources name in turn.
   */
  private async partInputs(code: string, own: string[] = []) {
    const parts: Record<string, string> = {}
    // Each part's colour, so inspect renders show every part in its own.
    const colors: Record<string, string> = {}
    const all = this.parts()
    for (const p of all) {
      const row = this.sql.exec<{ source: string }>('SELECT source FROM versions WHERE part = ? AND version = ?', p.id, p.version).toArray()[0]
      if (row) parts[p.id] = row.source
      colors[p.id] = p.color
    }
    const named = new Set<string>([...own, ...[...code.matchAll(/asset\(\s*["']([\w.-]+)["']\s*\)/g)].map((m) => m[1])])
    const seen = new Set<string>()
    for (const queue = [code]; queue.length; ) {
      const text = queue.pop()!
      for (const p of all) {
        if (seen.has(p.id) || !(text.includes(`"${p.id}"`) || text.includes(`'${p.id}'`))) continue
        seen.add(p.id)
        for (const a of p.assets ?? []) named.add(a)
        if (parts[p.id]) queue.push(parts[p.id])
      }
    }
    const assets: Record<string, string> = {}
    for (const name of named) {
      const obj = await this.env.FILES.get(`projects/${this.projectId()}/assets/${name}`)
      if (obj) assets[name] = toBase64(new Uint8Array(await obj.arrayBuffer()))
    }
    return { parts, assets, colors }
  }

  /** The chat entry an outside agent's work shows in: the latest one if it's recent, or a new one. */
  private agentLog(): { thread: string; entry: AiEntry; index: number } {
    let thread = this.meta('mcp_thread')
    if (!this.threads.has(thread)) {
      thread = this.threads.create(AGENT).id
      this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('mcp_thread', ?)", thread)
    }
    const entries = this.threads.entries(thread)
    const last = entries.at(-1)
    if (last?.role === 'ai' && last.model === AGENT && Date.now() - last.startedAt! - (last.ms ?? 0) < 10 * 60_000) return { thread, entry: last, index: entries.length - 1 }
    const entry: AiEntry = { role: 'ai', text: '', calls: [], model: AGENT, startedAt: Date.now(), ms: 0 }
    const index = this.threads.push(thread, entry)
    this.toThread({ type: 'chat', entry, index }, thread)
    this.broadcast({ type: 'threads', threads: this.threads.list() })
    return { thread, entry, index }
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

  private savePart(part: PartDoc, broadcast = true) {
    const versions = this.sql
      .exec<{ version: number; note: string; created_at: number }>('SELECT version, note, created_at FROM versions WHERE part = ? ORDER BY version DESC LIMIT 12', part.id)
      .toArray()
      .map((v) => ({ version: v.version, note: v.note, at: v.created_at }))
    const doc = { ...part, versions }
    this.sql.exec('INSERT OR REPLACE INTO parts VALUES (?, ?)', part.id, JSON.stringify(doc))
    if (broadcast) this.broadcast({ type: 'part', part: doc })
  }

  private pushChat(entry: ChatEntry) {
    const index = this.threads.push(this.thread, entry)
    this.toThread({ type: 'chat', entry, index })
    this.broadcast({ type: 'threads', threads: this.threads.list() })
    return index
  }

  private saveChat(index: number, entry: ChatEntry) {
    this.threads.save(this.thread, index, entry)
  }

  private history(): HistoryItem[] {
    return this.threads.history(this.thread)
  }

  private appendHistory(item: HistoryItem) {
    this.threads.append(this.thread, item)
  }

  /** Chat events go only to the sockets showing that thread. */
  private toThread(event: ServerEvent, thread = this.thread) {
    const data = JSON.stringify(event)
    for (const ws of this.ctx.getWebSockets()) {
      if (threadOf(ws) !== thread) continue
      try {
        ws.send(data)
      } catch {
        // Closed sockets are cleaned up by the runtime.
      }
    }
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
  if (p.bodies) lines.push(`bodies: ${p.bodies} (separate solids on purpose)`)
  if (p.uses?.length) lines.push(`uses: ${p.uses.join(', ')}`)
  if (p.stale?.length)
    lines.push(`OUT OF DATE: ${p.stale.map((s) => `${s.part} is now v${s.version}`).join(', ')}, newer than this build; rebuild it with edit_part edits: []`)
  // What it's bolted together with and how it's made, so the AI doesn't say "no hardware listed".
  if (p.hardware?.length) lines.push(`hardware: ${p.hardware.map((h) => `${h.qty}× ${h.name}${h.kind && !h.name.toLowerCase().includes(h.kind.toLowerCase()) ? ` ${h.kind}` : ''} (${h.tier}${h.itemId ? `, shop ${h.itemId}` : ''})`).join('; ')}`)
  else lines.push('hardware: none listed yet')
  if (p.madeWith?.length) lines.push(`made with: ${p.madeWith.join('; ')}`)
  if (withSource) lines.push('source:', '```python', p.source, '```')
  return lines.join('\n')
}

function formatError(id: string, out: Extract<Build, { ok: false }>, source: string, version?: number) {
  const e = out.error
  const trace = e.trace.map((t) => `  line ${t.line}: ${t.code}`).join('\n')
  const kept = version ? `${id} is unchanged at v${version}, its last good build` : `${id} was not created`
  return `Build of ${id} failed; nothing was saved (${kept}).\n${e.type}: ${e.message}${trace ? `\n${trace}` : ''}${out.stdout ? `\nstdout:\n${out.stdout}` : ''}\nThe source that failed:\n\`\`\`python\n${source}\n\`\`\``
}

/** Parts a source uses with part("id"). */
function usesOf(source: string) {
  const ids = [...new Set([...source.matchAll(/\bpart\(\s*["']([a-z0-9][a-z0-9-]{0,40})["']\s*\)/g)].map((m) => m[1]))]
  return ids.length ? ids : undefined
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

const threadOf = (ws: WebSocket) => (ws.deserializeAttachment() as { thread?: string } | null)?.thread ?? ''
