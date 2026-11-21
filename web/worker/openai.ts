// OpenAI-compatible chat completions: Cloudflare Workers AI, OpenRouter, local
// servers. Tool results can't carry images in this API, so renders follow the
// tool messages as a user message when the model can see.

import type { Usage } from './langfuse'
import type { ApiCall, Block, HistoryItem, ModelAdapter, ModelConfig, Turn, TurnRequest } from './llm'
import { ModelError } from './llm'

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export function baseUrlFor(cfg: Pick<ModelConfig, 'provider' | 'baseUrl' | 'accountId'>) {
  if (cfg.provider === 'workers-ai') return `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/ai/v1`
  return (cfg.baseUrl ?? '').replace(/\/+$/, '')
}

export class OpenAICompatAdapter implements ModelAdapter {
  constructor(private cfg: ModelConfig) {}

  async ping(signal: AbortSignal, onCall?: (call: ApiCall) => void) {
    const startTime = new Date()
    const res = await this.post({ model: this.cfg.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }, signal)
    const body = (await res.json()) as { model?: string; choices?: { message?: { content?: string } }[]; usage?: OpenAIUsage }
    onCall?.({ model: body.model ?? this.cfg.model, startTime, endTime: new Date(), usage: usageOf(body.usage), output: body.choices?.[0]?.message?.content, params: { max_tokens: 8 } })
    if (!body.choices?.length) throw new ModelError('The endpoint answered, but not with a chat completion.')
    return this.cfg.model
  }

  async turn(req: TurnRequest): Promise<Turn> {
    const startTime = new Date()
    let firstTokenAt: Date | undefined
    let served = this.cfg.model
    let usage: Usage | undefined
    let text = ''
    let finish = ''
    let streamedChars = 0
    const calls: { id: string; name: string; args: string }[] = []
    const params = { stream: true, include_usage: true }
    try {
      const res = await this.post(
        {
          model: this.cfg.model,
          stream: true,
          // The final chunk carries token usage.
          stream_options: { include_usage: true },
          messages: [{ role: 'system', content: req.system }, ...this.toMessages(req.history)],
          ...(req.tools.length && { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })) }),
        },
        req.signal,
      )
      for await (const raw of sse(res.body!)) {
        const chunk = raw as { model?: string; choices?: ChoiceDelta[]; usage?: OpenAIUsage }
        if (chunk.model) served = chunk.model
        if (chunk.usage) usage = usageOf(chunk.usage)
        const choice = chunk.choices?.[0]
        if (!choice) continue
        const d = choice.delta ?? {}
        if (d.content) {
          firstTokenAt ??= new Date()
          text += d.content
          streamedChars += d.content.length
          req.onText(d.content)
        }
        for (const tc of d.tool_calls ?? []) {
          firstTokenAt ??= new Date()
          const slot = (calls[tc.index ?? 0] ??= { id: '', name: '', args: '' })
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name += tc.function.name
          if (tc.function?.arguments) {
            slot.args += tc.function.arguments
            streamedChars += tc.function.arguments.length
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason
      }
    } catch (err) {
      req.onCall?.({
        model: served,
        startTime,
        endTime: new Date(),
        firstTokenAt,
        usage: usage ?? (streamedChars ? { input: 0, output: Math.ceil(streamedChars / 4) } : undefined),
        estimated: !usage && streamedChars > 0,
        error: req.signal.aborted ? 'stopped by the person' : (err as Error).message,
        params,
      })
      throw err
    }
    const content: Block[] = []
    if (text) content.push({ type: 'text', text })
    calls.forEach((c, i) => {
      let input: unknown
      try {
        input = c.args ? JSON.parse(c.args) : {}
      } catch {
        input = { __invalid_json: c.args }
      }
      content.push({ type: 'tool_call', id: c.id || `call_${Date.now()}_${i}`, name: c.name, input })
    })
    const stop = calls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : 'end'
    req.onCall?.({
      model: served,
      startTime,
      endTime: new Date(),
      firstTokenAt,
      // Some endpoints ignore include_usage; then the output side is estimated from what streamed.
      usage: usage ?? { input: 0, output: Math.ceil(streamedChars / 4) },
      estimated: !usage,
      output: content,
      stopReason: finish,
      params,
    })
    return { content, stop }
  }

  private toMessages(history: HistoryItem[]): ChatMessage[] {
    const out: ChatMessage[] = []
    for (const item of history) {
      if (item.role === 'user') out.push({ role: 'user', content: this.userContent(item.content) })
      else if (item.role === 'assistant') {
        const text = item.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('')
        const calls = item.content.filter((b): b is Extract<Block, { type: 'tool_call' }> => b.type === 'tool_call')
        out.push({
          role: 'assistant',
          content: text || null,
          ...(calls.length && { tool_calls: calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } })) }),
        })
      } else {
        const images: Block[] = []
        for (const r of item.results) {
          const text = r.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n')
          out.push({ role: 'tool', tool_call_id: r.id, content: (r.isError ? 'ERROR: ' : '') + text })
          images.push(...r.content.filter((b) => b.type === 'image'))
        }
        if (images.length && this.cfg.vision) out.push({ role: 'user', content: this.userContent([{ type: 'text', text: 'Renders from the tool results above:' }, ...images]) })
      }
    }
    return out
  }

  private userContent(blocks: Block[]): string | ContentPart[] {
    const parts: ContentPart[] = []
    for (const b of blocks) {
      if (b.type === 'text') parts.push({ type: 'text', text: b.text })
      else if (b.type === 'image' && this.cfg.vision && b.data) parts.push({ type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } })
      else if (b.type === 'document') parts.push({ type: 'text', text: `[PDF "${b.name}" attached; this endpoint can't read PDFs]` })
    }
    return parts.every((p) => p.type === 'text') ? parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') : parts
  }

  private async post(body: unknown, signal: AbortSignal) {
    const url = `${baseUrlFor(this.cfg)}/chat/completions`
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      if (signal.aborted) throw err
      throw new ModelError(`Couldn't reach ${new URL(url).host}.`)
    }
    if (res.ok) return res
    const detail = (await res.text()).slice(0, 400)
    if (res.status === 401 || res.status === 403) throw new ModelError(`The endpoint rejected the API token (${res.status}). ${detail}`)
    if (res.status === 404) throw new ModelError(`Not found (404): check the model id and ${this.cfg.provider === 'workers-ai' ? 'account id' : 'base URL'}. ${detail}`)
    if (res.status === 429) throw new ModelError('The endpoint is rate limiting this key. Try again in a minute.')
    throw new ModelError(`The endpoint returned ${res.status}: ${detail}`)
  }
}

type OpenAIUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }

function usageOf(u?: OpenAIUsage): Usage | undefined {
  if (!u) return undefined
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0
  return { input: (u.prompt_tokens ?? 0) - cached, output: u.completion_tokens ?? 0, cacheRead: cached }
}

type ChoiceDelta = {
  delta?: { content?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }
  finish_reason?: string | null
}

async function* sse(body: ReadableStream<Uint8Array>) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        yield JSON.parse(data) as unknown
      } catch {
        // Keep-alive comments and partial lines are skipped.
      }
    }
  }
}
