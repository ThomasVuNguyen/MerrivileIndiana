// Assembly guides, shared by the Worker (path checks, step sheets) and the viewer (playback):
// where every leaf is, and how it shows, at any moment of any step. Matrices are row-major 4×4 like
// AssemblyLeaf.matrix; poses are relative to the assembled placement, in the assembly's frame, and
// a pose on a sub-assembly path moves everything in it (outer poses apply after inner ones).

import type { GuideDoc, GuideEase, GuideMotion, GuidePose, GuideStep, Vec3, ViewName } from './protocol'

export type M4 = number[]

export const IDENTITY: M4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
export const ASSEMBLED: GuidePose = { offset: [0, 0, 0] }

/** How long a step without motions holds, and how long an instance added in place takes to fade in. */
export const DWELL = 1.2
export const FADE_IN = 0.4
/** Opacity of what's shown but not in focus, and of instances still to come in a ghosted build guide. */
export const UNFOCUSED = 0.22
export const GHOST = 0.12

/** The camera directions of the named views; the same as geometry/render.py PRESETS. */
export const VIEWS: Record<ViewName, { dir: Vec3; up: Vec3 }> = {
  iso: { dir: [1, -1, 0.8], up: [0, 0, 1] },
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  right: { dir: [1, 0, 0], up: [0, 0, 1] },
  back: { dir: [0, 1, 0], up: [0, 0, 1] },
  left: { dir: [-1, 0, 0], up: [0, 0, 1] },
  bottom: { dir: [0, 0, -1], up: [0, -1, 0] },
  'iso-back': { dir: [-1, 1, 0.8], up: [0, 0, 1] },
  'iso-below': { dir: [1, -1, -0.8], up: [0, 0, 1] },
}

/** Is `path` the instance `at`, or inside it (a sub-assembly)? */
export const within = (path: string, at: string) => path === at || path.startsWith(`${at}/`)

// ---------------------------------------------------------------- vectors and matrices

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const lerp = (a: number, b: number, s: number) => a + (b - a) * s
const lerp3 = (a: Vec3, b: Vec3, s: number): Vec3 => [lerp(a[0], b[0], s), lerp(a[1], b[1], s), lerp(a[2], b[2], s)]

export function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2])
  return l < 1e-12 ? [0, 0, 1] : [v[0] / l, v[1] / l, v[2] / l]
}

export function mul(a: M4, b: M4): M4 {
  const out = new Array<number>(16)
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) out[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c]
  return out
}

export const applyPoint = (m: M4, p: Vec3): Vec3 => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
]

export const applyDir = (m: M4, d: Vec3): Vec3 => normalize([m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]])

const translation = (v: Vec3): M4 => [1, 0, 0, v[0], 0, 1, 0, v[1], 0, 0, 1, v[2], 0, 0, 0, 1]

/** Rotation by `deg` about the unit `axis` through the origin (right hand). */
function rotation(axis: Vec3, deg: number): M4 {
  const [x, y, z] = normalize(axis)
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const t = 1 - c
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c, t * y * z - s * x, 0, t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0, 0, 0, 0, 1]
}

/** The pose as a matrix that takes an assembled placement to the posed one: turn about the pivot, then move. */
export function poseMatrix(p: GuidePose): M4 {
  const move = translation(p.offset)
  if (!p.turn || !p.turn.deg) return move
  const { axis, deg, pivot } = p.turn
  return mul(move, mul(translation(pivot), mul(rotation(axis, deg), translation([-pivot[0], -pivot[1], -pivot[2]]))))
}

export const isAssembled = (p: GuidePose, tol = 1e-6) => Math.hypot(...p.offset) <= tol && (!p.turn || Math.abs(p.turn.deg) <= tol)

// ---------------------------------------------------------------- interpolation

type Quat = [number, number, number, number]

const quatOf = (axis: Vec3, deg: number): Quat => {
  const [x, y, z] = normalize(axis)
  const h = (deg * Math.PI) / 360
  const s = Math.sin(h)
  return [x * s, y * s, z * s, Math.cos(h)]
}

function slerp(a: Quat, b: Quat, s: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  const bb: Quat = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b
  d = Math.abs(d)
  if (d > 0.9995) {
    const q = a.map((v, i) => lerp(v, bb[i], s)) as Quat
    const l = Math.hypot(...q)
    return q.map((v) => v / l) as Quat
  }
  const th = Math.acos(d)
  const wa = Math.sin((1 - s) * th) / Math.sin(th)
  const wb = Math.sin(s * th) / Math.sin(th)
  return a.map((v, i) => v * wa + bb[i] * wb) as Quat
}

/**
 * The pose a fraction `s` of the way from a to b. Turns about the same axis interpolate their
 * angle (so a lid swings on its hinge); turns about different axes slerp; offsets and pivots lerp.
 * s outside 0–1 extrapolates (the "back" ease overshoots).
 */
export function mixPose(a: GuidePose, b: GuidePose, s: number): GuidePose {
  const offset = lerp3(a.offset, b.offset, s)
  if (!a.turn && !b.turn) return { offset }
  const ta = a.turn ?? { ...b.turn!, deg: 0 }
  const tb = b.turn ?? { ...a.turn!, deg: 0 }
  const pivot = lerp3(ta.pivot, tb.pivot, s)
  const ua = normalize(ta.axis)
  const ub = normalize(tb.axis)
  const d = dot(ua, ub)
  if (d > 1 - 1e-9) return { offset, turn: { axis: ub, deg: lerp(ta.deg, tb.deg, s), pivot } }
  if (d < -1 + 1e-9) return { offset, turn: { axis: ub, deg: lerp(-ta.deg, tb.deg, s), pivot } }
  const q = slerp(quatOf(ua, ta.deg), quatOf(ub, tb.deg), Math.max(0, Math.min(1, s)))
  const w = Math.max(-1, Math.min(1, q[3]))
  const sin = Math.sqrt(1 - w * w)
  if (sin < 1e-9) return { offset }
  return { offset, turn: { axis: [q[0] / sin, q[1] / sin, q[2] / sin], deg: (2 * Math.acos(w) * 180) / Math.PI, pivot } }
}

