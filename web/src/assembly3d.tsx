// A live assembly in the viewer: every leaf from its mesh and matrix, the picked instance's datums
// and keep-outs, and the check finding being looked at.

import { Suspense, useContext, useEffect, useMemo, useRef } from 'react'
import type { RefObject } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import { Html, useBounds } from '@react-three/drei'
import { Box3, DoubleSide, Matrix4, Quaternion, Vector3 } from 'three'
import type { Group, LineBasicMaterial, MeshStandardMaterial } from 'three'
import type { AssemblyDoc, AssemblyLeaf, Finding } from '../shared/protocol'
import { fmt, lookOf, within } from './asm'
import { BrepLoader } from './brep'
import { GuidePlayer, LeafNodes } from './guide3d'
import type { LeafNode } from './guide3d'
import { DatumMarks, KeepOutMarks } from './marks'
import type { ViewerTheme } from './Viewer'
import { CLASH, prepare, RefitContext, SECTION, WHITE } from './viewer-shared'
import { useWorkspace } from './workspace'

export function LiveAssembly({ doc, theme, groupRef }: { doc: AssemblyDoc; theme: ViewerTheme; groupRef: RefObject<Group | null> }) {
  const ws = useWorkspace()
  const bounds = useBounds()
  const guide = ws.player.guide
  const finding = ws.finding !== null && !guide ? doc.report?.findings[ws.finding] ?? null : null
  // Every drawn leaf's objects, for the guide player to move and fade.
  const nodes = useMemo(() => new Map<string, LeafNode>(), [])

  const shown = doc.leaves.filter((l) => !lookOf(ws.looks, doc.id, l.path).hidden && (!ws.isolated || within(l.path, ws.isolated)))

  // Frame the finding: its box, or a little room around its point, plus some context.
  useEffect(() => {
    if (!finding || !groupRef.current) return
    const id = window.setTimeout(() => {
      const g = groupRef.current
      if (!g) return
      const box = new Box3()
      if (finding.bbox) box.set(new Vector3(...finding.bbox.min), new Vector3(...finding.bbox.max))
      else if (finding.at) box.setFromCenterAndSize(new Vector3(...finding.at), new Vector3(30, 30, 30))
      else
        for (const p of finding.instances) {
          g.traverse((o) => {
            if (typeof o.userData.path === 'string' && within(o.userData.path, p)) box.expandByObject(o)
          })
        }
      if (box.isEmpty()) return
      g.updateWorldMatrix(true, false)
      if (finding.bbox || finding.at) box.applyMatrix4(g.matrixWorld)
      box.expandByScalar(Math.max(6, box.getSize(new Vector3()).length() * 0.35))
      bounds.refresh(box).fit()
    }, 150)
    return () => window.clearTimeout(id)
  }, [finding, bounds, groupRef])

  // The section cuts through the middle of what's shown, not the origin.
  useEffect(() => {
    if (!ws.section || !groupRef.current) return
    const box = new Box3().setFromObject(groupRef.current)
    if (!box.isEmpty()) SECTION.constant = box.getCenter(new Vector3()).x
    return () => {
      SECTION.constant = 0
    }
  }, [ws.section, groupRef, doc.version])

  // Opening or closing a guide remounts the leaves, so they start from (and go back to) exactly
  // what React says rather than what the player left them at.
  return (
    <LeafNodes.Provider value={nodes}>
      {shown.map((leaf) => (
        <Suspense key={leaf.path} fallback={null}>
          {leaf.mesh && <Leaf key={`${leaf.mesh}|${guide ? 'guide' : ''}`} doc={doc} leaf={leaf} theme={theme} finding={finding} />}
        </Suspense>
      ))}
      {finding && <FindingMarks key={`${doc.version}-${ws.finding}`} finding={finding} />}
      {guide && <GuidePlayer key={guide.id} guide={guide} doc={doc} groupRef={groupRef} nodes={nodes} theme={theme} />}
    </LeafNodes.Provider>
  )
}

