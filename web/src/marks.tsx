// Datums and keep-outs drawn in a shape's own frame (millimetres, Z up), for the assembly view and
// the component page.

import { useEffect, useMemo, useState } from 'react'
import { Html } from '@react-three/drei'
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Quaternion, Vector3 } from 'three'
import type { Datum, KeepOut, Vec3 } from '../shared/protocol'
import { SECTION } from './viewer-shared'

const v = (a: Vec3) => new Vector3(...a)
const UP = new Vector3(0, 1, 0)

/** Two unit vectors square to n. */
function basis(n: Vector3, x?: Vector3) {
  const helper = Math.abs(n.z) < 0.9 ? new Vector3(0, 0, 1) : new Vector3(1, 0, 0)
  const u = x && Math.abs(x.dot(n)) < 0.99 ? x.clone().addScaledVector(n, -x.dot(n)).normalize() : helper.cross(n).normalize()
  return [u, n.clone().cross(u).normalize()] as const
}

/**
 * Labels are drei Html, each its own React root. Mounted inside the page's commit (opening a
 * component from the grid) they can race and one goes missing, so they come a frame later.
 */
function useLabelsReady() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return ready
}

function segments(points: Vector3[]) {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(points.flatMap((p) => [p.x, p.y, p.z]), 3))
  return g
}

function circle(c: Vector3, n: Vector3, r: number, steps = 32) {
  const [a, b] = basis(n)
  const out: Vector3[] = []
  for (let i = 0; i < steps; i++) {
    for (const k of [i, i + 1]) {
      const t = (k / steps) * Math.PI * 2
      out.push(c.clone().addScaledVector(a, Math.cos(t) * r).addScaledVector(b, Math.sin(t) * r))
    }
  }
  return out
}

/** Line segments for one datum: plane = square with its normal, axis = line, point = cross, pattern = rings. */
function datumLines(d: Datum, size: number): Vector3[] {
  if (d.kind === 'plane') {
    const o = v(d.origin)
    const n = v(d.normal).normalize()
    const [x, y] = basis(n, v(d.x))
    const h = size / 2
    const c = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ].map(([i, j]) => o.clone().addScaledVector(x, i * h).addScaledVector(y, j * h))
    const tip = o.clone().addScaledVector(n, size * 0.6)
    const head = (s: number) => tip.clone().addScaledVector(n, -size * 0.14).addScaledVector(x, s * size * 0.07)
    return [c[0], c[1], c[1], c[2], c[2], c[3], c[3], c[0], o, tip, tip, head(1), tip, head(-1)]
  }
  if (d.kind === 'axis') {
    const o = v(d.origin)
    const dir = v(d.direction).normalize()
    return [o.clone().addScaledVector(dir, -size), o.clone().addScaledVector(dir, size)]
  }
  if (d.kind === 'point') {
    const o = v(d.at)
    const s = size * 0.12
    return [new Vector3(s, 0, 0), new Vector3(0, s, 0), new Vector3(0, 0, s)].flatMap((a) => [o.clone().sub(a), o.clone().add(a)])
  }
  const n = v(d.normal).normalize()
  const r = d.diameter ? d.diameter / 2 + size * 0.04 : size * 0.08
  return d.points.flatMap((p) => [...circle(v(p), n, r), v(p), v(p).addScaledVector(n, r * 1.6)])
}

function datumAnchor(d: Datum): Vec3 {
  if (d.kind === 'plane') return d.origin
  if (d.kind === 'axis') return d.origin
  if (d.kind === 'point') return d.at
  const c = d.points.reduce((a, p) => a.add(v(p)), new Vector3()).divideScalar(d.points.length || 1)
  return [c.x, c.y, c.z]
}

/** A shape's datums with their names. `size` scales the marks to the shape (a fraction of its size). */
export function DatumMarks({ datums, size, color, hot, section }: { datums: Record<string, Datum>; size: number; color: string; hot?: string | null; section?: boolean }) {
  const entries = useMemo(() => {
    // Datums often share a centre (a board's base and its mounting holes): their labels stack.
    const seen = new Map<string, number>()
    return Object.entries(datums).map(([name, d]) => {
      const at = datumAnchor(d)
      const key = at.map((x) => Math.round(x / Math.max(1, size * 0.2))).join()
      const row = seen.get(key) ?? 0
      seen.set(key, row + 1)
      return { name, d, at, row, g: segments(datumLines(d, size)) }
    })
  }, [datums, size])
  const labels = useLabelsReady()
  return (
    <group>
      {entries.map(({ name, at, row, g }) => (
        <group key={name}>
          <lineSegments geometry={g} renderOrder={3}>
            <lineBasicMaterial color={color} transparent opacity={!hot || hot === name ? 1 : 0.35} depthTest={false} clippingPlanes={section ? [SECTION] : []} />
          </lineSegments>
          {labels && (
            <Html position={at} zIndexRange={[15, 0]} style={{ pointerEvents: 'none' }}>
              <span className={`datum-tag${hot === name ? ' is-hot' : ''}`} style={{ borderColor: color, color, marginTop: row * 18 }}>
                {name}
              </span>
            </Html>
          )}
        </group>
      ))}
    </group>
  )
}

const KEEPOUT = '#c27a1f'

/** Keep-out volumes as translucent boxes, cylinders and cones, with their labels. */
export function KeepOutMarks({ keepouts, hot }: { keepouts: KeepOut[]; hot?: string | null }) {
  const labels = useLabelsReady()
  return (
    <group>
      {keepouts.map((k, i) => (
        <KeepOutMark key={`${k.label}-${i}`} k={k} on={!hot || hot === k.label} label={labels} />
      ))}
    </group>
  )
}

function KeepOutMark({ k, on, label }: { k: KeepOut; on: boolean; label: boolean }) {
  const place = useMemo(() => {
    if (k.kind === 'box') {
      const min = v(k.min)
      const max = v(k.max)
      return { at: min.clone().add(max).multiplyScalar(0.5), q: new Quaternion(), size: max.clone().sub(min), label: max.clone() }
    }
    const dir = v(k.direction).normalize()
    const o = v(k.origin)
    return { at: o.clone().addScaledVector(dir, k.length / 2), q: new Quaternion().setFromUnitVectors(UP, dir), size: null, label: o.clone().addScaledVector(dir, k.length) }
  }, [k])
  const top = k.kind === 'cylinder' ? k.radius : k.kind === 'cone' ? (k.radius ?? 0) + k.length * Math.tan((k.angle * Math.PI) / 180) : 0
  const bottom = k.kind === 'cylinder' ? k.radius : k.kind === 'cone' ? k.radius ?? 0 : 0
  return (
    <group>
      <mesh position={place.at} quaternion={place.q} renderOrder={2}>
        {place.size ? <boxGeometry args={[place.size.x, place.size.y, place.size.z]} /> : <cylinderGeometry args={[top, bottom, k.kind === 'box' ? 0 : k.length, 40, 1, true]} />}
        <meshBasicMaterial color={KEEPOUT} transparent opacity={on ? 0.16 : 0.06} side={DoubleSide} depthWrite={false} />
      </mesh>
      {label && (
        <Html position={place.label} zIndexRange={[15, 0]} style={{ pointerEvents: 'none' }}>
          <span className="keepout-tag">{k.label}</span>
        </Html>
      )}
    </group>
  )
}
