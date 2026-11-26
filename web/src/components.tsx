// The account's components: vendor STEP models (boards, cameras, lenses) every project can place.
// A grid with upload, and a page per component with its mesh, datums and keep-outs.

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Canvas, useLoader } from '@react-three/fiber'
import { Bounds, OrbitControls } from '@react-three/drei'
import type { ComponentDoc, Datum, KeepOut, SuggestedDatum } from '../shared/protocol'
import { uploadFile } from './attach'
import { BrepLoader, useMeshProgress } from './brep'
import { DatumMarks, KeepOutMarks } from './marks'
import { TopBar } from './paper'
import { Icon } from './ui'
import { prepare } from './viewer-shared'

let importId = 0

type Pending = { id: number; name: string; progress: number; started?: number; error?: string }

const size = (c: ComponentDoc) => c.outline.max.map((v, i) => +(v - c.outline.min[i]).toFixed(1)).join(' × ')

export function ComponentsPage({ route }: { route: string }) {
  const id = route.match(/^\/components\/([a-z0-9][a-z0-9-]*)/)?.[1]
  return id ? <ComponentPage id={id} /> : <ComponentGrid />
}

function ComponentGrid() {
  const [items, setItems] = useState<ComponentDoc[] | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/components')
      .then((r) => r.json())
      .then(setItems, () => setItems([]))
  }, [])

  // The server reads the STEP after the upload; a 13 MB board takes it most of a minute.
  const add = useCallback(async (files: File[]) => {
    for (const f of files) {
      const id = ++importId
      const set = (patch: Partial<Pending>) => setPending((p) => p.map((x) => (x.id === id ? { ...x, ...patch } : x)))
      setPending((p) => [...p, { id, name: f.name, progress: 0 }])
      try {
        if (!/\.(step|stp)$/i.test(f.name)) throw new Error(`${f.name} isn't a STEP file.`)
        const file = await uploadFile(f, (progress) => set({ progress }))
        set({ progress: 1, started: Date.now() })
        const res = await fetch('/api/components', { method: 'POST', body: JSON.stringify({ key: file.key, file: f.name }) })
        const doc = (await res.json()) as ComponentDoc & { error?: string }
        if (!res.ok) throw new Error(doc.error ?? `Couldn't import ${f.name}`)
        setItems((all) => [doc, ...(all ?? []).filter((c) => c.id !== doc.id)])
        setPending((p) => p.filter((x) => x.id !== id))
      } catch (err) {
        set({ error: (err as Error).message })
      }
    }
  }, [])

  const sorted = [...(items ?? [])].sort((a, b) => b.createdAt - a.createdAt)
  return (
    <div className="projects library">
      <TopBar active="components" />
      <section className="shop-body">
        <div className="shop-head">
          <h1>Components</h1>
          {items && items.length > 0 && <span className="faint small">{items.length} components</span>}
        </div>
        {items?.length === 0 && pending.length === 0 && (
          <p className="shop-empty">
            Boards, cameras, connectors and lenses as their vendors' STEP files. Every project can place them; the import finds hole patterns and the mounting face to snap to.
          </p>
        )}
        <div className="component-grid">
          <button className="add-tile component-add" onClick={() => picker.current?.click()}>
            <span className="add-plus">+</span>
            <span>Add a STEP</span>
            <span className="faint">from the vendor, up to 95 MB</span>
          </button>
          <input
            ref={picker}
            type="file"
            accept=".step,.stp"
            multiple
            hidden
            data-testid="component-input"
            onChange={(e) => {
              add([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          {pending.map((p) => (
            <PendingTile key={p.id} p={p} onDismiss={() => setPending((all) => all.filter((x) => x.id !== p.id))} />
          ))}
          {sorted.map((c) => (
            <a key={c.id} className="component-card" href={`#/components/${c.id}`}>
              <div className="project-thumb project-thumb--sheet">{c.files.thumb ? <img src={c.files.thumb} alt="" loading="lazy" /> : null}</div>
              <span className="component-meta">
                <strong>{c.name}</strong>
                <span className="faint">
                  {[c.vendor, `${size(c)} mm`].filter(Boolean).join(' · ')}
                </span>
              </span>
            </a>
          ))}
        </div>
      </section>
    </div>
  )
}

function PendingTile({ p, onDismiss }: { p: Pending; onDismiss: () => void }) {
  // Seconds since the server started reading it, counted here.
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    if (!p.started || p.error) return
    const started = p.started
    const t = window.setInterval(() => setSecs(Math.round((Date.now() - started) / 1000)), 1000)
    return () => window.clearInterval(t)
  }, [p.started, p.error])
  return (
    <div className={`component-card component-pending${p.error ? ' is-failed' : ' is-loading'}`} role="status">
      <span className="library-progress">
        <span>{p.name}</span>
        {!p.started && !p.error && <span>{Math.round(p.progress * 100)}%</span>}
      </span>
      <span className="faint small">{p.error ?? (p.started ? `Reading the STEP and finding datums · ${secs} s` : 'Uploading')}</span>
      {p.error ? (
        <button className="link small" onClick={onDismiss}>
          Dismiss
        </button>
      ) : (
        <span className="library-bar" style={{ width: `${p.started ? 100 : p.progress * 100}%` }} />
      )}
    </div>
  )
}

const r = (n: number) => +n.toFixed(2)
const vec = (v: number[]) => `[${v.map(r).join(', ')}]`

function datumLine(d: Datum) {
  if (d.kind === 'plane') return `at ${vec(d.origin)}, normal ${vec(d.normal)}`
  if (d.kind === 'axis') return `at ${vec(d.origin)}, along ${vec(d.direction)}`
  if (d.kind === 'point') return `at ${vec(d.at)}`
  return `${d.points.length}${d.diameter ? ` × Ø${r(d.diameter)}` : ' points'}, normal ${vec(d.normal)}`
}

function keepoutLine(k: KeepOut) {
  if (k.kind === 'box') return `box ${vec(k.min)} to ${vec(k.max)}`
  if (k.kind === 'cylinder') return `cylinder r ${r(k.radius)} × ${r(k.length)} along ${vec(k.direction)}`
  return `cone ${r(k.angle)}° × ${r(k.length)} along ${vec(k.direction)}`
}

/** Was this datum taken as the importer found it? */
const asFound = (d: Datum, s?: SuggestedDatum) => !!s && JSON.stringify({ ...s, note: undefined }) === JSON.stringify({ ...d, note: undefined })

function ComponentPage({ id }: { id: string }) {
  const [doc, setDoc] = useState<ComponentDoc | null>(null)
  const [missing, setMissing] = useState(false)
  const [hot, setHot] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/components/${id}`).then(async (res) => (res.ok ? setDoc(await res.json()) : setMissing(true)))
  }, [id])

  const save = async (patch: Record<string, string>) => {
    setError(null)
    const res = await fetch(`/api/components/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    const body = await res.json()
    if (res.ok) setDoc(body)
    else setError(body.error ?? "Couldn't save")
  }

  if (missing)
    return (
      <div className="projects library">
        <TopBar active="components" />
        <section className="shop-body">
          <p className="shop-empty">
            No component <code>{id}</code>. <a href="#/components">All components</a>
          </p>
        </section>
      </div>
    )
  if (!doc) return null
  const unused = Object.entries(doc.suggested).filter(([name]) => !doc.datums[name])
  return (
    <div className="component-page">
      <div className="projects">
        <TopBar active="components" />
      </div>
      <div className="component-stage">
        <ComponentViewer doc={doc} hot={hot} />
      </div>
      <aside className="component-side" aria-label={doc.name}>
        <a className="link small" href="#/components">
          ← Components
        </a>
        <section className="paper-sheet">
          <div className="eyebrow">
            Component · {doc.metrics.solids} solid{doc.metrics.solids === 1 ? '' : 's'} · {doc.metrics.faces} faces
          </div>
          <Field key={doc.name} className="component-name" value={doc.name} label="Name" onSave={(v) => v.trim() && save({ name: v.trim() })} />
          <p className="sheet-summary">{size(doc)} mm · from {doc.source.name}</p>
          <dl className="props component-props">
            <div>
              <dt>Vendor</dt>
              <dd>
                <Field key={doc.vendor} value={doc.vendor ?? ''} label="Vendor" onSave={(v) => save({ vendor: v })} />
              </dd>
            </div>
            <div>
              <dt>Part no.</dt>
              <dd>
                <Field key={doc.partNumber} value={doc.partNumber ?? ''} label="Part number" onSave={(v) => save({ part_number: v })} />
              </dd>
            </div>
            <div>
              <dt>Link</dt>
              <dd className="component-link">
                <Field key={doc.link} value={doc.link ?? ''} label="Link" onSave={(v) => save({ link: v })} />
                {doc.link && /^https?:\/\//.test(doc.link) && (
                  <a href={doc.link} target="_blank" rel="noreferrer" aria-label="Open link">
                    ↗
                  </a>
                )}
              </dd>
            </div>
            <div>
              <dt>Id</dt>
              <dd className="faint">{doc.id}</dd>
            </div>
          </dl>
          <NotesField key={doc.notes} value={doc.notes ?? ''} onSave={(v) => save({ notes: v })} />
          {error && <p className="auth-error">{error}</p>}
          <div className="component-list">
            <span className="eyebrow">Datums · {Object.keys(doc.datums).length}</span>
            {Object.entries(doc.datums).map(([name, d]) => (
              <div key={name} className={`datum-row${hot === name ? ' is-hot' : ''}`} onMouseEnter={() => setHot(name)} onMouseLeave={() => setHot(null)}>
                <span className="datum-name">
                  {name} <span className="faint">{d.kind}</span>
                  {asFound(d, doc.suggested[name]) && (
                    <span className="badge badge--found" title={doc.suggested[name].note}>
                      found on import
                    </span>
                  )}
                </span>
                <span className="faint">{datumLine(d)}</span>
              </div>
            ))}
            {unused.map(([name, s]) => (
              <div key={name} className="datum-row is-unused" title={s.note}>
                <span className="datum-name">
                  {name} <span className="faint">{s.kind} · suggested, not used</span>
                </span>
                <span className="faint">{s.note}</span>
              </div>
            ))}
          </div>
          <div className="component-list">
            <span className="eyebrow">Keep-outs · {doc.keepouts.length}</span>
            {doc.keepouts.length === 0 && <span className="faint">None yet. Ask the AI to add plug clearance or a lens's field of view.</span>}
            {doc.keepouts.map((k, i) => (
              <div key={i} className="datum-row">
                <span className="datum-name">{k.label}</span>
                <span className="faint">{keepoutLine(k)}</span>
              </div>
            ))}
          </div>
          <div className="item-actions">
            <a className="link" href={doc.files.step} download>
              STEP
            </a>
            <button
              className="link item-delete"
              onClick={async () => {
                if (!confirm(`Delete ${doc.name}? Assemblies that place it can't be rebuilt until it's swapped.`)) return
                const res = await fetch(`/api/components/${doc.id}`, { method: 'DELETE' })
                if (res.ok) location.hash = '#/components'
                else setError("Couldn't delete it")
              }}
            >
              Delete
            </button>
          </div>
        </section>
      </aside>
    </div>
  )
}

