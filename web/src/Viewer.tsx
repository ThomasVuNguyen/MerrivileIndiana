import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { Bounds, GizmoHelper, GizmoViewcube, GizmoViewport, Html, OrbitControls, useBounds } from '@react-three/drei'
import { Box3, Color, DoubleSide, EdgesGeometry, Group, Plane, Vector3 } from 'three'
import type { BufferGeometry, MeshStandardMaterial } from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { mergeVertices, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BrepLoader, brepOf, faceGeometry } from './brep'
import { EXPLODE, gearTrain } from './data'
import type { Instance, Part } from './data'
import { useWorkspace } from './workspace'

export type ViewerTheme = {
  edge: string
  edgeOpacity: number
  accent: string
  gizmo: 'cube' | 'axes' | 'none'
  ambient: number
}

const SECTION = new Plane(new Vector3(-1, 0, 0), 0)
const WHITE = new Color('#ffffff')

// Parts load independently; each one asks the assembly to refit when it lands.
// A key makes the request once per framing, so a rebuilt part keeps the camera.
const RefitContext = createContext<(delay?: number, key?: string) => void>(() => {})

export function Viewer({ theme, callout }: { theme: ViewerTheme; callout?: (part: Part) => ReactNode }) {
  const ws = useWorkspace()
  return (
    <Canvas
      className="viewer"
      camera={{ position: [180, 140, 200], fov: 30, near: 1, far: 5000 }}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
      dpr={[1, 2]}
      onPointerMissed={() => {
        if (ws.view === 'part') ws.setFaces([])
        else if (ws.clash === null) ws.setSelected(null)
      }}
      onCreated={(s) => {
        s.gl.localClippingEnabled = true
        // Exposed for the screenshot script in tools/capture.js.
        ;(window as unknown as { __three: unknown }).__three = s
      }}
    >
      <hemisphereLight args={['#ffffff', '#8a8f99', theme.ambient]} />
      <directionalLight position={[120, 200, 160]} intensity={1.6} />
      <directionalLight position={[-160, 60, -120]} intensity={0.5} />
      <Bounds fit clip margin={1.45} maxDuration={0.6}>
        <Assembly theme={theme} callout={callout} />
      </Bounds>
      <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
      {theme.gizmo !== 'none' && (
        <GizmoHelper alignment="top-right" margin={[64, 64]}>
          {theme.gizmo === 'cube' ? (
            <GizmoViewcube color="#ffffff" textColor="#3a3d42" strokeColor="#b9bcc2" opacity={1} hoverColor="#dfe7f7" />
          ) : (
            <GizmoViewport axisColors={['#e5484d', '#30a46c', '#3e63dd']} labelColor="#111" axisHeadScale={0.8} />
          )}
        </GizmoHelper>
      )}
      <KeyboardControls />
    </Canvas>
  )
}

function Assembly({ theme, callout }: { theme: ViewerTheme; callout?: (part: Part) => ReactNode }) {
  const ws = useWorkspace()
  const bounds = useBounds()
  const groupRef = useRef<Group>(null)
  const timer = useRef<number | undefined>(undefined)

  const soloPart = ws.view === 'part' ? ws.selected : null
  // What is being framed; a part asks once per framing, not once per rebuild.
  const framing = useRef('')
  framing.current = `${ws.fitNonce}|${ws.group}|${ws.view}|${soloPart}`
  const framed = useRef(new Set<string>())
  const refit = useCallback(
    (delay = 120, key?: string) => {
      if (key) {
        const k = `${framing.current}:${key}`
        if (framed.current.has(k)) return
        framed.current.add(k)
      }
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        if (groupRef.current) bounds.refresh(groupRef.current).clip().fit()
      }, delay)
    },
    [bounds],
  )

  useEffect(() => refit(), [ws.fitNonce, ws.group, ws.view, soloPart, refit])
  // Wait out the explode animation before measuring.
  useEffect(() => refit(700), [ws.exploded, refit])

  // Frame the two parts of the interference being inspected.
  const clash = ws.activeClash
  useEffect(() => {
    if (!clash || !groupRef.current) return
    const id = window.setTimeout(() => {
      const box = new Box3()
      for (const name of [clash.a, clash.b]) {
        const o = groupRef.current?.getObjectByName(name)
        if (o) box.expandByObject(o)
      }
      if (box.isEmpty()) return
      // Keep some of the assembly in frame for context, and leave the near
      // plane alone so close-up geometry isn't sliced off.
      box.expandByScalar(box.getSize(new Vector3()).length() * 0.6)
      bounds.refresh(box).fit()
    }, 150)
    return () => window.clearTimeout(id)
  }, [clash, bounds])

  // Drive the rotor while playing: 60 degrees per second.
  useFrame((_, dt) => {
    if (ws.playing) ws.drive.current = (ws.drive.current + dt * 60) % 360
  })

  const partsById = useMemo(() => new Map(ws.parts.map((p) => [p.id, p])), [ws.parts])
  const firstOf = new Set<string>()

  return (
    <RefitContext.Provider value={refit}>
      {/* build123d is Z-up; three.js is Y-up. */}
      <group ref={groupRef} rotation={[-Math.PI / 2, 0, 0]}>
        {ws.visibleInstances.map((inst) => {
          const part = partsById.get(inst.part)
          if (!part) return null
          // Only the first copy of the selected part carries the callout.
          const lead = !firstOf.has(part.id)
          firstOf.add(part.id)
          return (
            <Suspense key={inst.id} fallback={null}>
              {part.live ? (
                part.live.files && <BrepPlaced key={part.live.files.mesh} url={part.live.files.mesh} inst={inst} part={part} theme={theme} callout={lead ? callout : undefined} />
              ) : part.geometry ? (
                <Placed inst={inst} part={part} raw={part.geometry} theme={theme} callout={lead ? callout : undefined} />
              ) : (
                <StlPlaced inst={inst} part={part} theme={theme} callout={lead ? callout : undefined} />
              )}
            </Suspense>
          )
        })}
        {clash && (
          <Suspense fallback={null}>
            <ClashMarker key={clash.mesh} mesh={clash.mesh} at={clash.at} volume={clash.volume_mm3} />
          </Suspense>
        )}
      </group>
    </RefitContext.Provider>
  )
}

