import Anthropic from '@anthropic-ai/sdk'
import type { Usage } from './langfuse'
import type { Block, HistoryItem, ModelAdapter, ModelConfig, ToolSpec, Turn, TurnRequest } from './llm'
import { ModelError } from './llm'

type Param = Anthropic.Beta.Messages.BetaMessageParam
type ContentParam = Anthropic.Beta.Messages.BetaContentBlockParam

// Adaptive thinking and effort exist on these families; older models reject them.
const ADAPTIVE = /^claude-(fable-5|mythos-5|opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|haiku-5)/
// Server-side refusal fallback (`fallbacks: "default"`) is accepted on these.
const FALLBACK = /^claude-(opus-5(-5)?|fable-5-1|sonnet-5-5)$/

export class AnthropicAdapter implements ModelAdapter {
  private client: Anthropic

  constructor(private cfg: ModelConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 2 })
  }

  // Lists the model, which costs no tokens.
  async ping(signal: AbortSignal) {
    try {
      const m = await this.client.models.retrieve(this.cfg.model, {}, { signal })
      return m.display_name
    } catch (err) {
      throw explain(err, this.cfg.model)
    }
  }

  async turn(req: TurnRequest): Promise<Turn> {
    const model = this.cfg.model
    const betas = [
      ...(FALLBACK.test(model) ? ['server-side-fallback-2026-07-01'] : []),
      // Streams a running count of hidden thinking tokens, so a stopped call can still be logged.
      ...(ADAPTIVE.test(model) ? ['thinking-token-count-2026-05-13'] : []),
    ]
    const params: Anthropic.Beta.Messages.MessageCreateParamsStreaming = {
      model,
      max_tokens: 64000,
      stream: true,
      system: req.system,
      // Caches the whole prefix (system, tools, history) up to the newest block.
      cache_control: { type: 'ephemeral' },
      ...(req.tools.length && { tools: req.tools.map((t) => toTool(t)) }),
      messages: toMessages(req.history),
      ...(ADAPTIVE.test(model) ? { thinking: { type: 'adaptive' as const }, output_config: { effort: 'high' as const } } : {}),
      ...(FALLBACK.test(model) ? { fallbacks: 'default' as const } : {}),
      ...(betas.length && { betas }),
    }
    // With eager input streaming a tool input can arrive as JSON the SDK cannot
    // parse; that rejects finalMessage(). Re-issue the turn a couple of times.
    const logParams = { max_tokens: params.max_tokens, ...(ADAPTIVE.test(model) && { thinking: 'adaptive', effort: 'high' }), ...(FALLBACK.test(model) && { fallbacks: 'default' }) }
    for (let attempt = 0; ; attempt++) {
      const startTime = new Date()
      // Usage as the stream reports it, so a call that fails midway is still counted.
      let served = model
      let usage: Usage | undefined
      let firstTokenAt: Date | undefined
      let streamedChars = 0
      let thinkingEstimate = 0
      try {
        const stream = this.client.beta.messages.stream(params, { signal: req.signal })
        stream.on('text', (delta) => req.onText(delta))
        stream.on('streamEvent', (event) => {
          if (event.type === 'message_start') {
            served = event.message.model
            const u = event.message.usage
            usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 }
          } else if (event.type === 'content_block_delta') {
            firstTokenAt ??= new Date()
            const d = event.delta as { text?: string; partial_json?: string; thinking?: string; estimated_tokens?: number | null }
            streamedChars += (d.text ?? d.partial_json ?? d.thinking ?? '').length
            thinkingEstimate += d.estimated_tokens ?? 0
          } else if (event.type === 'message_delta' && usage) usage.output = event.usage.output_tokens
        })
        const message = await stream.finalMessage()
        const u = message.usage
        const turn = toTurn(message, model)
        req.onCall?.({
          model: message.model,
          startTime,
          endTime: new Date(),
          firstTokenAt,
          usage: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
          output: message.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking'),
          stopReason: message.stop_reason ?? undefined,
          thinkingTokens: u.output_tokens_details?.thinking_tokens ?? undefined,
          params: logParams,
        })
        return turn
      } catch (err) {
        // The API bills what it generated before the failure; output is estimated when it never reported a total.
        const partial = usage && { ...usage, output: Math.max(usage.output, Math.ceil(streamedChars / 4) + thinkingEstimate) }
        req.onCall?.({
          model: served,
          startTime,
          endTime: new Date(),
          firstTokenAt,
          usage: partial,
          estimated: !!partial && partial.output !== usage?.output,
          thinkingTokens: thinkingEstimate || undefined,
          error: req.signal.aborted ? 'stopped by the person' : (err as Error).message,
          params: logParams,
        })
        if (req.signal.aborted) throw err
        if (err instanceof Anthropic.APIError || attempt >= 2) throw explain(err, model)
      }
    }
  }
}

