import { useSyncExternalStore } from 'react'
import { BufferAttribute, BufferGeometry, Loader } from 'three'
import type { PartMesh } from '../shared/protocol'

/** What the geometry service knows about each face, by B-rep face index. */
export type BrepData = {
  faceOf: Uint32Array
  faceRanges: [number, number][]
  faces: PartMesh['faces']
  edges: BufferGeometry
}

export const brepOf = (g: BufferGeometry) => g.userData.brep as BrepData | undefined

/** Bytes in and expected per mesh URL while it downloads; gone once it's loaded. */
const loading = new Map<string, { loaded: number; total: number }>()
const listeners = new Set<() => void>()
let tick = 0
const changed = () => {
  tick++
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

/** Download progress of the meshes still loading, for a progress line. Re-renders as bytes arrive. */
export function useMeshProgress(urls: string[]) {
  useSyncExternalStore(subscribe, () => tick)
  const shown = urls.flatMap((u) => {
    const p = loading.get(u)
    return p ? [{ url: u, ...p }] : []
  })
  return shown
}

/** Loads the face-indexed tessellation served for a part version (or a component, or a clash). */
export class BrepLoader extends Loader<BufferGeometry> {
  load(url: string, onLoad: (g: BufferGeometry) => void, _?: unknown, onError?: (err: unknown) => void) {
    read(url)
      .then((mesh) => onLoad(decode(mesh)))
      .catch((err) => onError?.(err))
      .finally(() => {
        loading.delete(url)
        changed()
      })
  }
}

// Component meshes run to megabytes, so the body is read in chunks to report progress. A
// compressed response's length isn't the body's, so its total stays unknown (0).
async function read(url: string): Promise<PartMesh> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${r.status} loading ${url}`)
  const length = Number(r.headers.get('content-length')) || 0
  if (!r.body || (length && length < 1_000_000)) return r.json()
  const total = r.headers.get('content-encoding') ? 0 : length
  const reader = r.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  let shown = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.length
    if (loaded > 500_000 && loaded - shown > 200_000) {
      shown = loaded
      loading.set(url, { loaded, total })
      changed()
    }
  }
  return JSON.parse(await new Blob(chunks as BlobPart[]).text())
}

function decode(mesh: PartMesh): BufferGeometry {
  const positions = new Float32Array(bytes(mesh.positions))
  const indices = new Uint32Array(bytes(mesh.indices))
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(positions, 3))
  g.setIndex(new BufferAttribute(indices, 1))
  // Faces don't share vertices, so smooth normals stay inside each face and
  // edges between faces stay crisp.
  g.computeVertexNormals()
  const faceOf = new Uint32Array(indices.length / 3)
  mesh.faceRanges.forEach(([start, count], face) => faceOf.fill(face, start, start + count))
  const edges = new BufferGeometry()
  edges.setAttribute('position', new BufferAttribute(new Float32Array(bytes(mesh.edges)), 3))
  g.userData.brep = { faceOf, faceRanges: mesh.faceRanges, faces: mesh.faces, edges } satisfies BrepData
  return g
}

function bytes(b64: string): ArrayBuffer {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/** A geometry holding only the triangles of one face, sharing the part's vertices. */
export function faceGeometry(g: BufferGeometry, face: number): BufferGeometry {
  const brep = brepOf(g)!
  const [start, count] = brep.faceRanges[face]
  const index = g.getIndex()!.array as Uint32Array
  const out = new BufferGeometry()
  out.setAttribute('position', g.getAttribute('position'))
  out.setAttribute('normal', g.getAttribute('normal'))
  out.setIndex(new BufferAttribute(index.slice(start * 3, (start + count) * 3), 1))
  return out
}