type PlacedProps = {
  inst: Instance
  part: Part
  theme: ViewerTheme
  callout?: (part: Part) => ReactNode
}

function StlPlaced(props: PlacedProps) {
  const raw = useLoader(STLLoader, `/models/${props.part.id}.stl`)
  return <Placed {...props} raw={raw} />
}

function BrepPlaced({ url, ...props }: PlacedProps & { url: string }) {
  const raw = useLoader(BrepLoader, url)
  return <Placed {...props} raw={raw} />
}

// Every copy of a part shares one prepared geometry.
const prepared = new WeakMap<BufferGeometry, { geometry: BufferGeometry; edges: BufferGeometry; center: Vector3 }>()

function prepare(raw: BufferGeometry) {
  let out = prepared.get(raw)
  const brep = brepOf(raw)
  if (!out && brep) {
    // Built parts arrive with real normals and their B-rep edges.
    raw.computeBoundingBox()
    out = { geometry: raw, edges: brep.edges, center: raw.boundingBox!.getCenter(new Vector3()) }
    prepared.set(raw, out)
  }
  if (!out) {
    const merged = mergeVertices(raw.clone().deleteAttribute('normal'), 1e-4)
    const box = new Box3().setFromBufferAttribute(merged.getAttribute('position') as never)
    out = { geometry: toCreasedNormals(merged, Math.PI / 7), edges: new EdgesGeometry(merged, 28), center: box.getCenter(new Vector3()) }
    prepared.set(raw, out)
  }
  return out
}

const CLASH = new Color('#d8453b')

