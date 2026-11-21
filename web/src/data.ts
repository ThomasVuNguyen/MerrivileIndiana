import type { BufferGeometry } from 'three'
import generatorSource from '../../tools/gen_models.py?raw'
import type { Attachment, CallState, ChangeNote, FaceRef, PartDoc } from '../shared/protocol'

export type Part = {
  id: string
  name: string
  // Sub-assembly the part is used in.
  group: string
  qty: number
  color: string
  material: string
  volume_mm3: number
  mass_g: number
  bbox: [number, number, number]
  faces: number
  fn?: string
  // Imported parts carry their tessellated geometry instead of a URL.
  geometry?: BufferGeometry
  source: 'build123d' | 'step'
  // Parts the AI built in a live project carry their document.
  live?: PartDoc
}

export type Appearance = { color: string; opacity: number; visible: boolean }

export type ToolCall = Omit<CallState, 'id'> & { id?: string }

export type Message =
  | { role: 'user'; text: string; faces?: FaceRef[]; images?: Attachment[] }
  | { role: 'ai'; text: string; calls?: ToolCall[]; model?: string; error?: boolean; notes?: ChangeNote[]; startedAt?: number; ms?: number }

export type Motion = 'fixed' | 'rotor' | 'carrier' | 'planet'

/** A placed copy of a part in the assembly. */
export type Instance = {
  id: string
  part: string
  group: string
  pos: [number, number, number]
  rot: number
  motion: Motion
}

export type Interference = { a: string; b: string; volume_mm3: number; at: [number, number, number]; mesh: string }

export type Assembly = {
  name: string
  parts: Part[]
  instances: Instance[]
  groups: string[]
  gears: { sun: number; planet: number; ring: number }
  checks: { pose_deg: number; interferences: Interference[] }
}

// Offset along the motor axis (mm) for the exploded view, per part, so
// nested parts (planets inside the ring gear) come apart too.
export const EXPLODE: Record<string, number> = {
  'encoder-board': -48,
  'encoder-magnet': -30,
  'rear-cover': -16,
  housing: 0,
  'stator-core': 34,
  'rotor-can': 62,
  magnet: 62,
  'ring-gear': 84,
  planet: 102,
  'sun-gear': 102,
  carrier: 116,
  bearing: 130,
  'output-flange': 146,
}

type Manifest = Omit<Assembly, 'parts' | 'instances' | 'groups'> & {
  parts: Omit<Part, 'source' | 'group'>[]
  groups: { name: string; instances: Omit<Instance, 'group'>[] }[]
}

export async function loadAssembly(): Promise<Assembly> {
  const m = (await (await fetch('/models/manifest.json')).json()) as Manifest
  const instances = m.groups.flatMap((g) => g.instances.map((i) => ({ ...i, group: g.name })))
  const parts = m.parts.map((p) => ({
    ...p,
    group: instances.find((i) => i.part === p.id)?.group ?? '',
    source: 'build123d' as const,
  }))
  return { ...m, parts, instances, groups: m.groups.map((g) => g.name) }
}

export function partFromDoc(doc: PartDoc): Part {
  const m = doc.metrics
  return {
    id: doc.id,
    name: doc.name,
    group: 'Parts',
    qty: 1,
    color: doc.color,
    material: doc.material,
    volume_mm3: m?.volume_mm3 ?? 0,
    mass_g: m ? +((m.volume_mm3 / 1000) * doc.density).toFixed(1) : 0,
    bbox: m ? (m.bbox.size.map((v) => +v.toFixed(2)) as Part['bbox']) : [0, 0, 0],
    faces: m?.faces ?? 0,
    source: 'build123d',
    live: doc,
  }
}

/** Rotor angle → carrier angle and planet self-spin, for a fixed ring gear. */
export function gearTrain(rotorDeg: number, g: Assembly['gears']) {
  const ratio = 1 + g.ring / g.sun
  const carrier = rotorDeg / ratio
  return { ratio, carrier, planetSpin: -(rotorDeg - carrier) * (g.sun / g.planet) }
}

/** The build123d function that produced a part, sliced out of the generator. */
export function sourceFor(fn?: string): string {
  if (!fn) return ''
  const lines = generatorSource.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`def ${fn}(`))
  if (start < 0) return ''
  let end = start + 1
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end] === '')) end++
  return lines.slice(start, end).join('\n').trimEnd()
}

export const VERSIONS = [
  { id: 'v14', label: 'Crossed roller bearing, 24 rollers', when: '2 min ago', who: 'AI' },
  { id: 'v13', label: 'Ring gear 36T, 2.2 mm tooth depth', when: '9 min ago', who: 'AI' },
  { id: 'v12', label: 'Housing bosses moved to 22.5°', when: '14 min ago', who: 'AI' },
  { id: 'v11', label: 'Imported encoder-board.step', when: '1 h ago', who: 'Thomas' },
  { id: 'v10', label: 'Split into 6 sub-assemblies', when: '1 h ago', who: 'AI' },
]

export const TRANSCRIPT: Message[] = [
  {
    role: 'user',
    text: 'Build a 110 mm quasi-direct-drive actuator: outrunner with 12 stator teeth, 14 magnets, a 1-stage planetary and a crossed roller bearing on the output.',
  },
  {
    role: 'ai',
    text: 'Built it as 13 parts placed 28 times across 6 sub-assemblies. The rotor drives the sun gear; the carrier and output flange turn at 3.57:1.',
    calls: [
      { tool: 'build123d', detail: 'housing() · stator() · rotor_can()', ms: 2140, state: 'done' },
      { tool: 'build123d', detail: 'sun_gear() · planets() · ring_gear()', ms: 3810, state: 'done' },
      { tool: 'assemble', detail: '13 parts · 28 instances', ms: 610, state: 'done' },
    ],
  },
  { role: 'user', text: 'The ring gear teeth look too shallow, and add a bearing between carrier and flange.' },
  {
    role: 'ai',
    text: 'Ring gear is now 36T with 2.2 mm teeth. Added a crossed roller bearing (100 × 62 × 7, 24 rollers) seated on the housing lip.',
    calls: [
      { tool: 'build123d', detail: 'ring_gear() · 147 faces', ms: 1240, state: 'done' },
      { tool: 'build123d', detail: 'bearing() · 68 faces', ms: 1880, state: 'done' },
      { tool: 'mass', detail: 'assembly 1.36 kg', ms: 90, state: 'done' },
    ],
  },
]

export const SWATCHES = ['#b9bcc2', '#3f444b', '#2f6fd6', '#d26b3f', '#c8a24a', '#2f8a4c', '#f2f2ef']
