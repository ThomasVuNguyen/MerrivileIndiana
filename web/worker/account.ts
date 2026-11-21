import { DurableObject } from 'cloudflare:workers'
import type { Attachment, CallState, ChatEntry, ClientEvent, Memory, ModelInfo, NewModel, ProjectInfo, Provider, ServerEvent, ShopItem, ShopTool, Tier } from '../shared/protocol'
import { endNote, runAgent } from './agent'
import type { Env } from './env'
import { AnthropicAdapter } from './anthropic'
import { forLog, Trace } from './langfuse'
import { OpenAICompatAdapter } from './openai'
import type { Block, HistoryItem, ModelConfig, ToolResult } from './llm'
import { ModelError } from './llm'
import { SHOP_AGENT_TOOLS, SHOP_SYSTEM } from './prompt'
import { attachmentBlocks, hydrator, isVideoName, labels } from './files'
import { ShopStore } from './shop'
import type { ItemPatch, ToolPatch } from './shop'
import { runShopTool } from './tools-shop'
import { videoCopy, videoFrames } from './video'

type ModelRow = {
  id: string
  label: string
  provider: Provider
  model: string
  api_key: string
  base_url: string | null
  account_id: string | null
  vision: number
  is_default: number
  created_at: number
}

type ProjectRow = { id: string; name: string; parts: number; updated_at: number; thumb: string | null }

type AiEntry = Extract<ChatEntry, { role: 'ai' }>

/**
 * One per user: model settings, the project list, the shop (hardware, tools)
 * and memory, and the shop chat. Holds API keys; they never go back to the browser.
 */
