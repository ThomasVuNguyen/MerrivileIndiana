// The open assembly in the Paper shell: its sheet (instances, the picked one's placement and
// datums) on the left, and its check on the right.

import { useEffect, useRef } from 'react'
import type { AssemblyDoc, AssemblyInstance, Finding, SnapResult } from '../shared/protocol'
import { ago, FINDING_LABEL, fmt, instanceAt, lookOf, refKind, sortedFindings, warningsFor, within } from './asm'
import { useMeshProgress } from './brep'
import { SWATCHES } from './data'
import { Fold, Icon } from './ui'
import { useWorkspace } from './workspace'

type Ws = ReturnType<typeof useWorkspace>

/** A row per assembly in the documents list: name, version, instances, warnings, out of date. */
export function AssemblyRow({ doc }: { doc: AssemblyDoc }) {
  const ws = useWorkspace()
  const open = ws.liveAsm?.id === doc.id
  const warnings = doc.report?.warnings ?? 0
  return (
    <button className={`doc-row${open ? ' is-open' : ''}`} onClick={() => ws.openLiveAssembly(doc.id)} title={`Open ${doc.name}`}>
      <span className="name">{doc.name}</span>
      {doc.stale?.length ? (
        <span className="badge badge--stale" title="Parts changed since the last check">
          stale
        </span>
      ) : null}
      {warnings > 0 && (
        <span className="badge badge--warn" title={`${warnings} warning${warnings === 1 ? '' : 's'} from the last check`}>
          {warnings}
        </span>
      )}
      <span className="qty" title={`${doc.instances.length} instances`}>
        ×{doc.instances.length}
      </span>
      <span className="qty">v{doc.version}</span>
    </button>
  )
}

export function AssemblySheet({ doc }: { doc: AssemblyDoc }) {
  const ws = useWorkspace()
  const loading = useMeshProgress([...new Set(doc.leaves.map((l) => l.mesh))])
  const isolatedName = ws.isolated ? nameOf(ws, doc, ws.isolated) : null
  const leaves = doc.leaves.length
  return (
    <section className="paper-sheet asm-sheet" aria-label="Assembly">
      <div className="eyebrow">
        Assembly · v{doc.version} · {leaves} {leaves === 1 ? 'shape' : 'shapes'}
      </div>
      <h2>{doc.name}</h2>
      {doc.stale?.length ? (
        <div className="stale-note" role="status">
          <strong>Parts changed since the last check</strong>
          <span>
            {doc.stale.map((s) => staleName(ws, s.ref) + (s.version ? ` (now v${s.version})` : '')).join(', ')} changed. It shows the old placement until it's saved again;
            ask the AI to re-place it.
          </span>
        </div>
      ) : null}
      {loading.length > 0 && <LoadingLine doc={doc} loading={loading} />}
      <Check doc={doc} />
      <Fold name="Instances" count={doc.instances.length} part={doc.id}>
        {isolatedName && (
          <button className="link asm-showall" onClick={() => ws.setIsolated(null)}>
            Showing only {isolatedName} · show all
          </button>
        )}
        <div className="asm-list" role="tree">
          <InstanceRows ws={ws} doc={doc} owner={doc} prefix="" depth={0} />
        </div>
      </Fold>
    </section>
  )
}

/** "part:base" → the part's name, "assembly:x" → the assembly's. */
function staleName(ws: Ws, ref: string) {
  const [kind, id] = ref.split(':')
  if (kind === 'part') return ws.parts.find((p) => p.id === id)?.name ?? id
  return ws.assemblies.find((a) => a.id === id)?.name ?? id ?? ref
}

function LoadingLine({ doc, loading }: { doc: AssemblyDoc; loading: { url: string; loaded: number; total: number }[] }) {
  const loaded = loading.reduce((n, l) => n + l.loaded, 0)
  const total = loading.reduce((n, l) => n + l.total, 0)
  const names = [...new Set(doc.leaves.filter((l) => loading.some((x) => x.url === l.mesh)).map((l) => l.name))]
  const mb = (b: number) => (b / 1024 ** 2).toFixed(1)
  return (
    <div className="mesh-loading" role="status">
      <span>
        Loading {names.join(', ')} · {mb(loaded)}
        {total ? ` / ${mb(total)}` : ''} MB
      </span>
      {total > 0 && <span className="mesh-bar" style={{ width: `${(loaded / total) * 100}%` }} />}
    </div>
  )
}

