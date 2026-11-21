// The agent loop shared by the design chat (Project) and the shop chat
// (Account): call the model, run its tools, repeat. The host owns storage and UI.

import { AnthropicAdapter } from './anthropic'
import { blockForLog, forLog } from './langfuse'
import type { Trace } from './langfuse'
import type { ApiCall, Block, HistoryItem, ModelAdapter, ModelConfig, ToolResult, ToolSpec } from './llm'
import { textOf, toolCalls } from './llm'
import { OpenAICompatAdapter } from './openai'

export const MAX_STEPS = 24
const STOP_NOTE = 'The person stopped this request before I finished. I will not continue it unless they ask.'

export type AgentHost = {
  history(): HistoryItem[]
  append(item: HistoryItem): void
  /** Runs one tool call and returns its result; the host updates its UI. */
  execute(call: Extract<Block, { type: 'tool_call' }>): Promise<ToolResult>
  /** Called after each round of tool calls, e.g. to persist the chat entry. */
  afterRound?(): void
  /** A short label for a tool span in the trace. */
  describe?(callId: string): string | undefined
  /** Loads attachment data stored by key; history rows keep only the key. */
  hydrate?(items: HistoryItem[]): Promise<HistoryItem[]>
}

export type AgentEnd = { end: 'done' | 'refusal' | 'max_tokens' | 'max_steps' | 'stopped'; detail?: string; apiCalls: number }

export async function runAgent(o: {
  cfg: ModelConfig
  system: string
  tools: ToolSpec[]
  host: AgentHost
  signal: AbortSignal
  trace: Trace
  onText: (delta: string) => void
}): Promise<AgentEnd> {
  const adapter: ModelAdapter = o.cfg.provider === 'anthropic' ? new AnthropicAdapter(o.cfg) : new OpenAICompatAdapter(o.cfg)
  // Generations log only what's new since the previous call; the system prompt once per run.
  let logged = Math.max(0, o.host.history().length - 1)
  let apiCalls = 0
  const onCall = (c: ApiCall) => {
    const all = o.host.history()
    const fresh = all.slice(logged)
    logged = all.length
    apiCalls++
    o.trace.generation({
      name: `model call ${apiCalls}`,
      model: c.model,
      startTime: c.startTime,
      endTime: c.endTime,
      completionStartTime: c.firstTokenAt,
      input: { ...(apiCalls === 1 && { system: o.system, tools: o.tools.map((t) => t.name) }), messages: forLog(fresh), historyItems: logged },
      output: c.output,
      usage: c.usage,
      modelParameters: c.params,
      level: c.error ? (c.error === 'stopped by the person' ? 'WARNING' : 'ERROR') : 'DEFAULT',
      statusMessage: c.error,
      metadata: { stopReason: c.stopReason, outputTokensEstimated: c.estimated ?? false, thinkingTokens: c.thinkingTokens, provider: o.cfg.provider },
    })
  }

  // Separate what the model says between tool rounds.
  let gap = false
  let said = false
  const onText = (delta: string) => {
    o.onText(gap && said ? `\n\n${delta}` : delta)
    gap = false
    said = true
  }

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const history = o.host.hydrate ? await o.host.hydrate(o.host.history()) : o.host.history()
      const turn = await adapter.turn({ system: o.system, tools: o.tools, history, signal: o.signal, onCall, onText })
      o.host.append({ role: 'assistant', content: turn.content, raw: turn.raw })
      const calls = toolCalls(turn.content)
      if (calls.length) {
        // Every tool call gets a result, even when we stop here, so the history stays valid.
        const cut = turn.stop === 'max_tokens' || turn.stop === 'refusal'
        const results: ToolResult[] = []
        for (const call of calls) {
          const startTime = new Date()
          const result: ToolResult =
            cut || o.signal.aborted ? { id: call.id, isError: true, content: [{ type: 'text', text: 'Not run: the turn was cut off.' }] } : await o.host.execute(call)
          results.push(result)
          o.trace.span({
            name: call.name,
            startTime,
            endTime: new Date(),
            input: call.input,
            output: result.content.map(blockForLog),
            level: result.isError ? 'WARNING' : 'DEFAULT',
            statusMessage: result.isError ? textOf(result.content).slice(0, 500) : undefined,
            metadata: { callId: call.id, detail: o.host.describe?.(call.id) },
          })
        }
        o.host.append({ role: 'tool', results })
        o.host.afterRound?.()
        gap = true
      }
      if (turn.stop === 'refusal') return { end: 'refusal', detail: turn.detail, apiCalls }
      if (turn.stop === 'max_tokens') return { end: 'max_tokens', apiCalls }
      if (o.signal.aborted) throw new DOMException('stopped', 'AbortError')
      if (!calls.length) return { end: 'done', apiCalls }
    }
    return { end: 'max_steps', apiCalls }
  } catch (err) {
    if (!o.signal.aborted) throw err
    // Close the request in the history too, or the model picks it up again next turn.
    o.host.append({ role: 'assistant', content: [{ type: 'text', text: STOP_NOTE }] })
    return { end: 'stopped', apiCalls }
  }
}

/** The closing line for a run that didn't simply finish. */
export function endNote(r: AgentEnd) {
  if (r.end === 'refusal') return `The model declined this request${r.detail ? `: ${r.detail}` : '.'}`
  if (r.end === 'max_tokens') return "The reply hit the model's output limit. Ask me to continue."
  if (r.end === 'max_steps') return `Stopped after ${MAX_STEPS} rounds of tool calls. Say "continue" to keep going.`
  if (r.end === 'stopped') return 'Stopped.'
  return null
}