export class Account extends DurableObject<Env> {
  private sql: SqlStorage
  private shop: ShopStore
  private abort: AbortController | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        api_key TEXT NOT NULL, base_url TEXT, account_id TEXT, vision INTEGER NOT NULL,
        is_default INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, parts INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, thumb TEXT);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shop_chat (seq INTEGER PRIMARY KEY, entry TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shop_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL);`)
    this.shop = new ShopStore(this.sql)
  }

  // ---------------------------------------------------------------- models

  listModels(): ModelInfo[] {
    return this.sql.exec<ModelRow>('SELECT * FROM models ORDER BY created_at').toArray().map(toInfo)
  }

  addModel(m: NewModel): ModelInfo {
    const id = crypto.randomUUID().slice(0, 8)
    const first = this.sql.exec('SELECT count(*) AS n FROM models').one().n === 0
    this.sql.exec(
      'INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      m.label,
      m.provider,
      m.model,
      m.apiKey,
      m.baseUrl ?? null,
      m.accountId ?? null,
      (m.vision ?? m.provider === 'anthropic') ? 1 : 0,
      first ? 1 : 0,
      Date.now(),
    )
    return this.listModels().find((x) => x.id === id)!
  }

  removeModel(id: string) {
    const wasDefault = this.sql.exec<{ is_default: number }>('SELECT is_default FROM models WHERE id = ?', id).toArray()[0]?.is_default
    this.sql.exec('DELETE FROM models WHERE id = ?', id)
    if (wasDefault) this.sql.exec('UPDATE models SET is_default = 1 WHERE id = (SELECT id FROM models ORDER BY created_at LIMIT 1)')
  }

  setDefault(id: string) {
    this.sql.exec('UPDATE models SET is_default = (id = ?)', id)
  }

  /** The full config, key included, for the Worker and Project objects only. */
  modelConfig(id?: string): (ModelConfig & { label: string }) | null {
    const row = id
      ? this.sql.exec<ModelRow>('SELECT * FROM models WHERE id = ?', id).toArray()[0]
      : this.sql.exec<ModelRow>('SELECT * FROM models ORDER BY is_default DESC, created_at LIMIT 1').toArray()[0]
    if (!row) return id ? this.modelConfig() : null
    return {
      label: row.label,
      provider: row.provider,
      model: row.model,
      apiKey: row.api_key,
      baseUrl: row.base_url ?? undefined,
      accountId: row.account_id ?? undefined,
      vision: !!row.vision,
    }
  }

  // ---------------------------------------------------------------- projects

  listProjects(): ProjectInfo[] {
    return this.sql.exec<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC').toArray().map(toProject)
  }

  createProject(name: string): ProjectInfo {
    const id = crypto.randomUUID().slice(0, 12)
    this.sql.exec('INSERT INTO projects (id, name, updated_at) VALUES (?, ?, ?)', id, name, Date.now())
    return this.project(id)!
  }

  project(id: string): ProjectInfo | null {
    const row = this.sql.exec<ProjectRow>('SELECT * FROM projects WHERE id = ?', id).toArray()[0]
    return row ? toProject(row) : null
  }

  touchProject(id: string, patch: { parts?: number; thumb?: string }) {
    this.sql.exec(
      'UPDATE projects SET updated_at = ?, parts = coalesce(?, parts), thumb = coalesce(?, thumb) WHERE id = ?',
      Date.now(),
      patch.parts ?? null,
      patch.thumb ?? null,
      id,
    )
  }

  // ---------------------------------------------------------------- shop and memory (RPC for Project and the Worker)

  items(): ShopItem[] {
    return this.shop.items()
  }

  tools(): ShopTool[] {
    return this.shop.tools()
  }

  memories(): Memory[] {
    return this.shop.memories()
  }

  memory(id: string) {
    return this.shop.memory(id)
  }

  context(projectId?: string, projectName?: string) {
    return this.shop.context(projectId, projectName)
  }

  addItem(fields: ItemPatch & { name: string; kind: string; tier: Tier }) {
    return this.changed(this.shop.addItem(fields))
  }

  updateItem(id: string, patch: ItemPatch & { qtyDelta?: number }) {
    return this.changed(this.shop.updateItem(id, patch))
  }

  removeItem(id: string) {
    return this.changed(this.shop.removeItem(id))
  }

  upsertTool(id: string | undefined, patch: ToolPatch) {
    return this.changed(this.shop.upsertTool(id, patch))
  }

  removeTool(id: string) {
    return this.changed(this.shop.removeTool(id))
  }

  libraryItems() {
    const items = this.shop.library()
    // Videos added before they were understood were plain files, described blind: queue them once.
    const old = items.filter(
      (i) => !i.processing && ((isVideoName(i.name) && (i.kind === 'file' || i.kind === 'video') && !i.previewKey && !i.problem) || (i.kind === 'video' && i.framesKey && i.description && !i.seen)),
    )
    if (!old.length) return items
    for (const i of old) this.shop.updateLibraryItem(i.id, { kind: 'video', processing: true, description: '' })
    this.ctx.storage.setAlarm(Date.now())
    return this.shop.library()
  }

  addLibraryItem(file: Attachment, note: string) {
    // The browser makes a video's poster when it can; the server makes the rest.
    const work = file.kind === 'video' && (!file.previewKey || file.needsCopy)
    const added = this.shop.addLibraryItem(work ? { ...file, processing: true } : file, note)
    if (work) this.ctx.storage.setAlarm(Date.now())
    return added
  }

  /** A browser couldn't play the original: make an MP4 copy after all. */
  requestCopy(id: string) {
    const item = this.shop.libraryItem(id)
    if (!item || item.kind !== 'video' || item.playKey) return item
    this.shop.updateLibraryItem(id, { needsCopy: true, processing: true })
    this.ctx.storage.setAlarm(Date.now())
    return this.shop.libraryItem(id)
  }

  /** One video at a time: poster and frames if missing, then a playable copy if needed, then its description. */
  async alarm() {
    const item = this.shop.library().find((i) => i.processing)
    if (!item) return
    const patch: Partial<Attachment> = { processing: false }
    try {
      if (!item.previewKey) Object.assign(patch, await videoFrames(this.env, item.key), { description: '' })
      if ((patch.needsCopy ?? item.needsCopy) && !item.playKey) Object.assign(patch, await videoCopy(this.env, item.key))
    } catch (err) {
      patch.problem = (err as Error).message.slice(0, 200)
    }
    this.shop.updateLibraryItem(item.id, patch)
    await this.describeLibraryItem(item.id)
    if (this.shop.library().some((i) => i.processing)) await this.ctx.storage.setAlarm(Date.now())
  }

  updateLibraryNote(id: string, note: string) {
    return this.shop.updateLibraryItem(id, { note })?.item ?? null
  }

  removeLibraryItem(id: string) {
    return this.shop.removeLibraryItem(id)
  }

  /** One line the AI can search later: what the file shows, readable numbers and labels. */
  async describeLibraryItem(id: string) {
    const item = this.shop.libraryItem(id)
    const cfg = this.modelConfig()
    if (!item || !cfg || item.description || item.processing) return
    const trace = new Trace(this.env, { name: 'library-describe', userId: this.meta('email') || this.meta('uid'), input: { name: item.name, kind: item.kind, note: item.note }, tags: ['merrivile', 'library'] })
    let description = ''
    try {
      const blocks = await attachmentBlocks(this.env, [item], cfg.vision)
      const ask = `Describe this file in one plain sentence (max 30 words) so it can be found by search later: what it shows, and any readable numbers, labels or measurements with units. The person's note: "${item.note || 'none'}". File name: ${item.name ?? 'image'}. No preamble.`
      const history: HistoryItem[] = [{ role: 'user', content: [{ type: 'text', text: ask }, ...blocks] }]
      const adapter = cfg.provider === 'anthropic' ? new AnthropicAdapter(cfg) : new OpenAICompatAdapter(cfg)
      const turn = await adapter.turn({
        system: 'You index files for a CAD workspace.',
        tools: [],
        history: await hydrator(this.env)(history),
        signal: AbortSignal.timeout(90_000),
        onText: () => {},
        onCall: (c) => trace.generation({ name: 'describe', model: c.model, startTime: c.startTime, endTime: c.endTime, input: forLog(history), output: c.output, usage: c.usage, modelParameters: c.params, statusMessage: c.error }),
      })
      description = turn.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join(' ').trim().slice(0, 300)
      if (description) this.shop.updateLibraryItem(id, { description, ...(item.framesKey && { seen: true }) })
    } catch (err) {
      console.error('library describe', (err as Error).message)
    } finally {
      await trace.end({ output: description })
    }
  }

  addMemory(text: string, scope: string, scopeName: string | undefined, source: string) {
    return this.shop.addMemory(text, scope, scopeName, source)
  }

  editMemory(id: string, text: string) {
    return this.shop.editMemory(id, text)
  }

  removeMemory(id: string) {
    return this.shop.removeMemory(id)
  }

  /** Undo a change (or redo it when `undo` is false). */
  toggleChange(changeId: string, undo: boolean) {
    return this.changed(this.shop.undo(changeId, !undo))
  }

  // Any write to the shop goes out to open Shop pages.
  private changed<T>(result: T): T {
    this.broadcast({ type: 'shop', items: this.shop.items(), tools: this.shop.tools() })
    return result
  }

  // ---------------------------------------------------------------- shop chat

  async fetch(req: Request) {
    if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 })
    this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('uid', ?), ('email', ?)", req.headers.get('x-account-id')!, req.headers.get('x-user-email') ?? '')
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.send(JSON.stringify({ type: 'shop-snapshot', items: this.shop.items(), tools: this.shop.tools(), chat: this.chat(), running: !!this.abort } satisfies ServerEvent))
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
    else if (event.type === 'undo') this.toggleNote(event.index, event.changeId)
    else if (event.type === 'send' && (event.text.trim() || event.images?.length) && !this.abort) {
      this.ctx.waitUntil(this.run(event.text.trim(), event.modelId, (event.images ?? []).slice(0, 10)))
    }
  }

  webSocketClose(ws: WebSocket, code: number) {
    ws.close(code, 'bye')
  }

  private async run(text: string, modelId: string | undefined, images: Attachment[]) {
    const abort = (this.abort = new AbortController())
    this.broadcast({ type: 'running', running: true })
    this.pushChat({ role: 'user', text, ...(images.length && { images }) })
    const cfg = this.modelConfig(modelId)
    const entry: AiEntry = { role: 'ai', text: '', calls: [], model: cfg?.label }
    const index = this.pushChat(entry)
    const trace = new Trace(this.env, {
      name: 'shop-run',
      userId: this.meta('email') || this.meta('uid'),
      sessionId: `shop-${this.meta('uid')}`,
      input: { text, ...(images.length && { attachments: images.map((a) => a.name ?? `${a.width}×${a.height}`) }) },
      metadata: { model: cfg?.model, label: cfg?.label, provider: cfg?.provider },
      tags: ['merrivile', 'shop', cfg?.provider ?? 'no-model'],
    })
    let apiCalls = 0
    try {
      if (!cfg) throw new ModelError('No model is set up yet. Add one under Settings → Models, then send this again.')
      const steps = images.filter((a) => a.kind === 'step').map((a) => `[${a.name} is a STEP model; those go into a project, where they become parts.]`)
      this.appendHistory({ role: 'user', content: [{ type: 'text', text: [this.decorate(text, images), ...steps].join('\n') }, ...(await attachmentBlocks(this.env, images, cfg.vision))] })
      const ctx = { api: this, env: this.env, uid: this.meta('uid'), attachments: this.attachments(images), vision: cfg.vision }
      const r = await runAgent({
        cfg,
        system: SHOP_SYSTEM,
        tools: SHOP_AGENT_TOOLS,
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
          execute: (call) => this.execute(call, entry, index, ctx),
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
      await trace.end({
        output: entry.text,
        level: entry.error ? 'ERROR' : abort.signal.aborted ? 'WARNING' : 'DEFAULT',
        metadata: { apiCalls, toolCalls: entry.calls.length, notes: entry.notes?.length ?? 0 },
      })
    }
  }

  private async execute(call: Extract<Block, { type: 'tool_call' }>, entry: AiEntry, index: number, ctx: Parameters<typeof runShopTool>[2]): Promise<ToolResult> {
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

  private toggleNote(index: number, changeId: string) {
    const row = this.sql.exec<{ entry: string }>('SELECT entry FROM shop_chat WHERE seq = ?', index).toArray()[0]
    if (!row) return
    const entry = JSON.parse(row.entry) as ChatEntry
    if (entry.role !== 'ai') return
    const note = entry.notes?.find((n) => n.changeId === changeId)
    if (!note || !this.toggleChange(changeId, !note.undone)) return
    note.undone = !note.undone
    this.saveChat(index, entry)
    this.broadcast({ type: 'notes', index, notes: entry.notes! })
  }

  private decorate(text: string, images: Attachment[]) {
    const lines = [text || '(no text, see the attachments)', ...labels(images)]
    const context = this.shop.context()
    const hash = String(hashOf(context))
    if (hash !== this.meta('context')) {
      lines.push(`[Current memory and shop:\n${context}]`)
      this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('context', ?)", hash)
    }
    return lines.join('\n')
  }

  // Attachment numbers refer to the newest message that had images, so "try the picture again" works.
  private attachments(images: Attachment[]): Attachment[] {
    if (images.length) {
      this.sql.exec("INSERT OR REPLACE INTO meta VALUES ('images', ?)", JSON.stringify(images))
      return images
    }
    return JSON.parse(this.meta('images') || '[]')
  }

  private meta(key: string) {
    return this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', key).toArray()[0]?.v ?? ''
  }

  private chat(): ChatEntry[] {
    return this.sql.exec<{ entry: string }>('SELECT entry FROM shop_chat ORDER BY seq').toArray().map((r) => JSON.parse(r.entry))
  }

  private pushChat(entry: ChatEntry) {
    const index = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM shop_chat').one().n
    this.sql.exec('INSERT INTO shop_chat VALUES (?, ?)', index, JSON.stringify(entry))
    this.broadcast({ type: 'chat', entry, index })
    return index
  }

  private saveChat(index: number, entry: ChatEntry) {
    this.sql.exec('UPDATE shop_chat SET entry = ? WHERE seq = ?', JSON.stringify(entry), index)
  }

  private history(): HistoryItem[] {
    return this.sql.exec<{ item: string }>('SELECT item FROM shop_history ORDER BY seq').toArray().map((r) => JSON.parse(r.item))
  }

  private appendHistory(item: HistoryItem) {
    this.sql.exec('INSERT INTO shop_history (item) VALUES (?)', JSON.stringify(item))
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

function toInfo(r: ModelRow): ModelInfo {
  return {
    id: r.id,
    label: r.label,
    provider: r.provider,
    model: r.model,
    baseUrl: r.base_url ?? undefined,
    accountId: r.account_id ?? undefined,
    vision: !!r.vision,
    keyHint: r.api_key.length > 8 ? `…${r.api_key.slice(-4)}` : '…',
    isDefault: !!r.is_default,
    createdAt: r.created_at,
  }
}

const toProject = (r: ProjectRow): ProjectInfo => ({ id: r.id, name: r.name, parts: r.parts, updatedAt: r.updated_at, thumb: r.thumb ?? undefined })

function hashOf(text: string) {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
  return h
}
