// Langfuse tracing through its public ingestion API (plain fetch; the OTel SDK
// doesn't suit Durable Objects). Events are collected during a run and sent in
// one go at the end. Never put API keys or cookies in an event.

import type { Env } from './env'
import type { Block, HistoryItem } from './llm'

export type Usage = {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

type Event = { id: string; timestamp: string; type: string; body: Record<string, unknown> }

// $ per million tokens, for models this Langfuse instance has no prices for.
// Cache writes are the 5-minute TTL (1.25× input).
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

const MAX_BATCH_BYTES = 3_000_000
const MAX_FIELD_CHARS = 60_000

export class Trace {
  readonly id = crypto.randomUUID()
  private events: Event[] = []
  private readonly started = new Date()

  constructor(
    private env: Env,
    private base: { name: string; userId?: string; sessionId?: string; input?: unknown; metadata?: Record<string, unknown>; tags?: string[] },
  ) {}

  get enabled() {
    return !!(this.env.LANGFUSE_PUBLIC_KEY && this.env.LANGFUSE_SECRET_KEY && this.env.LANGFUSE_BASE_URL)
  }

  generation(g: {
    name: string
    model: string
    startTime: Date
    endTime: Date
    completionStartTime?: Date
    input: unknown
    output: unknown
    usage?: Usage
    modelParameters?: Record<string, string | number | boolean>
    level?: 'DEFAULT' | 'WARNING' | 'ERROR'
    statusMessage?: string
    metadata?: Record<string, unknown>
  }) {
    const u = g.usage
    const usageDetails = u
      ? {
          input: u.input,
          output: u.output,
          ...(u.cacheRead !== undefined && { cache_read_input_tokens: u.cacheRead }),
          ...(u.cacheWrite !== undefined && { cache_creation_input_tokens: u.cacheWrite }),
          total: u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
        }
      : undefined
    this.push('generation-create', {
      name: g.name,
      model: g.model,
      startTime: g.startTime.toISOString(),
      endTime: g.endTime.toISOString(),
      completionStartTime: g.completionStartTime?.toISOString(),
      input: clip(g.input),
      output: clip(g.output),
      usageDetails,
      costDetails: u ? cost(g.model, u) : undefined,
      modelParameters: g.modelParameters,
      level: g.level ?? 'DEFAULT',
      statusMessage: g.statusMessage,
      metadata: g.metadata,
    })
  }

  span(s: { name: string; startTime: Date; endTime: Date; input?: unknown; output?: unknown; level?: 'DEFAULT' | 'WARNING' | 'ERROR'; statusMessage?: string; metadata?: Record<string, unknown> }) {
    this.push('span-create', {
      name: s.name,
      startTime: s.startTime.toISOString(),
      endTime: s.endTime.toISOString(),
      input: clip(s.input),
      output: clip(s.output),
      level: s.level ?? 'DEFAULT',
      statusMessage: s.statusMessage,
      metadata: s.metadata,
    })
  }

  /** Sends the trace and everything recorded under it. Failures are logged, never thrown. */
  async end(result: { output?: unknown; level?: 'DEFAULT' | 'WARNING' | 'ERROR'; metadata?: Record<string, unknown> }) {
    if (!this.enabled) return
    const trace: Event = {
      id: crypto.randomUUID(),
      timestamp: this.started.toISOString(),
      type: 'trace-create',
      body: {
        id: this.id,
        timestamp: this.started.toISOString(),
        name: this.base.name,
        userId: this.base.userId,
        sessionId: this.base.sessionId,
        input: clip(this.base.input),
        output: clip(result.output),
        tags: this.base.tags,
        metadata: { ...this.base.metadata, ...result.metadata, level: result.level ?? 'DEFAULT' },
      },
    }
    const all = [trace, ...this.events]
    this.events = []
    const auth = `Basic ${btoa(`${this.env.LANGFUSE_PUBLIC_KEY}:${this.env.LANGFUSE_SECRET_KEY}`)}`
    const url = `${this.env.LANGFUSE_BASE_URL!.replace(/\/+$/, '')}/api/public/ingestion`
    for (const batch of batches(all)) {
      try {
        const res = await fetch(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ batch }) })
        const body = (await res.json().catch(() => ({}))) as { errors?: { id: string; status: number; message?: string }[] }
        if (!res.ok || body.errors?.length) console.error('langfuse ingestion', res.status, JSON.stringify(body.errors ?? body).slice(0, 1000))
      } catch (err) {
        console.error('langfuse unreachable', (err as Error).message)
      }
    }
  }

  private push(type: string, body: Record<string, unknown>) {
    const id = crypto.randomUUID()
    this.events.push({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), type, body: { id, traceId: this.id, ...body } })
  }
}

function cost(model: string, u: Usage) {
  const p = PRICES[model]
  if (!p) return undefined
  const input = (u.input * p.input) / 1e6
  const output = (u.output * p.output) / 1e6
  const cacheRead = ((u.cacheRead ?? 0) * p.cacheRead) / 1e6
  const cacheWrite = ((u.cacheWrite ?? 0) * p.cacheWrite) / 1e6
  return { input, output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, total: input + output + cacheRead + cacheWrite }
}

/** History items as Langfuse input: images become a size note instead of base64. */
export function forLog(items: HistoryItem[]) {
  return items.map((item) =>
    item.role === 'tool'
      ? { role: 'tool', results: item.results.map((r) => ({ id: r.id, isError: r.isError, content: r.content.map(blockForLog) })) }
      : { role: item.role, content: item.content.map(blockForLog) },
  )
}

export function blockForLog(b: Block) {
  if (b.type === 'image' || b.type === 'document') {
    const what = b.type === 'image' ? 'image' : `PDF "${b.name}"`
    return { type: b.type, note: b.data ? `${Math.round((b.data.length * 3) / 4 / 1024)} KB ${what} sent to the model` : `${what} from ${b.key}` }
  }
  return b
}

function clip(value: unknown): unknown {
  if (value === undefined) return undefined
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= MAX_FIELD_CHARS) return value
  return `${text.slice(0, MAX_FIELD_CHARS)}… [${text.length - MAX_FIELD_CHARS} more characters]`
}

function* batches(events: Event[]) {
  let batch: Event[] = []
  let size = 0
  for (const e of events) {
    const n = JSON.stringify(e).length
    if (batch.length && size + n > MAX_BATCH_BYTES) {
      yield batch
      batch = []
      size = 0
    }
    batch.push(e)
    size += n
  }
  if (batch.length) yield batch
}