function Leaf({ doc, leaf, theme, finding }: { doc: AssemblyDoc; leaf: AssemblyLeaf; theme: ViewerTheme; finding: Finding | null }) {
  const ws = useWorkspace()
  const refit = useContext(RefitContext)
  const raw = useLoader(BrepLoader, leaf.mesh)
  const mat = useRef<MeshStandardMaterial>(null)
  const edge = useRef<LineBasicMaterial>(null)
  const group = useRef<Group>(null)
  const { geometry, edges, radius } = prepare(raw)
  useEffect(() => refit(120, `leaf:${leaf.path}`), [refit, leaf.path])

  const nodes = useContext(LeafNodes)
  useEffect(() => {
    if (!geometry.boundingBox) geometry.computeBoundingBox()
    const node: LeafNode = { group, mat, edge, box: geometry.boundingBox! }
    nodes.set(leaf.path, node)
    return () => {
      if (nodes.get(leaf.path) === node) nodes.delete(leaf.path)
    }
  }, [nodes, leaf.path, geometry])

  const place = useMemo(() => {
    const m = new Matrix4().set(...(leaf.matrix as Parameters<Matrix4['set']>))
    const position = new Vector3()
    const quaternion = new Quaternion()
    m.decompose(position, quaternion, new Vector3())
    return { position, quaternion }
  }, [leaf.matrix])

  const look = lookOf(ws.looks, doc.id, leaf.path)
  const picked = !!ws.pick && within(leaf.path, ws.pick)
  const hover = ws.hovered === `@${leaf.path}` || (!!ws.hovered?.startsWith('@') && within(leaf.path, ws.hovered.slice(1)))
  const involved = finding ? finding.instances.some((p) => within(leaf.path, p)) : false
  // The instances in a finding go see-through so the overlap inside them shows; the rest fade.
  const opacity = finding ? (involved ? 0.35 : 0.08) : 1
  const translucent = opacity < 0.999

  useFrame((_, dt) => {
    if (!mat.current) return
    const target = picked ? 0.12 : hover ? 0.07 : 0
    mat.current.emissiveIntensity += (target - mat.current.emissiveIntensity) * Math.min(1, dt * 12)
  })

  // The picked instance shows its datums (and a component's keep-outs) in its own frame.
  const showDatums = ws.pick === leaf.path || (finding?.kind === 'keepout' && involved)
  const ref = leaf.ref
  const part = 'part' in ref ? ws.parts.find((p) => p.id === ref.part)?.live : undefined
  const component = 'component' in ref ? ws.components?.find((c) => c.id === ref.component) : undefined
  const datums = ws.pick === leaf.path ? (part?.datums ?? component?.datums) : undefined
  const keepouts = component?.keepouts.length && showDatums ? component.keepouts : undefined
  const size = Math.min(40, Math.max(4, radius * 0.45))

  return (
    <group ref={group} position={place.position} quaternion={place.quaternion} userData={{ path: leaf.path }}>
      <mesh
        geometry={geometry}
        userData={{ path: leaf.path }}
        onClick={(e) => {
          e.stopPropagation()
          ws.setPick(leaf.path)
        }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if ('part' in ref) ws.openPart(ref.part)
        }}
        onPointerOver={(e) => {
          e.stopPropagation()
          ws.setHovered(`@${leaf.path}`)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          ws.setHovered(null)
          document.body.style.cursor = ''
        }}
      >
        <meshStandardMaterial
          key={`${ws.section ? 'clipped' : 'whole'}-${translucent ? 'see-through' : 'solid'}`}
          ref={mat}
          color={look.color ?? leaf.color}
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
      <lineSegments geometry={edges}>
        <lineBasicMaterial
          ref={edge}
          color={picked && !finding ? theme.accent : theme.edge}
          transparent
          opacity={picked && !finding ? 1 : theme.edgeOpacity * (finding ? (involved ? 0.6 : 0.15) : 0.8)}
          clippingPlanes={ws.section ? [SECTION] : []}
        />
      </lineSegments>
      {datums && <DatumMarks datums={datums} size={size} color={theme.accent} section={ws.section} />}
      {keepouts && <KeepOutMarks keepouts={keepouts} hot={finding?.kind === 'keepout' ? finding.keepout : null} />}
    </group>
  )
}

/** The finding in the assembly's frame: a clash or keep-out overlap in red, or a marked point with its value. */
function FindingMarks({ finding }: { finding: Finding }) {
  const label = finding.value !== undefined ? fmt(finding.value, finding.unit) : null
  return (
    <group>
      {finding.mesh && (
        <Suspense fallback={null}>
          <Overlap url={finding.mesh} />
        </Suspense>
      )}
      {finding.at && (
        <>
          {!finding.mesh && (
            <mesh position={finding.at} renderOrder={4}>
              <sphereGeometry args={[0.6, 16, 12]} />
              <meshBasicMaterial color={CLASH} depthTest={false} />
            </mesh>
          )}
          {label && (
            <Html position={finding.at} zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
              <div className="clash-tag">
                {label}
                {finding.kind === 'clash' ? ' overlap' : finding.kind === 'keepout' ? ' in keep-out' : finding.kind === 'tight_gap' ? ' gap' : ''}
              </div>
            </Html>
          )}
        </>
      )}
    </group>
  )
}

function Overlap({ url }: { url: string }) {
  const raw = useLoader(BrepLoader, url)
  return (
    <mesh geometry={raw} renderOrder={2}>
      <meshStandardMaterial color={CLASH} emissive={CLASH} emissiveIntensity={0.35} roughness={0.6} />
    </mesh>
  )
}