/** A value edited in place, saved when it loses focus. Keyed by its value, so a save resets it. */
function Field({ value, label, onSave, className }: { value: string; label: string; onSave: (v: string) => void; className?: string }) {
  const [v, setV] = useState(value)
  return (
    <input
      className={`inline-input${className ? ` ${className}` : ''}`}
      value={v}
      aria-label={label}
      placeholder="—"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onSave(v)}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

function NotesField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value)
  return <textarea className="library-note-edit" value={v} rows={3} placeholder="Notes (datasheet details, what to watch for)" onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onSave(v)} />
}

const ACCENT = '#1f7a4d'

function ComponentViewer({ doc, hot }: { doc: ComponentDoc; hot: string | null }) {
  const loading = useMeshProgress([doc.files.mesh])[0]
  return (
    <>
      <Canvas className="viewer" camera={{ position: [120, 90, 140], fov: 30, near: 0.5, far: 5000 }} gl={{ antialias: true, alpha: true }} dpr={[1, 2]}>
        <hemisphereLight args={['#ffffff', '#8a8f99', 1.25]} />
        <directionalLight position={[120, 200, 160]} intensity={1.6} />
        <directionalLight position={[-160, 60, -120]} intensity={0.5} />
        <Suspense fallback={null}>
          <Bounds fit clip observe margin={1.3}>
            {/* build123d is Z-up; three.js is Y-up. */}
            <group rotation={[-Math.PI / 2, 0, 0]}>
              <ComponentMesh doc={doc} hot={hot} />
            </group>
          </Bounds>
        </Suspense>
        <OrbitControls makeDefault enableDamping dampingFactor={0.12} />
      </Canvas>
      {loading && (
        <div className="mesh-loading component-loading" role="status">
          <span>
            Loading the mesh · {(loading.loaded / 1024 ** 2).toFixed(1)}
            {loading.total ? ` / ${(loading.total / 1024 ** 2).toFixed(1)}` : ''} MB
          </span>
          {loading.total > 0 && <span className="mesh-bar" style={{ width: `${(loading.loaded / loading.total) * 100}%` }} />}
        </div>
      )}
      <span className="component-hint faint small">
        <Icon name="cube" size={12} /> datums in green, keep-outs in amber · drag to turn
      </span>
    </>
  )
}

function ComponentMesh({ doc, hot }: { doc: ComponentDoc; hot: string | null }) {
  const raw = useLoader(BrepLoader, doc.files.mesh)
  const { geometry, edges, radius } = prepare(raw)
  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial color="#9ea2a8" metalness={0.18} roughness={0.55} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color="#2b2b26" transparent opacity={0.45} />
      </lineSegments>
      <DatumMarks datums={doc.datums} size={Math.min(40, Math.max(4, radius * 0.45))} color={ACCENT} hot={hot} />
      <KeepOutMarks keepouts={doc.keepouts} />
    </group>
  )
}
