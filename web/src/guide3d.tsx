// Plays an assembly guide in the viewer: every frame it asks shared/guide.ts where each leaf is and
// how it shows, and writes that straight into the leaves' objects (no React render per frame). It
// also pins the step's labels, marks the finding being looked at, and flies the camera to each
// step's view until the person takes the camera.

import { createContext, useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import { Box3, Matrix4, Quaternion, Vector3 } from 'three'
import type { Group, LineBasicMaterial, MeshStandardMaterial, PerspectiveCamera } from 'three'
import type { AssemblyDoc, GuideDoc, GuideFinding, GuideStep, Vec3 } from '../shared/protocol'
import { ease, guideState, stepDuration, stepFrame, stepStarts, VIEWS, within } from '../shared/guide'
import type { LeafState } from '../shared/guide'
import { fmt } from './asm'
import { stepOffsets } from './player'
import type { ViewerTheme } from './Viewer'
import { CLASH } from './viewer-shared'
import { useWorkspace } from './workspace'

/** A drawn leaf's objects; `box` is its mesh's bounds in its own frame. */
export type LeafNode = {
  group: RefObject<Group | null>
  mat: RefObject<MeshStandardMaterial | null>
  edge: RefObject<LineBasicMaterial | null>
  box: Box3
}

export const LeafNodes = createContext<Map<string, LeafNode>>(new Map())

type Controls = { target: Vector3; addEventListener: (e: string, f: () => void) => void; removeEventListener: (e: string, f: () => void) => void }

/** Seconds the camera takes to reach a step's view. */
const FLY = 0.9
const Y = new Vector3(0, 1, 0)

const m4 = (m: number[], out = new Matrix4()) => out.set(...(m as Parameters<Matrix4['set']>))

/** Where a label sits now: on its instance as it's posed, or where it was written. */
function labelPoint(at: string | Vec3, point: Vec3, doc: AssemblyDoc, states: Map<string, LeafState>, out: Vector3) {
  out.set(...point)
  if (typeof at !== 'string') return 1
  const inst = at.split('.')[0]
  const leaf = doc.leaves.find((l) => within(l.path, inst))
  const st = leaf && states.get(leaf.path)
  if (!leaf || !st) return 1
  // Its current matrix times the inverse of where it sits assembled carries the point along.
  out.applyMatrix4(m4(leaf.matrix).invert()).applyMatrix4(m4(st.matrix))
  return st.present ? st.opacity : 0
}

export function GuidePlayer({ guide, doc, groupRef, nodes, theme }: { guide: GuideDoc; doc: AssemblyDoc; groupRef: RefObject<Group | null>; nodes: Map<string, LeafNode>; theme: ViewerTheme }) {
  const ws = useWorkspace()
  const p = ws.player
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const controls = useThree((s) => s.controls) as unknown as Controls | null
  const canvas = useThree((s) => s.gl.domElement)
  const starts = useMemo(() => stepStarts(guide, doc.leaves), [guide, doc.leaves])
  const offsets = useMemo(() => stepOffsets(guide), [guide])
  const durations = useMemo(() => guide.steps.map(stepDuration), [guide])
  const step: GuideStep | undefined = guide.steps[p.step]
  const labels = step?.labels ?? []
  const labelGroups = useRef<(Group | null)[]>([])
  const labelEls = useRef<(HTMLDivElement | null)[]>([])
  const mark: GuideFinding | null = p.mark !== null ? guide.report?.findings[p.mark] ?? null : null

  // The frame loop reads the latest of these without re-subscribing.
  const latest = useRef({ playing: p.playing, speed: p.speed, auto: p.auto, pick: ws.pick })
  latest.current = { playing: p.playing, speed: p.speed, auto: p.auto, pick: ws.pick }

  const fly = useRef({
    on: true,
    shot: -1,
    start: 0,
    fromTarget: new Vector3(),
    fromOffset: new Vector3(),
    toTarget: new Vector3(),
    toOffset: new Vector3(),
    axis: new Vector3(0, 1, 0),
    orbit: 0,
  })
  const tmp = useMemo(() => ({ m: new Matrix4(), s: new Vector3(), v: new Vector3(), w: new Vector3(), box: new Box3(), q: new Quaternion(), q0: new Quaternion() }), [])

  // The caption card and the transport cover part of the viewer; the picture centres in the rest.
  const shift = useRef({ x: 0, y: 0 })
  useEffect(
    () => () => {
      camera.clearViewOffset()
    },
    [camera],
  )

  // Moving the camera by hand (or F to fit) stops the guide driving it until the next step.
  useEffect(() => {
    if (!controls) return
    const stop = () => {
      fly.current.on = false
    }
    controls.addEventListener('start', stop)
    return () => controls.removeEventListener('start', stop)
  }, [controls])
  const fitSeen = useRef(ws.fitNonce)
  useEffect(() => {
    if (fitSeen.current !== ws.fitNonce) fly.current.on = false
    fitSeen.current = ws.fitNonce
  }, [ws.fitNonce])

  /** The camera's goal for the clock's step: its view, framing its instances where the step ends. */
  function aim(): boolean {
    const c = p.clock.current
    const g = groupRef.current
    const s = guide.steps[c.step]
    if (!g || !s || !controls || nodes.size === 0) return false
    const t = c.frame ? c.frame.t : durations[c.step]
    const states = guideState(guide, doc.leaves, c.step, t, starts)
    const paths = c.frame?.paths ?? stepFrame(s)
    const box = new Box3()
    const add = (all: boolean) => {
      for (const [path, node] of nodes) {
        const st = states.get(path)
        if (!st || !(st.present || st.ghost)) continue
        if (!all && !paths.some((x) => within(path, x))) continue
        if (all && !st.present && nodes.size > 1) continue
        box.union(tmp.box.copy(node.box).applyMatrix4(m4(st.matrix, tmp.m)))
      }
    }
    add(paths.length === 0)
    if (box.isEmpty()) add(true)
    if (box.isEmpty()) return false
    g.updateWorldMatrix(true, false)
    box.applyMatrix4(g.matrixWorld)
    const center = box.getCenter(new Vector3())
    const radius = Math.max(1, box.getSize(new Vector3()).length() / 2)

    const view = s.camera?.view
    const named = typeof view === 'string' ? VIEWS[view] : view ? { dir: view.dir, up: view.up ?? ([0, 0, 1] as Vec3) } : null
    const dir = named ? new Vector3(...named.dir).transformDirection(g.matrixWorld) : camera.position.clone().sub(controls.target).normalize()
    const up = named ? new Vector3(...named.up).transformDirection(g.matrixWorld) : Y.clone()
    // Fit in what the card and transport leave free.
    const sh = shift.current
    const w = canvas.clientWidth || 1
    const h = canvas.clientHeight || 1
    const vfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * Math.max(0.3, 1 - (2 * Math.abs(sh.y)) / h))
    const hfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect * Math.max(0.3, 1 - (2 * Math.abs(sh.x)) / w))
    const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 1.0 / Math.max(0.05, s.camera?.zoom ?? 1)

    const f = fly.current
    f.toTarget.copy(center)
    f.toOffset.copy(dir).multiplyScalar(dist)
    // Straight down (or up) the orbit controls' pole: lean off it so the view's up is up on screen.
    if (Math.abs(dir.dot(Y)) > 0.995) f.toOffset.addScaledVector(up, -dist * 0.002)
    f.axis.copy(Math.abs(dir.dot(Y)) > 0.9 ? Y : up)
    f.orbit = c.frame ? 0 : ((s.camera?.orbit ?? 0) * Math.PI) / 180
    f.fromTarget.copy(controls.target)
    f.fromOffset.copy(camera.position).sub(controls.target)
    // The camera on its target (the viewer's first frame) has no way in: start at the goal.
    if (f.fromOffset.lengthSq() < 1e-6) {
      f.fromTarget.copy(f.toTarget)
      f.fromOffset.copy(f.toOffset)
    }
    if (camera.far < dist * 20) {
      camera.far = dist * 20
      camera.updateProjectionMatrix()
    }
    return true
  }

  useFrame((state, delta) => {
    const n = guide.steps.length
    if (!n) return
    const dt = Math.min(delta, 0.1)
    const c = p.clock.current
    const L = latest.current
    if (c.step >= n) c.step = n - 1

    // Advance the clock; at a step's end go on to the next one or wait there.
    if (L.playing && !c.scrubbing) {
      const adv = dt * L.speed
      c.t += adv
      if (c.shown >= 0) c.shown += adv
      const d = durations[c.step]
      if (c.t >= d) {
        if (L.auto && c.step < n - 1) p.goStep(c.step + 1, { t: c.t - d })
        else {
          c.t = d
          p.setPlaying(false)
        }
      }
    }

    // The drawing glides to the clock: playback keeps them together, jumps and scrubs ease over.
    const goal = offsets[c.step] + Math.min(c.t, durations[c.step])
    if (c.shown < 0) c.shown = goal
    else {
      c.shown += (goal - c.shown) * Math.min(1, dt * 9)
      if (Math.abs(goal - c.shown) < 1e-3) c.shown = goal
    }
    let i = c.step
    while (i > 0 && c.shown < offsets[i] - 1e-9) i--
    while (i < n - 1 && c.shown > offsets[i + 1] + 1e-9) i++
    const states = guideState(guide, doc.leaves, i, c.shown - offsets[i], starts)

    const edgeBase = theme.edgeOpacity * 0.8
    for (const [path, node] of nodes) {
      const st = states.get(path)
      const g = node.group.current
      if (!st || !g) continue
      m4(st.matrix, tmp.m).decompose(g.position, g.quaternion, tmp.s)
      const o = st.opacity
      g.visible = o > 0.003
      const mat = node.mat.current
      if (mat) {
        const see = o < 0.999
        if (mat.transparent !== see) {
          mat.transparent = see
          mat.needsUpdate = true
        }
        mat.opacity = o
        mat.depthWrite = !see
      }
      const e = node.edge.current
      // Ghosts keep more of their outline than their faces, like a dotted part in a booklet.
      if (e) e.opacity = (L.pick && within(path, L.pick) ? 1 : edgeBase) * (st.ghost ? 0.45 : Math.min(1, o * 1.15))
    }

    // Labels ride on their instances; they show for the step being read, once the drawing is there.
    labels.forEach((l, j) => {
      const grp = labelGroups.current[j]
      const el = labelEls.current[j]
      if (!grp || !el) return
      const o = labelPoint(l.at, l.point, doc, states, grp.position)
      el.style.opacity = i === c.step && o > 0.05 ? '1' : '0'
      // Where the text wouldn't fit on the right, the leader points left instead.
      grp.getWorldPosition(tmp.v).project(camera)
      const room = ((1 - tmp.v.x) / 2) * canvas.clientWidth
      el.classList.toggle('is-left', room < (el.classList.contains('is-left') ? 260 : 230))
    })

    // Centre the picture in the free part of the viewer, easing as the card changes size.
    const box = canvas.getBoundingClientRect()
    const card = document.querySelector('.guide-card')?.getBoundingClientRect()
    const bar = document.querySelector('.guide-transport')?.getBoundingClientRect()
    let gx = 0
    let gy = bar ? -Math.max(0, box.bottom - bar.top) / 2 : 0
    if (card && card.width > box.width * 0.7) gy += Math.max(0, card.bottom - box.top) / 2
    else if (card) gx = Math.max(0, card.right - box.left) / 2
    const sh = shift.current
    sh.x += (gx - sh.x) * Math.min(1, dt * 6)
    sh.y += (gy - sh.y) * Math.min(1, dt * 6)
    if (box.width > 0) camera.setViewOffset(box.width, box.height, -sh.x, -sh.y, box.width, box.height)

    // The camera: a new step (or finding) asks for a shot; fly there, then orbit with the step.
    const f = fly.current
    if (c.scrubbing) f.shot = c.shot
    else if (c.shot !== f.shot && aim()) {
      f.shot = c.shot
      f.on = true
      f.start = state.clock.elapsedTime
    }
    if (f.on && controls) {
      const k = ease('in-out', (state.clock.elapsedTime - f.start) / FLY)
      const target = tmp.v.lerpVectors(f.fromTarget, f.toTarget, k)
      // Swing round the target (direction slerps, distance lerps) rather than cutting through it.
      const to = f.toOffset.clone().normalize()
      const a = tmp.w.copy(f.fromOffset).normalize()
      tmp.q.setFromUnitVectors(a, to)
      tmp.q0.identity().slerp(tmp.q, k)
      const offset = a.applyQuaternion(tmp.q0).multiplyScalar(f.fromOffset.length() + (f.toOffset.length() - f.fromOffset.length()) * k)
      if (f.orbit) offset.applyAxisAngle(f.axis, f.orbit * Math.min(1, c.t / durations[c.step]))
      camera.position.copy(target).add(offset)
      controls.target.copy(target)
      camera.lookAt(target)
    }
  })

  return (
    <>
      {labels.map((l, j) => (
        <group
          key={`${p.step}-${j}`}
          position={l.point}
          ref={(g) => {
            labelGroups.current[j] = g
          }}
        >
          <Html zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <div
              className="guide-label"
              style={{ opacity: 0 }}
              ref={(el) => {
                labelEls.current[j] = el
              }}
            >
              <span className="guide-label-line" />
              <span className="guide-label-text">{l.text}</span>
            </div>
          </Html>
        </group>
      ))}
      {mark?.at && <MarkTag key={p.mark} finding={mark} />}
    </>
  )
}

/** A finding at its moment: a red ball the size of the overlap, and how much. */
function MarkTag({ finding }: { finding: GuideFinding }) {
  const r = finding.unit === 'mm³' && finding.value ? Math.max(0.8, Math.cbrt((3 * finding.value) / (4 * Math.PI))) : 0.8
  const group = useRef<Group>(null)
  const tag = useRef<HTMLDivElement>(null)
  const v = useMemo(() => new Vector3(), [])
  useFrame(({ camera }) => {
    if (!group.current || !tag.current) return
    group.current.getWorldPosition(v).project(camera)
    tag.current.classList.toggle('is-left', v.x > 0.2)
  })
  return (
    <group position={finding.at} ref={group}>
      <mesh renderOrder={4}>
        <sphereGeometry args={[r, 20, 14]} />
        <meshBasicMaterial color={CLASH} transparent opacity={0.85} depthTest={false} />
      </mesh>
      <Html zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className="clash-tag" ref={tag}>
          {finding.value !== undefined ? fmt(finding.value, finding.unit) : finding.kind.replace('_', ' ')}
          {finding.kind === 'path_clash' ? ' on the way' : ''}
        </div>
      </Html>
    </group>
  )
}
