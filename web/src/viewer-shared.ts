import { createContext } from 'react'
import { Box3, Color, EdgesGeometry, Plane, Vector3 } from 'three'
import type { BufferGeometry } from 'three'
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { brepOf } from './brep'

/** The section cut (S): keeps x below the constant, in world space. */
export const SECTION = new Plane(new Vector3(-1, 0, 0), 0)
export const WHITE = new Color('#ffffff')
export const CLASH = new Color('#d8453b')

// Parts load independently; each one asks the assembly to refit when it lands.
// A key makes the request once per framing, so a rebuilt part keeps the camera.
export const RefitContext = createContext<(delay?: number, key?: string) => void>(() => {})

// Every copy of a part shares one prepared geometry.
const prepared = new WeakMap<BufferGeometry, { geometry: BufferGeometry; edges: BufferGeometry; center: Vector3; radius: number }>()

export function prepare(raw: BufferGeometry) {
  let out = prepared.get(raw)
  const brep = brepOf(raw)
  if (!out && brep) {
    // Built parts arrive with real normals and their B-rep edges.
    raw.computeBoundingBox()
    const box = raw.boundingBox!
    out = { geometry: raw, edges: brep.edges, center: box.getCenter(new Vector3()), radius: box.getSize(new Vector3()).length() / 2 }
    prepared.set(raw, out)
  }
  if (!out) {
    const merged = mergeVertices(raw.clone().deleteAttribute('normal'), 1e-4)
    const box = new Box3().setFromBufferAttribute(merged.getAttribute('position') as never)
    out = { geometry: toCreasedNormals(merged, Math.PI / 7), edges: new EdgesGeometry(merged, 28), center: box.getCenter(new Vector3()), radius: box.getSize(new Vector3()).length() / 2 }
    prepared.set(raw, out)
  }
  return out
}