function InstanceRows({ ws, doc, owner, prefix, depth }: { ws: Ws; doc: AssemblyDoc; owner: AssemblyDoc; prefix: string; depth: number }) {
  return (
    <>
      {owner.instances.map((inst) => {
        const path = prefix ? `${prefix}/${inst.id}` : inst.id
        const sub = 'assembly' in inst.ref ? ws.assemblies.find((a) => a.id === (inst.ref as { assembly: string }).assembly) : undefined
        return (
          <div key={path} role="treeitem" aria-expanded={sub ? true : undefined} aria-selected={ws.pick === path}>
            <InstanceRow ws={ws} doc={doc} inst={inst} path={path} depth={depth} />
            {ws.pick === path && <InstanceDetail ws={ws} doc={doc} inst={inst} path={path} />}
            {sub && <InstanceRows ws={ws} doc={doc} owner={sub} prefix={path} depth={depth + 1} />}
          </div>
        )
      })}
    </>
  )
}

function InstanceRow({ ws, doc, inst, path, depth }: { ws: Ws; doc: AssemblyDoc; inst: AssemblyInstance; path: string; depth: number }) {
  const row = useRef<HTMLDivElement>(null)
  const look = lookOf(ws.looks, doc.id, path)
  const leaf = doc.leaves.find((l) => l.path === path)
  const on = ws.pick === path
  const warnings = warningsFor(doc, path)
  const kind = refKind(inst)
  const isolatedOut = !!ws.isolated && !within(path, ws.isolated) && !within(ws.isolated, path)
  const progress = useMeshProgress(leaf ? [leaf.mesh] : [])[0]

  // Picked in the viewer: bring it into view in the list.
  useEffect(() => {
    if (on) row.current?.scrollIntoView({ block: 'nearest' })
  }, [on])

  return (
    <div
      ref={row}
      className={`partlist-row asm-row${on ? ' is-on' : ''}${ws.hovered === `@${path}` ? ' is-hover' : ''}${look.hidden ? ' is-hidden' : ''}${isolatedOut ? ' is-dim' : ''}`}
      style={{ paddingLeft: 4 + depth * 14 }}
      onClick={() => ws.setPick(on ? null : path)}
      onMouseEnter={() => ws.setHovered(`@${path}`)}
      onMouseLeave={() => ws.setHovered(null)}
    >
      {depth > 0 && <span className="asm-branch" />}
      {leaf ? <span className="swatch-dot" style={{ background: look.color ?? leaf.color }} /> : <span className="swatch-dot swatch-dot--group" />}
      <span className="name">{inst.name}</span>
      {progress && <span className="qty">{progress.total ? `${Math.round((progress.loaded / progress.total) * 100)}%` : 'loading'}</span>}
      {inst.status === 'unresolved' ? (
        <span className="badge badge--warn">unresolved</span>
      ) : (
        warnings > 0 && (
          <span className="badge badge--warn" title={`${warnings} warning${warnings === 1 ? '' : 's'}`}>
            {warnings}
          </span>
        )
      )}
      <span className="qty">{kind === 'part' ? `v${inst.version ?? '?'}` : kind === 'component' ? 'comp' : 'sub'}</span>
      <button
        className="eye"
        aria-label={ws.isolated === path ? `Show everything` : `Show only ${inst.name}`}
        title={ws.isolated === path ? 'Show everything' : 'Isolate'}
        onClick={(e) => {
          e.stopPropagation()
          ws.setIsolated(ws.isolated === path ? null : path)
        }}
      >
        <Icon name="isolate" size={13} />
      </button>
      <button
        className="eye"
        aria-label={look.hidden ? `Show ${inst.name}` : `Hide ${inst.name}`}
        onClick={(e) => {
          e.stopPropagation()
          ws.setInstanceLook(`${doc.id}/${path}`, { hidden: !look.hidden })
        }}
      >
        <Icon name={look.hidden ? 'eyeOff' : 'eye'} size={13} />
      </button>
    </div>
  )
}

