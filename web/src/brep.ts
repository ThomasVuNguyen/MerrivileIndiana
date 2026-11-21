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

/** Loads the face-indexed tessellation served for a part version. */
export class BrepLoader extends Loader<BufferGeometry> {
  load(url: string, onLoad: (g: BufferGeometry) => void, _?: unknown, onError?: (err: unknown) => void) {
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} loading ${url}`)
        return r.json() as Promise<PartMesh>
      })
      .then((mesh) => onLoad(decode(mesh)))
      .catch((err) => onError?.(err))
  }
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
