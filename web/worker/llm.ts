// Provider-neutral conversation history and the model adapter interface.
// History is append-only: provider-native assistant turns are kept verbatim in
// `raw` so the same provider gets them back byte-for-byte (thinking blocks,
// prompt cache), and other providers get the neutral blocks.

import type { Provider } from '../shared/protocol'
import type { Usage } from './langfuse'

// Attachments are stored by R2 key and loaded (hydrated) just before a model call,
// so history rows stay small. Renders from tool results carry their data inline.
export type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data?: string; key?: string }
  | { type: 'document'; mediaType: 'application/pdf'; name: string; data?: string; key?: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }

export type ToolResult = { id: string; content: Block[]; isError?: boolean }

export type HistoryItem =
  | { role: 'user'; content: Block[] }
  | { role: 'assistant'; content: Block[]; raw?: { provider: Provider; model: string; content: unknown[] } }
  | { role: 'tool'; results: ToolResult[] }

export type ToolSpec = { name: string; description: string; schema: Record<string, unknown> }

export type ModelConfig = {
  provider: Provider
  model: string
  apiKey: string
  baseUrl?: string
  accountId?: string
  vision: boolean
}

export type Turn = {
  content: Block[]
  raw?: { provider: Provider; model: string; content: unknown[] }
  stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'
  detail?: string
}

export type TurnRequest = {
  system: string
  tools: ToolSpec[]
  history: HistoryItem[]
  signal: AbortSignal
  onText: (delta: string) => void
  /** Called once per API call, including failed and retried ones, so every billed token is logged. */
  onCall?: (call: ApiCall) => void
}

/** One request to a model API, as it gets logged. */
export type ApiCall = {
  model: string
  startTime: Date
  endTime: Date
  firstTokenAt?: Date
  usage?: Usage
  /** Output tokens were estimated from streamed characters because the call didn't finish. */
  estimated?: boolean
  output?: unknown
  stopReason?: string
  /** Hidden reasoning tokens, already included in usage.output. */
  thinkingTokens?: number
  error?: string
  params: Record<string, string | number | boolean>
}

export interface ModelAdapter {
  turn(req: TurnRequest): Promise<Turn>
  /** Cheap credential + model check for the settings page. */
  ping(signal: AbortSignal, onCall?: (call: ApiCall) => void): Promise<string>
}

/** Thrown for failures the user can fix (bad key, unknown model), shown verbatim. */
export class ModelError extends Error {}

export function toolCalls(content: Block[]) {
  return content.filter((b): b is Extract<Block, { type: 'tool_call' }> => b.type === 'tool_call')
}

export function textOf(content: Block[]) {
  return content
    .filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
