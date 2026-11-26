// Analysis runs for outside agents (MCP): code that loads the project's parts with part(id),
// components with component(id) and placed assemblies with assembly(id), measures, checks fits and
// renders, without saving anything.

import type { BuildError, PartMetrics } from '../shared/protocol'
import { geometryJson } from './components'
import type { ComponentRef } from './components'
import type { Env } from './env'
import type { Block } from './llm'

export type View = string | { name?: string; dir: number[]; up?: number[] }

/** Cut the picture with a plane n·p = offset (default through the middle), keeping one side. */
export type Section = { normal: number[] | 'x' | 'y' | 'z'; offset?: number; keep?: 'below' | 'above' }

export type InspectRequest = {
  code: string
  /** Part id → the build123d source of its last good build. */
  parts?: Record<string, string>
  /** Asset name → base64, e.g. an imported STEP a part reads. */
  assets?: Record<string, string>
  /** Part id → its display colour, so each part shows in its own colour. */
  colors?: Record<string, string>
  /** Components the code names, for component(id). */
  components?: ComponentRef[]
  /** Assembly id → its placed leaves ({path, name, key, matrix}), for assembly(id). */
  assemblies?: Record<string, unknown[]>
  views?: View[]
  size?: number
  section?: Section
  timeout?: number
}

type InspectOut =
  | { ok: true; ms: number; stdout: string; report?: unknown; metrics?: PartMetrics; render?: string }
  | { ok: false; ms: number; stdout: string; error: BuildError }

/** Runs the code in the geometry service and turns the answer into tool-result blocks. */
export async function runInspect(env: Env, req: InspectRequest, signal?: AbortSignal): Promise<{ content: Block[]; isError?: boolean; summary: string; png?: string }> {
  const { components, ...body } = req
  const out = await geometryJson<InspectOut>(env, '/inspect', { timeout: 120, ...body }, components ?? [], signal)
  const stdout = out.stdout ? `\nstdout:\n${out.stdout}` : ''
  if (!out.ok) {
    const e = out.error
    const trace = e.trace.map((t) => `  line ${t.line}: ${t.code}`).join('\n')
    return { isError: true, summary: `${e.type}${e.line ? ` line ${e.line}` : ''}`, content: [{ type: 'text', text: `Inspection failed after ${(out.ms / 1000).toFixed(1)} s.\n${e.type}: ${e.message}${trace ? `\n${trace}` : ''}${stdout}` }] }
  }
  const lines = [`Ran in ${(out.ms / 1000).toFixed(1)} s.${stdout}`]
  if (out.report !== undefined) lines.push(`report:\n${JSON.stringify(out.report, null, 2)}`)
  if (out.metrics) lines.push(`result (full precision, mm):\n${JSON.stringify(out.metrics, null, 2)}`)
  const content: Block[] = [{ type: 'text', text: lines.join('\n') }]
  if (out.render) content.push({ type: 'image', mediaType: 'image/png', data: out.render })
  return { content, summary: out.metrics ? `${out.metrics.solids} solids · ${out.metrics.faces} faces` : 'measured', png: out.render }
}
