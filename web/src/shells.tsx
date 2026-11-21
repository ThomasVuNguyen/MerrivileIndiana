import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { gearTrain, VERSIONS } from './data'
import type { Part } from './data'
import { Viewer } from './Viewer'
import type { ViewerTheme } from './Viewer'
import { Appearance, ChatThread, Composer, ExportMenu, Icon, IconButton, ImportButton, ModelPicker, Properties, Source, Toast, totalMass } from './ui'
import { TierMark, TIER_LABEL } from './paper'
import { plainFirst } from './prose'
import { Avatar } from './session'
import { useWorkspace } from './workspace'

const PROJECT = 'QDD Actuator 110'

/* ------------------------------------------------------------------ A */
/* Studio: HeyPCB's shell. Chat docked left, canvas, studios along the bottom. */

const THEME_A: ViewerTheme = { edge: '#1d1f23', edgeOpacity: 0.55, accent: '#2f6fd6', gizmo: 'cube', ambient: 1.1 }

export function OptionA() {
  const ws = useWorkspace()
  const [view, setView] = useState<'3d' | 'source'>('3d')
  const [chatOpen, setChatOpen] = useState(true)
  const part = ws.selectedPart
  return (
    <div className="app optA">
      <header className="topbar">
        <div className="topbar-left">
          <IconButton icon="sidebar" label="Toggle chat" onClick={() => setChatOpen((o) => !o)} active={!chatOpen} />
          <nav className="crumbs">
            <a href="#/projects">Projects</a>
            <span>/</span>
            <strong>{PROJECT}</strong>
          </nav>
        </div>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={view === '3d'} onClick={() => setView('3d')}>
            Model
          </button>
          <button role="tab" aria-selected={view === 'source'} onClick={() => setView('source')}>
            Source
          </button>
        </div>
        <div className="topbar-right">
          <Versions />
          <ImportButton />
          <ExportMenu />
          <span className="avatar">TN</span>
        </div>
      </header>
      <div className="body">
        {chatOpen && (
          <aside className="chat">
            <div className="chat-head">
              <span className="pill">Chat</span>
              <IconButton icon="plus" label="New chat" />
            </div>
            <ChatThread />
            <Composer />
          </aside>
        )}
        <main className="stage">
          {view === '3d' ? (
            <>
              <Viewer theme={THEME_A} />
              <div className="rail">
                <RailButton icon="fit" label="Fit" kbd="F" onClick={ws.fit} />
                <RailButton icon="explode" label="Explode" kbd="E" active={ws.exploded} onClick={() => ws.setExploded((x) => !x)} />
                <RailButton icon="section" label="Section" kbd="S" active={ws.section} onClick={() => ws.setSection((x) => !x)} />
              </div>
              {part && <InspectorCard part={part} />}
            </>
          ) : (
            <SourceView />
          )}
          <Toast />
        </main>
      </div>
      <StudioTabs />
    </div>
  )
}

function RailButton({ icon, label, kbd, active, onClick }: { icon: string; label: string; kbd: string; active?: boolean; onClick: () => void }) {
  return (
    <button className={`rail-btn${active ? ' is-active' : ''}`} onClick={onClick} aria-pressed={active} title={`${label} (${kbd})`}>
      <Icon name={icon} />
      <span>{label}</span>
      <kbd>{kbd}</kbd>
    </button>
  )
}

function InspectorCard({ part }: { part: Part }) {
  const ws = useWorkspace()
  const [tab, setTab] = useState<'props' | 'source'>('props')
  const look = ws.look[part.id]
  return (
    <section className="inspector" aria-label="Selected part">
      <header>
        <div>
          <div className="eyebrow">{part.group}</div>
          <h2>{part.name}</h2>
        </div>
        <div className="inspector-actions">
          <IconButton icon={look?.visible === false ? 'eyeOff' : 'eye'} label="Hide" kbd="H" onClick={() => ws.setAppearance(part.id, { visible: !look?.visible })} />
          <IconButton icon="close" label="Deselect" kbd="Esc" onClick={() => ws.setSelected(null)} />
        </div>
      </header>
      <Appearance part={part} />
      <div className="tabs-mini">
        <button aria-selected={tab === 'props'} onClick={() => setTab('props')}>
          Properties
        </button>
        <button aria-selected={tab === 'source'} onClick={() => setTab('source')}>
          build123d
        </button>
      </div>
      {tab === 'props' ? <Properties part={part} /> : <Source part={part} />}
    </section>
  )
}