function Placed({ inst, part, raw, theme, callout }: PlacedProps & { raw: BufferGeometry }) {
  const ws = useWorkspace()
  const refit = useContext(RefitContext)
  const orbit = useRef<Group>(null)
  const self = useRef<Group>(null)
  const mat = useRef<MeshStandardMaterial>(null)

  useEffect(() => refit(120, inst.id), [refit, inst.id])

  const { geometry, edges, center } = prepare(raw)
  const brep = brepOf(raw)
  // Faces are pickable on a built part's own document.
  const pickFaces = !!brep && ws.view === 'part'
  const [hoverFace, setHoverFace] = useState<number | null>(null)
  const picked = ws.faces.filter((f) => f.part === part.id).map((f) => f.index)
  const look = ws.look[part.id]
  const isSel = ws.selected === part.id
  const isHover = ws.hovered === part.id
  const solo = ws.view === 'part'
  const clash = ws.activeClash
  const inClash = clash ? clash.a === inst.id || clash.b === inst.id : false
  const ghost = clash !== null && !inClash
  // The pair goes see-through so the solid overlap inside them shows.
  const opacity = ghost ? 0.08 : inClash ? 0.35 : look?.opacity ?? 1
  const offset = ws.exploded && !solo ? EXPLODE[part.id] ?? 0 : 0

  useFrame((_, dt) => {
    if (!orbit.current || !self.current) return
    const z = orbit.current.position.z
    orbit.current.position.z = z + (offset - z) * Math.min(1, dt * 8)
    const t = gearTrain(ws.drive.current, ws.asm.gears)
    const turn = inst.motion === 'rotor' ? ws.drive.current : inst.motion === 'fixed' ? 0 : t.carrier
    const spin = inst.motion === 'planet' ? t.planetSpin : 0
    orbit.current.rotation.z = (turn * Math.PI) / 180
    self.current.rotation.z = ((inst.rot + spin) * Math.PI) / 180
    if (mat.current) {
      const target = isSel ? 0.1 : isHover ? 0.06 : 0
      mat.current.emissiveIntensity += (target - mat.current.emissiveIntensity) * Math.min(1, dt * 12)
    }
  })

  if (look && !look.visible && !inClash) return null
  const translucent = opacity < 0.999

  return (
    <group ref={orbit}>
      <group ref={self} position={inst.pos}>
        <mesh
          name={inst.id}
          geometry={geometry}
          onClick={(e) => {
            e.stopPropagation()
            if (pickFaces && e.faceIndex != null) {
              const index = brep.faceOf[e.faceIndex]
              const info = brep.faces[index]
              ws.toggleFace({ part: part.id, index, ...info }, e.shiftKey)
            } else ws.setSelected(part.id)
          }}
          onPointerMove={(e) => {
            if (!pickFaces || e.faceIndex == null) return
            e.stopPropagation()
            const index = brep.faceOf[e.faceIndex]
            if (index !== hoverFace) setHoverFace(index)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            ws.openPart(part.id)
          }}
          onPointerOver={(e) => {
            e.stopPropagation()
            ws.setHovered(part.id)
            document.body.style.cursor = 'pointer'
          }}
          onPointerOut={() => {
            ws.setHovered(null)
            setHoverFace(null)
            document.body.style.cursor = ''
          }}
        >
          <meshStandardMaterial
            // Clipping and transparency change the shader, so remount the material when they toggle.
            key={`${ws.section ? 'clipped' : 'whole'}-${translucent ? 'see-through' : 'solid'}`}
            ref={mat}
            color={look?.color ?? part.color}
            emissive={WHITE}
            emissiveIntensity={0}
            metalness={0.18}
            roughness={0.55}
            transparent={translucent}
            opacity={opacity}
            depthWrite={!translucent}
            side={ws.section ? DoubleSide : undefined}
            clippingPlanes={ws.section ? [SECTION] : []}
            polygonOffset
            polygonOffsetFactor={1}
            polygonOffsetUnits={1}
          />
        </mesh>
        {pickFaces &&
          [...new Set([...picked, ...(hoverFace !== null ? [hoverFace] : [])])].map((f) => (
            <mesh key={f} geometry={faceOverlay(raw, f)} renderOrder={1}>
              <meshBasicMaterial
                color={theme.accent}
                transparent
                opacity={picked.includes(f) ? 0.55 : 0.22}
                depthWrite={false}
                polygonOffset
                polygonOffsetFactor={-1}
                polygonOffsetUnits={-1}
              />
            </mesh>
          ))}
        <lineSegments geometry={edges}>
          <lineBasicMaterial
            color={isSel && !clash && !solo ? theme.accent : theme.edge}
            transparent
            opacity={isSel && !clash && !solo ? 1 : theme.edgeOpacity * Math.max(opacity, ghost ? 0.15 : 0.35)}
            clippingPlanes={ws.section ? [SECTION] : []}
          />
        </lineSegments>
        {isSel && callout && !clash && (
          <Html position={center} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            {callout(part)}
          </Html>
        )}
      </group>
    </group>
  )
}

const overlays = new WeakMap<BufferGeometry, Map<number, BufferGeometry>>()

function faceOverlay(raw: BufferGeometry, face: number) {
  let byFace = overlays.get(raw)
  if (!byFace) overlays.set(raw, (byFace = new Map()))
  let g = byFace.get(face)
  if (!g) byFace.set(face, (g = faceGeometry(raw, face)))
  return g
}

/** The overlapping volume of two parts, solid red, computed by build123d. */
function ClashMarker({ mesh, at, volume }: { mesh: string; at: [number, number, number]; volume: number }) {
  const geometry = useLoader(STLLoader, `/models/${mesh}.stl`)
  return (
    <group>
      <mesh geometry={geometry} renderOrder={2}>
        <meshStandardMaterial color={CLASH} emissive={CLASH} emissiveIntensity={0.35} roughness={0.6} />
      </mesh>
      <Html position={at} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
        <div className="clash-tag">{volume.toFixed(1)} mm³ overlap</div>
      </Html>
    </group>
  )
}

/** F fit, E explode, S section, Space play, Enter open part, Esc back out, H hide. */
function KeyboardControls() {
  const ws = useWorkspace()
  const { gl } = useThree()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      // Sliders and swatches keep focus after use; only text entry should swallow keys.
      if (t.closest('textarea, [contenteditable], input:not([type=range]):not([type=color])')) return
      if (e.key === 'f') ws.fit()
      else if (e.key === 'e') ws.setExploded((x) => !x)
      else if (e.key === 's') ws.setSection((x) => !x)
      else if (e.key === ' ' && ws.view === 'assembly') {
        e.preventDefault()
        ws.setPlaying((x) => !x)
      } else if (e.key === 'Enter' && ws.selected) ws.openPart()
      else if (e.key === 'Escape') {
        // Step back out: picked faces → clash → part view → selection.
        if (ws.faces.length) ws.setFaces([])
        else if (ws.clash !== null) ws.setClash(null)
        else if (ws.view === 'part' && !ws.live) ws.setView('assembly')
        else ws.setSelected(null)
      } else if (e.key === 'h' && ws.selected) ws.setAppearance(ws.selected, { visible: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ws, gl])
  return null
}