const r = (n: number) => +n.toFixed(2)
const vec = (v: number[]) => `[${v.map(r).join(', ')}]`

/** What the picked instance is, how it's placed and how well, and its datums. */
function InstanceDetail({ ws, doc, inst, path }: { ws: Ws; doc: AssemblyDoc; inst: AssemblyInstance; path: string }) {
  const ref = inst.ref
  const leaf = doc.leaves.find((l) => l.path === path)
  const look = lookOf(ws.looks, doc.id, path)
  const part = 'part' in ref ? ws.parts.find((p) => p.id === ref.part)?.live : undefined
  const component = 'component' in ref ? ws.components?.find((c) => c.id === ref.component) : undefined
  const datums = part?.datums ?? component?.datums
  const snaps = inst.snaps ?? []
  const asSnaps = inst.snap ? (Array.isArray(inst.snap) ? inst.snap : [inst.snap]) : []
  const isGround = (owner(ws, doc, path)?.ground ?? doc.ground) === inst.id
  const m = leaf?.matrix ?? inst.matrix
  return (
    <div className="inst-detail" onClick={(e) => e.stopPropagation()}>
      <dl className="props">
        <div>
          <dt>What</dt>
          <dd>
            {'part' in ref ? (
              <>
                part{' '}
                <button className="link" onClick={() => ws.openPart(ref.part)}>
                  {part?.name ?? ref.part}
                </button>{' '}
                v{inst.version ?? ref.version ?? '?'}
                {ref.version ? ' (pinned)' : part && inst.version !== part.version ? ` · v${part.version} is newer` : ''}
              </>
            ) : 'component' in ref ? (
              <>
                component{' '}
                <a className="link" href={`#/components/${ref.component}`}>
                  {component?.name ?? ref.component}
                </a>
                {component?.vendor ? ` · ${component.vendor}` : ''}
              </>
            ) : (
              <>
                sub-assembly{' '}
                <button className="link" onClick={() => ws.openLiveAssembly(ref.assembly)}>
                  {ws.assemblies.find((a) => a.id === ref.assembly)?.name ?? ref.assembly}
                </button>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Placed</dt>
          <dd>{isGround ? 'ground (fixed)' : asSnaps.length ? `by ${asSnaps.length === 1 ? 'a snap' : `${asSnaps.length} snaps`}` : 'by position'}</dd>
        </div>
        {!asSnaps.length && (inst.pos || inst.rot) && (
          <div>
            <dt>pos · rot</dt>
            <dd>
              {vec(inst.pos ?? [0, 0, 0])} · {vec(inst.rot ?? [0, 0, 0])}°
            </dd>
          </div>
        )}
        {m && (
          <div>
            <dt>at</dt>
            <dd>{vec([m[3], m[7], m[11]])} mm</dd>
          </div>
        )}
      </dl>
      {asSnaps.map((s, i) => (
        <SnapLine key={i} own={s.own} to={s.to} offset={s.offset} flip={s.flip} spin={s.spin} result={snaps[i]} />
      ))}
      {inst.status === 'unresolved' && (
        <div className="build-error" role="status">
          <strong>Unresolved</strong>
          <span>{inst.problem ?? "A snap couldn't be met."} It keeps its last placement.</span>
        </div>
      )}
      {datums && Object.keys(datums).length > 0 && (
        <div className="inst-datums">
          <span className="eyebrow">Datums · drawn</span>
          <div className="caps">
            {Object.entries(datums).map(([name, d]) => (
              <span key={name} className="cap" title={d.kind}>
                {name} <span className="faint">{d.kind}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {leaf && (
        <div className="swatches">
          {SWATCHES.map((c) => (
            <button key={c} className={`swatch${look.color?.toLowerCase() === c ? ' is-on' : ''}`} style={{ background: c }} onClick={() => ws.setInstanceLook(`${doc.id}/${path}`, { color: c })} aria-label={`Color ${c}`} />
          ))}
          <label className="swatch swatch--custom" title="Custom color">
            <input type="color" value={look.color ?? leaf.color} onChange={(e) => ws.setInstanceLook(`${doc.id}/${path}`, { color: e.target.value })} />
          </label>
          {look.color && (
            <button className="link swatch-reset" onClick={() => ws.setInstanceLook(`${doc.id}/${path}`, { color: undefined })}>
              reset
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function owner(ws: Ws, doc: AssemblyDoc, path: string) {
  return instanceAt(doc, path, ws.assemblies)?.owner
}

function SnapLine({ own, to, offset, flip, spin, result }: { own: string; to: string; offset?: number; flip?: boolean; spin?: number; result?: SnapResult }) {
  const extra = [offset ? `offset ${offset} mm` : '', flip ? 'flipped' : '', spin ? `spin ${spin}°` : ''].filter(Boolean).join(' · ')
  const off = result && (result.residual_mm > 0.05 || result.residual_deg > 0.1)
  return (
    <div className="snap-line">
      <span className="snap-what">
        {own} → {to}
        {extra && <span className="faint"> · {extra}</span>}
      </span>
      {result ? (
        <span className={`snap-res${off ? ' is-bad' : ''}`} title={result.points_mm ? `per point: ${result.points_mm.map((p) => fmt(p, 'mm')).join(', ')}` : undefined}>
          {fmt(result.residual_mm, 'mm')} · {fmt(result.residual_deg, '°').replace(' °', '°')}
          {result.rms_mm !== undefined && ` · rms ${fmt(result.rms_mm, 'mm')}`}
        </span>
      ) : (
        <span className="snap-res is-bad">not met</span>
      )}
      {result?.note && <span className="faint snap-note">{result.note}</span>}
    </div>
  )
}

function nameOf(ws: Ws, doc: AssemblyDoc, path: string) {
  return doc.leaves.find((l) => l.path === path)?.name ?? instanceAt(doc, path, ws.assemblies)?.inst.name ?? path
}

/** The last check's findings, warnings first; picking one frames it in the viewer. */
function Check({ doc }: { doc: AssemblyDoc }) {
  const ws = useWorkspace()
  const report = doc.report
  const list = sortedFindings(doc)
  const counts = report ? Object.entries(report.counts).filter(([, n]) => n) : []
  const note = report ? `${report.warnings ? `${report.warnings} warning${report.warnings === 1 ? '' : 's'}` : 'clear'} · ${ago(report.at)}` : 'not checked'
  return (
    <Fold name="Check" note={note} part={doc.id} changes={String(report?.at)}>
      {!report ? (
        <p className="faint check-none">Not checked yet. Every save checks it.</p>
      ) : (
        <>
          <div className="check-sum">
            {counts.map(([k, n]) => `${n} ${plural(k as Finding['kind'], n)}`).join(' · ')}
            {counts.length ? ' · ' : ''}
            {report.pairsChecked} pairs in {(report.ms / 1000).toFixed(1)} s{report.clearance !== 0.2 ? ` · clearance ${report.clearance} mm` : ''}
          </div>
          {report.partial && (
            <div className="check-partial" role="status">
              Partial: the time limit cut it short; {report.pairsSkipped} pair{report.pairsSkipped === 1 ? '' : 's'} not looked at.
            </div>
          )}
          {list.length > 0 && (
            <ul className="clashes findings">
              {list.map(({ f, i }) => (
                <li key={i}>
                  <button
                    className={`${ws.finding === i ? 'is-on' : ''}${f.severity === 'info' ? ' is-info' : ''}`}
                    title={ws.finding === i ? undefined : f.message}
                    onClick={() => {
                      ws.setFinding(ws.finding === i ? null : i)
                      ws.setIsolated(null)
                    }}
                  >
                    <span className="finding-top">
                      <span className="finding-kind">{FINDING_LABEL[f.kind]}</span>
                      <span className="finding-who">{f.instances.map((p) => nameOf(ws, doc, p)).join(' × ')}</span>
                      {f.value !== undefined && <span className="vol">{fmt(f.value, f.unit)}</span>}
                    </span>
                    {ws.finding === i && <span className="finding-msg">{f.message}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Fold>
  )
}

function plural(kind: Finding['kind'], n: number) {
  const label = FINDING_LABEL[kind]
  if (n === 1 || kind === 'floating' || kind === 'ground' || kind === 'unresolved') return label
  return kind === 'clash' ? 'clashes' : `${label}s`
}