function SourceView() {
  const ws = useWorkspace()
  return (
    <div className="source-view">
      {ws.visibleParts
        .filter((p) => p.fn)
        .map((p) => (
          <section key={p.id}>
            <div className="eyebrow">
              {p.group} · {p.name}
            </div>
            <Source part={p} />
          </section>
        ))}
    </div>
  )
}

function StudioTabs({ variant = 'a' }: { variant?: 'a' | 'b' }) {
  const ws = useWorkspace()
  const all = [{ name: 'All', count: ws.parts.length }, ...ws.groups]
  return (
    <nav className={`studios studios--${variant}`} aria-label="Studios">
      {variant === 'a' && <Icon name="layers" size={15} />}
      {all.map((s, i) => (
        <button key={s.name} className={ws.group === s.name ? 'is-on' : ''} onClick={() => ws.setGroup(s.name)}>
          {variant === 'a' && i > 0 && <span className="num">{i}</span>}
          {s.name}
          {variant === 'a' && <span className="count">{s.count}</span>}
        </button>
      ))}
    </nav>
  )
}

function Versions() {
  const [open, setOpen] = useState(false)
  return (
    <div className="menu-anchor">
      <IconButton icon="history" label="Versions" onClick={() => setOpen((o) => !o)} active={open} />
      {open && (
        <div className="menu menu--right menu--wide" role="menu">
          <div className="menu-label">Versions</div>
          {VERSIONS.map((v, i) => (
            <button key={v.id} role="menuitem" className="version">
              <span className="version-id">{v.id}</span>
              <span className="version-label">{v.label}</span>
              <span className="version-when">{i === 0 ? 'current' : v.when}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ B */
/* Paper: Muse's viewer. Full-bleed engineering paper, prompt floats at the bottom. */

const THEME_B: ViewerTheme = { edge: '#2b2b26', edgeOpacity: 0.7, accent: '#1f7a4d', gizmo: 'none', ambient: 1.25 }

export function OptionB() {
  const ws = useWorkspace()
  const [expanded, setExpanded] = useState(false)
  const sel = ws.selectedPart
  const solo = ws.view === 'part' && sel
  const empty = ws.live && ws.connected && ws.parts.length === 0
  return (
    <div className="app optB">
      <Viewer theme={THEME_B} callout={ws.view === 'assembly' ? (p) => <Callout part={p} num={partNumber(ws, p)} /> : undefined} />
      {empty && (
        <div className="stage-empty">
          <span className="eyebrow">Empty project</span>
          <p>Describe a part below. The AI writes it in build123d and it appears here.</p>
        </div>
      )}
      <header className="paper-top">
        <a className="wordmark" href="#/projects">
          merrivile
        </a>
        <span className="paper-project">/ {ws.projectName || '…'}</span>
        {(solo || !ws.live) && (
          <>
            <span className="paper-project paper-project--doc">/ {solo ? sel.name : ws.group === 'All' ? 'Main assembly' : ws.group}</span>
            <span className="doc-kind">{solo ? 'part' : 'assembly'}</span>
          </>
        )}
        {ws.live && !ws.connected && <span className="doc-kind doc-kind--warn">reconnecting</span>}
      </header>
      <nav className="paper-links">
        <ImportButton className="link">Import</ImportButton>
        <ExportMenu className="link" label="Export" />
        <a className="link" href="#/shop">
          Shop
        </a>
        <a className="link" href="#/library">
          Library
        </a>
        <Avatar />
      </nav>
      <Documents />
      {solo ? (
        <PartSheet part={sel} />
      ) : (
        sel && (
          <aside className="paper-card paper-appearance">
            <div className="eyebrow">Appearance · {sel.name}</div>
            <Appearance part={sel} />
          </aside>
        )
      )}
      {ws.view === 'assembly' && <MotionAndFit />}
      <div className={`dock${expanded ? ' is-expanded' : ''}`}>
        {expanded ? (
          <div className="dock-thread">
            <ChatThread compact />
          </div>
        ) : (
          <LastReply />
        )}
        <div className="dock-bar">
          <button className="dock-toggle" onClick={() => setExpanded((x) => !x)} aria-label={expanded ? 'Collapse chat' : 'Expand chat'}>
            <Icon name="chevron" size={14} />
          </button>
          <Composer placeholder={empty ? 'A NEMA 17 mount with a 5 mm slot for belt tension…' : 'Tell it what to build or change…'} footer={ws.live ? <ModelPicker /> : <span />} />
        </div>
      </div>
      <div className="paper-keys">
        {ws.view === 'assembly' ? (
          <>
            <span className={ws.exploded ? 'on' : ''}>E explode</span>
            <span className={ws.section ? 'on' : ''}>S section</span>
            <span className={ws.playing ? 'on' : ''}>Space run</span>
            <span>↵ open part</span>
          </>
        ) : ws.live ? (
          <>
            <span className={ws.faces.length ? 'on' : ''}>click a face to point at it</span>
            <span>shift-click adds</span>
            <span className={ws.section ? 'on' : ''}>S section</span>
          </>
        ) : (
          <>
            <span className={ws.section ? 'on' : ''}>S section</span>
            <span>Esc back to {ws.group === 'All' ? 'main assembly' : ws.group}</span>
          </>
        )}
        <span>F fit</span>
      </div>
      <Toast />
    </div>
  )
}

function partNumber(ws: ReturnType<typeof useWorkspace>, p: Part) {
  return String(ws.parts.indexOf(p) + 1).padStart(2, '0')
}

// Rendered by drei's <Html> in its own React root, so it can't use context.
function Callout({ part, num }: { part: Part; num: string }) {
  return (
    <div className="callout">
      <div className="callout-line" />
      <div className="callout-card">
        <div className="eyebrow">
          {num} / {part.group.toUpperCase()}
          {part.qty > 1 && ` · ×${part.qty}`}
        </div>
        <strong>{part.name}</strong>
        <div className="callout-meta">
          {part.bbox.map((v) => +v.toFixed(1)).join(' × ')} mm · {part.mass_g} g
        </div>
        <div className="callout-meta">{part.material}</div>
        <div className="callout-hint">double-click to open the part</div>
      </div>
    </div>
  )
}

/** Assemblies and parts are separate documents, as in Onshape. */
function Documents() {
  const ws = useWorkspace()
  const inView = new Set(ws.visibleInstances.map((i) => i.part))
  const placed = (g: string) => ws.asm.instances.filter((i) => i.group === g).length
  const asmOpen = (name: string) => ws.view === 'assembly' && ws.group === name
  return (
    <nav className="partlist" aria-label="Documents">
      {ws.asm.instances.length > 0 && (
        <>
          <div className="partlist-head">
            <span className="eyebrow">Assemblies</span>
          </div>
          <button className={`doc-row doc-row--root${asmOpen('All') ? ' is-open' : ''}`} onClick={() => ws.openAssembly('All')}>
            <span className="name">Main assembly</span>
            <span className="qty">{ws.asm.instances.length}</span>
          </button>
          {ws.groups.map((g) => (
            <button key={g.name} className={`doc-row doc-row--sub${asmOpen(g.name) ? ' is-open' : ''}`} onClick={() => ws.openAssembly(g.name)}>
              <span className="name">{g.name}</span>
              <span className="qty">{placed(g.name)}</span>
            </button>
          ))}
        </>
      )}
      <div className={`partlist-head${ws.asm.instances.length ? ' partlist-head--parts' : ''}`}>
        <span className="eyebrow">Parts</span>
        <span>{ws.parts.length}</span>
      </div>
      {ws.parts.map((p) => (
        <PartRow key={p.id} part={p} dim={ws.view === 'assembly' && !inView.has(p.id)} />
      ))}
      {ws.live && ws.parts.length === 0 && <p className="partlist-empty">Parts the AI builds show up here.</p>}
    </nav>
  )
}

function PartRow({ part, dim }: { part: Part; dim: boolean }) {
  const ws = useWorkspace()
  const look = ws.look[part.id]
  const hidden = look?.visible === false
  const open = ws.view === 'part' && ws.selected === part.id
  const picked = ws.view === 'assembly' && ws.selected === part.id
  return (
    <div
      className={`partlist-row${open ? ' is-open' : ''}${picked ? ' is-on' : ''}${ws.hovered === part.id ? ' is-hover' : ''}${hidden ? ' is-hidden' : ''}${dim ? ' is-dim' : ''}`}
      onClick={() => ws.openPart(part.id)}
      onMouseEnter={() => ws.setHovered(part.id)}
      onMouseLeave={() => ws.setHovered(null)}
      title={`Open ${part.name}`}
    >
      <span className="num">{partNumber(ws, part)}</span>
      <span className="swatch-dot" style={{ background: look?.color, opacity: look?.opacity }} />
      <span className="name">{part.name}</span>
      {part.qty > 1 && <span className="qty">×{part.qty}</span>}
      {part.live && <span className={`qty${part.live.status === 'error' ? ' is-bad' : ''}`}>{part.live.status === 'error' ? 'error' : `v${part.live.version}`}</span>}
      {ws.view === 'assembly' && !dim && (
        <button
          className="eye"
          aria-label={hidden ? `Show ${part.name}` : `Hide ${part.name}`}
          onClick={(e) => {
            e.stopPropagation()
            ws.setAppearance(part.id, { visible: hidden })
          }}
        >
          <Icon name={hidden ? 'eyeOff' : 'eye'} size={13} />
        </button>
      )}
    </div>
  )
}

function PartSheet({ part }: { part: Part }) {
  const ws = useWorkspace()
  const doc = part.live
  const rows: [string, string][] = [
    ['Material', part.material],
    ['Mass', part.mass_g ? `${part.mass_g} g${doc ? '' : ' each'}` : '—'],
    ['Size', part.bbox.map((v) => +v.toFixed(1)).join(' × ') + ' mm'],
    ['Volume', part.volume_mm3 ? `${(part.volume_mm3 / 1000).toFixed(2)} cm³` : '—'],
    ['Faces', String(part.faces)],
  ]
  if (doc) rows.push(['Version', doc.version ? `v${doc.version}` : 'not built yet'])
  return (
    <aside className="paper-card paper-sheet" aria-label="Part">
      <div className="eyebrow">
        {partNumber(ws, part)} / {part.group.toUpperCase()}
      </div>
      <h2>{part.name}</h2>
      {doc?.status === 'error' && doc.error && (
        <div className="build-error" role="status">
          <strong>
            Last build failed: {doc.error.type}
            {doc.error.line ? ` at line ${doc.error.line}` : ''}
          </strong>
          <span>{doc.version ? `Showing v${doc.version}, the last good build.` : 'Nothing has built yet.'}</span>
        </div>
      )}
      <dl className="props">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
        {!doc && (
          <div>
            <dt>Used in</dt>
            <dd>
              <button className="link" onClick={() => ws.openAssembly(part.group)}>
                {part.group}
              </button>{' '}
              ×{part.qty}
            </dd>
          </div>
        )}
      </dl>
      <Appearance part={part} />
      <div className="sheet-export">
        <span className="eyebrow">Export</span>
        <button className="link" disabled={!!doc && !doc.files} onClick={() => ws.exportFile('step', 'part', part.id)}>
          STEP
        </button>
        <button className="link" disabled={!!doc && !doc.files} onClick={() => ws.exportFile('stl', 'part', part.id)}>
          STL
        </button>
      </div>
      {doc && <PartLists part={part} />}
      <details className="sheet-source">
        <summary>build123d · {doc ? `${part.id}.py` : `${part.fn ?? 'imported'}()`}</summary>
        <Source part={part} />
      </details>
    </aside>
  )
}

/** What goes into the part, what it's made with, and its versions. */
function PartLists({ part }: { part: Part }) {
  const ws = useWorkspace()
  const doc = part.live!
  const hardware = doc.hardware ?? []
  const toBuy = hardware.filter((h) => h.tier !== 'on-hand').length
  return (
    <>
      {hardware.length > 0 && (
        <div className="sheet-block">
          <div className="sheet-block-head">
            <span className="eyebrow">Hardware</span>
            {toBuy > 0 && <span className="faint">{toBuy} to buy</span>}
          </div>
          {hardware.map((h, i) => (
            <div key={i} className="hw-row">
              <span className="hw-qty">{h.qty}×</span>
              <span className="hw-spec">
                {h.name}
                {h.kind && !h.name.toLowerCase().includes(h.kind.toLowerCase()) && ` ${h.kind.toLowerCase()}`}
                {h.source && <span>{h.source}</span>}
              </span>
              <span className="tier" title={TIER_LABEL[h.tier]}>
                <TierMark tier={h.tier} />
                {TIER_LABEL[h.tier]}
              </span>
            </div>
          ))}
        </div>
      )}
      {doc.madeWith && doc.madeWith.length > 0 && (
        <div className="sheet-block">
          <div className="sheet-block-head">
            <span className="eyebrow">Made with</span>
          </div>
          <div className="caps">
            {doc.madeWith.map((t) => (
              <span key={t} className="cap">
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
      {doc.versions && doc.versions.length > 1 && (
        <div className="sheet-block">
          <div className="sheet-block-head">
            <span className="eyebrow">Versions</span>
          </div>
          {doc.versions.map((v) => (
            <div key={v.version} className={`ver-row${v.version === doc.version ? ' is-current' : ''}`}>
              <span className="ver-v">v{v.version}</span>
              <span className="ver-what">
                {v.note || '—'}
                <span>{ago(v.at)}</span>
              </span>
              {v.version === doc.version ? (
                <span className="faint">current</span>
              ) : (
                <button className="link" disabled={ws.busy} onClick={() => ws.restore(part.id, v.version)} title={`Rebuild v${v.version} as a new version`}>
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function instanceLabel(ws: ReturnType<typeof useWorkspace>, id: string) {
  const inst = ws.asm.instances.find((i) => i.id === id)
  const part = ws.parts.find((p) => p.id === inst?.part)
  if (!part) return id
  return part.qty > 1 ? `${part.name} ${id.split('-').pop()}` : part.name
}

function MotionAndFit() {
  const ws = useWorkspace()
  const [deg, setDeg] = useState(ws.drive.current)
  const { ratio, carrier } = gearTrain(deg, ws.asm.gears)

  // Mirror the animated rotor angle into the readout while running.
  useEffect(() => {
    if (!ws.playing) return
    let raf = 0
    const tick = () => {
      setDeg(ws.drive.current)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [ws.playing, ws.drive])

  // Only what's in the open assembly: its moving instances and its own clashes.
  const ids = new Set(ws.visibleInstances.map((i) => i.id))
  const clashes = ws.asm.checks.interferences.map((c, i) => ({ ...c, i })).filter((c) => ids.has(c.a) && ids.has(c.b))
  const moves = ws.visibleInstances.some((i) => i.motion !== 'fixed')
  return (
    <aside className="paper-card paper-motion" aria-label="Motion and fit">
      {moves && (
        <>
          <div className="motion-head">
            <span className="eyebrow">Motion</span>
            <span>ring fixed · {ratio.toFixed(2)} : 1</span>
          </div>
          <div className="motion-row">
            <button className="play" onClick={() => ws.setPlaying((x) => !x)} aria-label={ws.playing ? 'Pause' : 'Run'}>
              {ws.playing ? '❚❚' : '▶'}
            </button>
            <input
              type="range"
              min={0}
              max={359}
              value={Math.round(deg)}
              aria-label="Rotor angle"
              onChange={(e) => {
                ws.setPlaying(false)
                ws.drive.current = +e.target.value
                setDeg(+e.target.value)
              }}
            />
          </div>
          <div className="motion-readout">
            <span>rotor {Math.round(deg)}°</span>
            <span>→</span>
            <span>output {carrier.toFixed(1)}°</span>
          </div>
          <div className="motion-sep" />
        </>
      )}
      <div className="motion-head">
        <span className="eyebrow">Fit</span>
        {ws.fitOpen && (
          <span className={clashes.length ? 'bad' : 'good'}>
            {clashes.length ? `${clashes.length} interferences` : 'clear'} at {ws.asm.checks.pose_deg}°
          </span>
        )}
      </div>
      {!ws.fitOpen ? (
        <button className="link" onClick={() => ws.setFitOpen(true)}>
          Check fit
        </button>
      ) : (
        <ul className="clashes">
          {clashes.map((c) => (
            <li key={c.i}>
              <button
                className={ws.clash === c.i ? 'is-on' : ''}
                onClick={() => {
                  ws.setPlaying(false)
                  ws.drive.current = ws.asm.checks.pose_deg
                  setDeg(ws.asm.checks.pose_deg)
                  ws.setExploded(false)
                  ws.setClash(ws.clash === c.i ? null : c.i)
                }}
              >
                <span>
                  {instanceLabel(ws, c.a)} × {instanceLabel(ws, c.b)}
                </span>
                <span className="vol">{c.volume_mm3.toFixed(1)} mm³</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

function LastReply() {
  const ws = useWorkspace()
  const last = [...ws.messages].reverse().find((m) => m.role === 'ai')
  if (!last || last.role !== 'ai') return null
  return (
    <div className="last-reply">
      {ws.busy && !(ws.live && last.text) ? <span className="muted">{runningLabel(last) ?? 'thinking…'}</span> : plainFirst(last.text)}
      {last.calls && last.calls.length > 0 && (
        <span className="last-calls">
          {ws.busy && ws.live ? runningLabel(last) ?? `${last.calls.length} tool calls` : `${last.calls.length} tool ${last.calls.length === 1 ? 'call' : 'calls'}`}
        </span>
      )}
    </div>
  )
}

function runningLabel(m: { calls?: { tool: string; detail: string; state: string }[] }) {
  const c = m.calls?.find((x) => x.state === 'running')
  return c ? `${c.tool} · ${c.detail}` : null
}

/* ------------------------------------------------------------------ C */
/* Instrument: dark. Outline left, chat right, status bar below. */

const THEME_C: ViewerTheme = { edge: '#0b0c0e', edgeOpacity: 0.75, accent: '#ff6a1a', gizmo: 'axes', ambient: 0.9 }

export function OptionC() {
  const ws = useWorkspace()
  const sel = ws.selectedPart
  return (
    <div className="app optC">
      <header className="topbar">
        <div className="topbar-left">
          <a className="logo" href="#/projects" aria-label="Projects">
            <span />
          </a>
          <strong>{PROJECT}</strong>
          <span className="chip">v14</span>
        </div>
        <div className="topbar-right">
          <ImportButton />
          <ExportMenu />
          <span className="avatar">TN</span>
        </div>
      </header>
      <div className="body">
        <aside className="outline">
          <Outline />
          {sel && (
            <section className="outline-inspect">
              <div className="eyebrow">{sel.name}</div>
              <Appearance part={sel} />
              <Properties part={sel} />
            </section>
          )}
        </aside>
        <main className="stage">
          <Viewer theme={THEME_C} />
          <div className="floatbar">
            <IconButton icon="fit" label="Fit" kbd="F" onClick={ws.fit} />
            <IconButton icon="explode" label="Explode" kbd="E" active={ws.exploded} onClick={() => ws.setExploded((x) => !x)} />
            <IconButton icon="section" label="Section" kbd="S" active={ws.section} onClick={() => ws.setSection((x) => !x)} />
          </div>
          <Toast />
        </main>
        <aside className="chat">
          <ChatThread />
          <Composer />
        </aside>
      </div>
      <footer className="status">
        <span>{ws.parts.length} parts</span>
        <span>{(totalMass(ws.parts) / 1000).toFixed(2)} kg</span>
        <span>mm</span>
        {sel ? (
          <span className="status-sel">
            {sel.name} · {(sel.volume_mm3 / 1000).toFixed(1)} cm³
          </span>
        ) : (
          <span className="muted">nothing selected</span>
        )}
        <span className="status-keys">F fit · E explode · S section · H hide</span>
      </footer>
    </div>
  )
}

function Outline() {
  const ws = useWorkspace()
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  return (
    <div className="tree">
      {ws.groups.map((s) => (
        <div key={s.name} className="tree-group">
          <button className="tree-head" onClick={() => setCollapsed((c) => ({ ...c, [s.name]: !c[s.name] }))}>
            <span className={`caret${collapsed[s.name] ? ' is-closed' : ''}`}>
              <Icon name="chevron" size={12} />
            </span>
            {s.name}
            <span className="count">{s.count}</span>
          </button>
          {!collapsed[s.name] &&
            ws.parts
              .filter((p) => p.group === s.name)
              .map((p) => <OutlineRow key={p.id} part={p} />)}
        </div>
      ))}
    </div>
  )
}

function OutlineRow({ part }: { part: Part }): ReactNode {
  const ws = useWorkspace()
  const look = ws.look[part.id]
  const on = ws.selected === part.id
  return (
    <div
      className={`tree-row${on ? ' is-on' : ''}${look?.visible === false ? ' is-hidden' : ''}${ws.hovered === part.id ? ' is-hover' : ''}`}
      onClick={() => ws.setSelected(part.id)}
      onMouseEnter={() => ws.setHovered(part.id)}
      onMouseLeave={() => ws.setHovered(null)}
    >
      <span className="dot" style={{ background: look?.color, opacity: look?.opacity }} />
      <span className="tree-name">{part.name}</span>
      <button
        className="tree-eye"
        aria-label={look?.visible === false ? 'Show' : 'Hide'}
        onClick={(e) => {
          e.stopPropagation()
          ws.setAppearance(part.id, { visible: look?.visible === false })
        }}
      >
        <Icon name={look?.visible === false ? 'eyeOff' : 'eye'} size={14} />
      </button>
    </div>
  )
}