function toTool(t: ToolSpec): Anthropic.Beta.Messages.BetaTool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.schema as Anthropic.Beta.Messages.BetaTool.InputSchema,
    // Part sources are long; stream them instead of waiting for the whole string.
    eager_input_streaming: true,
  }
}

function toTurn(message: Anthropic.Beta.Messages.BetaMessage, model: string): Turn {
  const content: Block[] = []
  for (const b of message.content) {
    if (b.type === 'text') content.push({ type: 'text', text: b.text })
    else if (b.type === 'tool_use') content.push({ type: 'tool_call', id: b.id, name: b.name, input: b.input })
  }
  const stop =
    message.stop_reason === 'end_turn' ? 'end'
    : message.stop_reason === 'tool_use' ? 'tool_use'
    : message.stop_reason === 'max_tokens' ? 'max_tokens'
    : message.stop_reason === 'refusal' ? 'refusal'
    : 'other'
  return {
    content,
    raw: { provider: 'anthropic', model, content: message.content },
    stop,
    detail: message.stop_reason === 'refusal' ? message.stop_details?.explanation ?? undefined : undefined,
  }
}

function toMessages(history: HistoryItem[]): Param[] {
  return history.map((item): Param => {
    if (item.role === 'user') return { role: 'user', content: item.content.map(toContent) }
    if (item.role === 'tool')
      return {
        role: 'user',
        content: item.results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: safeId(r.id),
          is_error: r.isError || undefined,
          content: r.content.map(toContent) as Anthropic.Beta.Messages.BetaToolResultBlockParam['content'],
        })),
      }
    // Our own turns go back unchanged, thinking blocks included.
    if (item.raw?.provider === 'anthropic') return { role: 'assistant', content: item.raw.content as ContentParam[] }
    return { role: 'assistant', content: item.content.map(toContent) }
  })
}

function toContent(b: Block): ContentParam {
  if (b.type === 'text') return { type: 'text', text: b.text }
  if (b.type === 'image') return { type: 'image', source: { type: 'base64', media_type: b.mediaType as 'image/png', data: b.data ?? '' } }
  if (b.type === 'document') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b.data ?? '' }, title: b.name }
  return { type: 'tool_use', id: safeId(b.id), name: b.name, input: b.input as Record<string, unknown> }
}

// Tool call ids from other providers may contain characters Anthropic rejects.
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_')

function explain(err: unknown, model: string): Error {
  if (err instanceof Anthropic.AuthenticationError) return new ModelError('Anthropic rejected the API key (401). Update it in Settings → Models.')
  if (err instanceof Anthropic.PermissionDeniedError) return new ModelError(`This API key can't use ${model} (403).`)
  if (err instanceof Anthropic.NotFoundError) return new ModelError(`Anthropic doesn't know the model "${model}". Check the model id in Settings → Models.`)
  if (err instanceof Anthropic.RateLimitError) return new ModelError('Anthropic is rate limiting this key. Try again in a minute.')
  if (err instanceof Anthropic.BadRequestError) return new ModelError(`Anthropic rejected the request: ${err.message}`)
  if (err instanceof Anthropic.APIConnectionError) return new ModelError("Couldn't reach api.anthropic.com.")
  if (err instanceof Anthropic.APIError) return new ModelError(`Anthropic error ${err.status}: ${err.message}`)
  return err instanceof Error ? err : new Error(String(err))
}