export function ease(kind: GuideEase, s: number): number {
  const x = Math.max(0, Math.min(1, s))
  if (kind === 'linear') return x
  if (kind === 'in') return x * x * x
  if (kind === 'out') return 1 - (1 - x) ** 3
  if (kind === 'back') {
    const c1 = 1.70158
    return 1 + (c1 + 1) * (x - 1) ** 3 + c1 * (x - 1) ** 2
  }
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
}

/** Where a motion has its instance `t` seconds into the step. */
export function motionPose(m: GuideMotion, t: number): GuidePose {
  const legs = [m.from, ...m.via, m.to]
  const e = ease(m.ease, m.duration > 0 ? (t - m.delay) / m.duration : t >= m.delay ? 1 : 0)
  const x = e * (legs.length - 1)
  const i = Math.max(0, Math.min(legs.length - 2, Math.floor(x)))
  return mixPose(legs[i], legs[i + 1], x - i)
}

/** Seconds a step plays: until its last motion ends, at least DWELL. */
export const stepDuration = (step: GuideStep) => Math.max(DWELL, ...step.motions.map((m) => m.delay + m.duration))

/** Evenly spaced moments of a step, both ends included (n ≥ 2). */
export const sampleTimes = (step: GuideStep, n: number) => Array.from({ length: n }, (_, i) => (stepDuration(step) * i) / (n - 1))

export const startsAssembled = (g: Pick<GuideDoc, 'kind'>) => g.kind !== 'build'

/** Instance paths the camera frames in a step; empty means everything shown. */
export const stepFrame = (step: GuideStep) => step.camera?.frame ?? [...new Set([...step.add, ...step.motions.map((m) => m.instance)])]

// ---------------------------------------------------------------- state

export type LeafState = {
  /** Where to draw it (assembly frame). */
  matrix: M4
  /** Shown in this step (added before or now, not removed before). */
  present: boolean
  /** 0 hides it; GHOST for instances still to come in a ghosted build guide. */
  opacity: number
  ghost: boolean
  moving: boolean
  focus: boolean
  added: boolean
  removing: boolean
}

/** What every step starts with: which leaves are shown, which are gone, and the pose each instance path was left in. */
export function stepStarts(g: Pick<GuideDoc, 'kind' | 'steps'>, leaves: { path: string }[]) {
  const starts: { shown: Set<string>; gone: Set<string>; poses: Map<string, GuidePose> }[] = []
  const shown = new Set(startsAssembled(g) ? leaves.map((l) => l.path) : [])
  const gone = new Set<string>()
  const poses = new Map<string, GuidePose>()
  for (const step of g.steps) {
    starts.push({ shown: new Set(shown), gone: new Set(gone), poses: new Map(poses) })
    for (const l of leaves) {
      if (step.add.some((p) => within(l.path, p))) shown.add(l.path)
      if (step.remove.some((p) => within(l.path, p))) {
        shown.delete(l.path)
        gone.add(l.path)
      }
    }
    for (const m of step.motions) poses.set(m.instance, m.to)
  }
  starts.push({ shown, gone, poses })
  return starts
}

/**
 * Every leaf `t` seconds into step `index` (t past the step's end holds its end). Pass `starts`
 * from stepStarts when calling every frame. Each leaf's matrix is its assembled matrix with the
 * poses of its own path and of the sub-assemblies holding it applied, innermost first.
 */
export function guideState(
  g: Pick<GuideDoc, 'kind' | 'steps' | 'upcoming'>,
  leaves: { path: string; matrix: M4 }[],
  index: number,
  t: number,
  starts = stepStarts(g, leaves),
): Map<string, LeafState> {
  const out = new Map<string, LeafState>()
  const step = g.steps[index]
  if (!step) return out
  const start = starts[index]
  const poses = new Map(start.poses)
  const moving = new Set<string>()
  for (const m of step.motions) {
    poses.set(m.instance, motionPose(m, t))
    moving.add(m.instance)
  }
  const duration = stepDuration(step)
  for (const leaf of leaves) {
    const added = step.add.some((p) => within(leaf.path, p))
    const removing = step.remove.some((p) => within(leaf.path, p))
    const present = start.shown.has(leaf.path) || added
    const ghost = !present && g.kind === 'build' && g.upcoming === 'ghost' && !start.gone.has(leaf.path)
    const isMoving = [...moving].some((p) => within(leaf.path, p))
    const focus = step.focus ? step.focus.some((p) => within(leaf.path, p)) : true
    let matrix = leaf.matrix
    if (present) {
      const holders = [...poses.keys()].filter((p) => within(leaf.path, p)).sort((a, b) => b.split('/').length - a.split('/').length)
      for (const p of holders) matrix = mul(poseMatrix(poses.get(p)!), matrix)
    }
    let opacity = present ? (focus ? 1 : UNFOCUSED) : ghost ? GHOST : 0
    if (added && !isMoving && !start.shown.has(leaf.path)) opacity *= Math.min(1, Math.max(0, t) / FADE_IN)
    if (removing) opacity *= 1 - Math.min(1, Math.max(0, t) / duration)
    out.set(leaf.path, { matrix, present, opacity, ghost, moving: isMoving, focus, added, removing })
  }
  return out
}
