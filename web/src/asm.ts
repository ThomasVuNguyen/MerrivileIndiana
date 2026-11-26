// Reading a live assembly: instance paths, nested sub-assemblies, looks and findings.

import type { AssemblyDoc, AssemblyInstance, Finding } from '../shared/protocol'
import type { InstanceLook } from './workspace'

/** Is `path` the instance `at`, or inside it (a sub-assembly)? */
export const within = (path: string, at: string) => path === at || path.startsWith(`${at}/`)

/** Its look in this browser: hidden if it or a sub-assembly holding it is; its colour or the nearest one set above it. */
export function lookOf(looks: Record<string, InstanceLook>, asm: string, path: string): InstanceLook {
  const parts = path.split('/')
  let out: InstanceLook = {}
  for (let i = 1; i <= parts.length; i++) {
    const l = looks[`${asm}/${parts.slice(0, i).join('/')}`]
    if (!l) continue
    out = { color: l.color ?? out.color, hidden: out.hidden || l.hidden }
  }
  return out
}

/** The instance at a path ("pi", or "camera/cam" inside a sub-assembly) and the assembly holding it. */
export function instanceAt(doc: AssemblyDoc, path: string, all: AssemblyDoc[]): { inst: AssemblyInstance; owner: AssemblyDoc } | null {
  const [head, ...rest] = path.split('/')
  const inst = doc.instances.find((i) => i.id === head)
  if (!inst) return null
  if (!rest.length) return { inst, owner: doc }
  if (!('assembly' in inst.ref)) return null
  const sub = all.find((a) => a.id === (inst.ref as { assembly: string }).assembly)
  return sub ? instanceAt(sub, rest.join('/'), all) : null
}

/** "part base v3", "component pi-zero-2w", "assembly camera-module". */
export function refKind(inst: AssemblyInstance) {
  if ('part' in inst.ref) return 'part'
  if ('component' in inst.ref) return 'component'
  return 'sub-assembly'
}

export const FINDING_LABEL: Record<Finding['kind'], string> = {
  clash: 'clash',
  tight_gap: 'tight gap',
  contact: 'contact',
  floating: 'floating',
  keepout: 'keep-out',
  unresolved: 'unresolved',
  pattern_fit: 'pattern fit',
  snap_conflict: 'snap conflict',
  requirement: 'requirement',
  snap: 'snap',
  ground: 'ground',
  error: 'error',
}

/** Findings by index into the report, warnings first, biggest value first within a kind. */
export function sortedFindings(doc: AssemblyDoc) {
  const all = (doc.report?.findings ?? []).map((f, i) => ({ f, i }))
  return all.sort((a, b) => (a.f.severity === b.f.severity ? 0 : a.f.severity === 'warning' ? -1 : 1) || (a.f.kind === b.f.kind ? (b.f.value ?? 0) - (a.f.value ?? 0) : 0))
}

/** Warnings that name this instance (or something inside it). */
export function warningsFor(doc: AssemblyDoc, path: string) {
  return (doc.report?.findings ?? []).filter((f) => f.severity === 'warning' && f.instances.some((p) => within(p, path) || within(path, p))).length
}

export function fmt(value: number, unit?: string) {
  const digits = unit === 'mm³' ? (value >= 100 ? 0 : 1) : Math.abs(value) >= 10 ? 1 : Math.abs(value) >= 0.1 ? 2 : 3
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`
}

export function ago(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
