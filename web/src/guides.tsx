// Guides and the bill of materials: their folds in the assembly sheet, and the player's caption
// card and transport bar over the viewer.

import { useEffect, useRef, useState } from 'react'
import type { AssemblyDoc, Bom, BomLine, GuideDoc, GuideFinding } from '../shared/protocol'
import { stepDuration } from '../shared/guide'
import { ago, fmt, instanceAt, within } from './asm'
import { TierBadge } from './paper'
import { stepOffsets } from './player'
import { Prose } from './prose'
import { Fold, Icon } from './ui'
import { useWorkspace } from './workspace'

type Ws = ReturnType<typeof useWorkspace>

const KIND: Record<GuideDoc['kind'], string> = { build: 'build', exploded: 'exploded', explain: 'explain' }

const GUIDE_FINDING: Record<GuideFinding['kind'], string> = {
  path_clash: 'path clash',
  never_added: 'never added',
  missing: 'missing',
  added_twice: 'added twice',
  not_present: 'not shown',
  ends_apart: 'ends apart',
  hardware: 'hardware',
}

function pathName(ws: Ws, doc: AssemblyDoc, path: string) {
  return doc.leaves.find((l) => l.path === path)?.name ?? instanceAt(doc, path, ws.assemblies)?.inst.name ?? doc.leaves.find((l) => within(l.path, path))?.name ?? path
}

const steps = (n: number) => `${n} step${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------- the sheet

/** The assembly's guides; picking one plays it in the viewer, and shows its check. */
export function GuidesFold({ doc }: { doc: AssemblyDoc }) {
  const ws = useWorkspace()
  const list = ws.guides.filter((g) => g.assembly === doc.id)
  if (!list.length) return null
  const open = ws.player.guide
  return (
    <Fold name="Guides" count={list.length} note={open ? `${ws.player.playing ? 'playing' : 'open'} · ${open.name}` : undefined} part={doc.id} changes={list.map((g) => `${g.id}:${g.version}`).join('|')}>
      <ul className="guide-list">
        {list.map((g) => {
          const on = open?.id === g.id
          const warnings = g.report?.warnings ?? 0
          return (
            <li key={g.id}>
              <button className={`guide-row${on ? ' is-on' : ''}`} onClick={() => (on ? ws.player.close() : ws.player.open(g.id))} title={on ? 'Close the guide' : `Play ${g.name}`}>
                <span className="guide-play">
                  <Icon name={on ? 'stop' : 'play'} size={11} />
                </span>
                <span className="name">{g.name}</span>
                {g.assemblyVersion < doc.version && (
                  <span className="badge badge--stale" title={`Written for v${g.assemblyVersion}; the assembly is v${doc.version} now`}>
                    out of date
                  </span>
                )}
                {warnings > 0 && (
                  <span className="badge badge--warn" title={`${warnings} warning${warnings === 1 ? '' : 's'} from its check`}>
                    {warnings}
                  </span>
                )}
                <span className="qty">
                  {KIND[g.kind]} · {g.steps.length}
                </span>
              </button>
              {on && <GuideDetail ws={ws} doc={doc} guide={g} />}
            </li>
          )
        })}
      </ul>
    </Fold>
  )
}

/** The open guide's summary and its check; a finding jumps to its moment. */
function GuideDetail({ ws, doc, guide }: { ws: Ws; doc: AssemblyDoc; guide: GuideDoc }) {
  const report = guide.report
  const list = (report?.findings ?? []).map((f, i) => ({ f, i })).sort((a, b) => (a.f.severity === b.f.severity ? 0 : a.f.severity === 'warning' ? -1 : 1))
  return (
    <div className="guide-detail">
      {guide.summary && <p className="guide-summary">{guide.summary}</p>}
      <div className="check-sum">
        {steps(guide.steps.length)} · {fmtSeconds(stepOffsets(guide).at(-1) ?? 0)}
        {report ? ` · ${report.warnings ? `${report.warnings} warning${report.warnings === 1 ? '' : 's'}` : 'clear'} · checked ${ago(report.at)}` : ' · not checked'}
      </div>
      {report?.partial && <div className="check-partial">Partial: the time limit cut its check short.</div>}
      {list.length > 0 && (
        <ul className="clashes findings">
          {list.map(({ f, i }) => (
            <li key={i}>
              <button
                className={`${ws.player.mark === i ? 'is-on' : ''}${f.severity === 'info' ? ' is-info' : ''}`}
                title={ws.player.mark === i ? undefined : f.message}
                onClick={() => ws.player.setMark(ws.player.mark === i ? null : i)}
              >
                <span className="finding-top">
                  <span className="finding-kind">{GUIDE_FINDING[f.kind]}</span>
                  <span className="finding-who">{[f.step !== undefined ? `step ${f.step + 1}` : '', f.instances.map((p) => pathName(ws, doc, p)).join(' × ')].filter(Boolean).join(' · ')}</span>
                  {f.value !== undefined && <span className="vol">{fmt(f.value, f.unit)}</span>}
                </span>
                {ws.player.mark === i && <span className="finding-msg">{f.message}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function fmtSeconds(s: number) {
  return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

type BomState = { status: 'loading' } | { status: 'ok'; bom: Bom } | { status: 'none' } | { status: 'error' }

/** The assembly's bill of materials, fetched again when it or the parts it uses change. */
function useBom(ws: Ws, doc: AssemblyDoc): BomState {
  const used = new Set(doc.leaves.flatMap((l) => ('part' in l.ref ? [l.ref.part] : [])))
  const partsKey = ws.parts
    .filter((p) => used.has(p.id))
    .map((p) => `${p.id}:${p.live?.version}:${p.material}:${JSON.stringify(p.live?.hardware ?? [])}`)
    .join('|')
  const key = `${ws.projectId}/${doc.id}@${doc.version}|${JSON.stringify(doc.hardware ?? [])}|${partsKey}`
  const [state, setState] = useState<{ key: string; value: BomState }>({ key: '', value: { status: 'loading' } })
  useEffect(() => {
    let gone = false
    fetch(`/api/projects/${ws.projectId}/assemblies/${doc.id}/bom`)
      .then(async (r) => {
        const value: BomState = r.ok ? { status: 'ok', bom: (await r.json()) as Bom } : { status: r.status === 404 ? 'none' : 'error' }
        if (!gone) setState({ key, value })
      })
      .catch(() => !gone && setState({ key, value: { status: 'error' } }))
    return () => {
      gone = true
    }
    // The key says when the list could have changed.
  }, [key, ws.projectId, doc.id])
  // Keep showing the last list while a newer one loads, so the fold doesn't jump.
  return state.key === key || state.value.status === 'ok' ? state.value : { status: 'loading' }
}

const GROUPS: { kind: BomLine['kind']; label: string }[] = [
  { kind: 'part', label: 'Parts' },
  { kind: 'component', label: 'Components' },
  { kind: 'hardware', label: 'Hardware' },
]

export function BomFold({ doc }: { doc: AssemblyDoc }) {
  const ws = useWorkspace()
  const state = useBom(ws, doc)
  const bom = state.status === 'ok' ? state.bom : null
  const note = bom ? (bom.totals.toBuy ? `${bom.totals.toBuy} to buy` : 'all on hand') : state.status === 'loading' ? 'loading' : undefined
  return (
    <Fold name="Bill of materials" note={note} part={doc.id}>
      {!bom ? (
        <p className="faint check-none">{state.status === 'loading' ? 'Counting…' : state.status === 'none' ? 'Not available yet.' : "Couldn't load it just now."}</p>
      ) : (
        <>
          <div className="check-sum">
            {[
              `${bom.totals.parts} part${bom.totals.parts === 1 ? '' : 's'}`,
              bom.totals.components ? `${bom.totals.components} component${bom.totals.components === 1 ? '' : 's'}` : '',
              bom.totals.hardware ? `${bom.totals.hardware} hardware` : '',
              bom.totals.massG ? `${bom.totals.massG >= 1000 ? `${(bom.totals.massG / 1000).toFixed(2)} kg` : `${bom.totals.massG.toFixed(1)} g`}` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
          {GROUPS.map(({ kind, label }) => {
            const lines = bom.lines.filter((l) => l.kind === kind)
            if (!lines.length) return null
            return (
              <div key={kind} className="bom-group">
                <span className="eyebrow">{label}</span>
                {lines.map((l, i) => (
                  <BomRow key={`${l.ref ?? l.name}-${i}`} line={l} />
                ))}
              </div>
            )
          })}
          {bom.notes.length > 0 && (
            <ul className="bom-notes">
              {bom.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <p className="faint bom-stock">Stock isn't taken off: projects are plans.</p>
        </>
      )}
    </Fold>
  )
}

function BomRow({ line: l }: { line: BomLine }) {
  const detail =
    l.kind === 'part'
      ? [l.material, l.massG !== undefined ? `${l.massG.toFixed(1)} g each` : ''].filter(Boolean).join(' · ')
      : l.kind === 'component'
        ? [l.vendor, l.partNumber].filter(Boolean).join(' · ')
        : [l.kindLabel, l.price].filter(Boolean).join(' · ')
  return (
    <div className={`bom-row${l.kind === 'hardware' ? ' bom-row--hw' : ''}`} title={l.from.length ? `From ${l.from.join('; ')}` : undefined}>
      <span className="hw-qty">{l.qty}×</span>
      {l.kind === 'hardware' && <span className="bom-img">{l.image ? <img className="hw-img" src={l.image} alt="" loading="lazy" /> : null}</span>}
      <span className="hw-spec">
        {l.link ? (
          <a className="link" href={l.link} target="_blank" rel="noreferrer">
            {l.name}
          </a>
        ) : (
          l.name
        )}
        {detail && <span>{detail}</span>}
      </span>
      {l.kind === 'hardware' && (
        <span className="bom-stock-cell">
          {l.tier && <TierBadge tier={l.tier} />}
          {l.short ? <span className="bom-short">short {l.short}</span> : l.have !== undefined ? <span className="faint">have {l.have}</span> : null}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- over the viewer

/** What the step says: its number, title, text, warning, hardware and tools. */
export function GuideCaption({ guide }: { guide: GuideDoc }) {
  const ws = useWorkspace()
  const p = ws.player
  const step = guide.steps[p.step]
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    body.current?.scrollTo({ top: 0 })
  }, [p.step])
  if (!step) return null
  return (
    <section className="guide-card" aria-live="polite" aria-label="Guide step">
      <div className="guide-card-head">
        <span className="eyebrow">
          Step {p.step + 1} of {guide.steps.length}
          <span className="faint"> · {guide.name}</span>
        </span>
        <button className="icon-close" onClick={p.close} aria-label="Close the guide" title="Close  Esc">
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="guide-card-body" ref={body} key={p.step}>
        <h3>{step.title}</h3>
        {step.text && (
          <div className="msg-text--prose guide-text">
            <Prose text={step.text} />
          </div>
        )}
        {step.warning && (
          <div className="guide-warning" role="note">
            <strong>Careful</strong>
            <span>{step.warning}</span>
          </div>
        )}
        {step.hardware.length > 0 && (
          <div className="guide-hw">
            {step.hardware.map((h, i) => (
              <div key={i} className="guide-hw-row" title={h.note}>
                <span className="guide-hw-img">{h.image ? <img className="hw-img" src={h.image} alt="" /> : <span className="hw-type hw-type--small">{h.qty}×</span>}</span>
                <span className="hw-spec">
                  <span className="guide-hw-name">
                    {h.qty} × {h.name}
                  </span>
                  {h.note && <span>{h.note}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        {step.tools.length > 0 && (
          <div className="caps guide-tools">
            {step.tools.map((t) => (
              <span key={t} className="cap">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

/** Step chips, prev / play / next, a scrubber, speed and auto-advance. Exploded guides scrub the whole explode. */
export function GuideTransport({ guide }: { guide: GuideDoc }) {
  const ws = useWorkspace()
  const p = ws.player
  const whole = guide.kind === 'exploded'
  const offsets = stepOffsets(guide)
  const total = offsets[offsets.length - 1]
  const dur = stepDuration(guide.steps[p.step] ?? guide.steps[0])
  const range = useRef<HTMLInputElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  const chips = useRef<HTMLDivElement>(null)

  // The scrubber follows the clock without re-rendering anything.
  useEffect(() => {
    let id = 0
    const tick = () => {
      const c = p.clock.current
      const d = stepDuration(guide.steps[c.step] ?? guide.steps[0])
      const t = Math.min(c.t, d)
      const v = whole ? offsets[c.step] + t : t
      const max = whole ? total : d
      if (range.current && !c.scrubbing) range.current.value = String(v)
      range.current?.style.setProperty('--at', `${(v / Math.max(1e-6, max)) * 100}%`)
      if (time.current) time.current.textContent = `${v.toFixed(1)} / ${max.toFixed(1)} s`
      id = requestAnimationFrame(tick)
    }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [p.clock, guide, whole, offsets, total])

  // Keep the current chip in view on narrow screens.
  useEffect(() => {
    const el = chips.current?.children[p.step] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [p.step])

  const seek = (v: number) => {
    const c = p.clock.current
    if (!whole) {
      c.t = v
      return
    }
    let i = 0
    while (i < guide.steps.length - 1 && v >= offsets[i + 1]) i++
    if (i !== c.step) p.goStep(i, { t: v - offsets[i], camera: false })
    else c.t = v - offsets[i]
  }
  const endScrub = () => {
    p.clock.current.scrubbing = false
  }

  return (
    <div className="guide-transport" role="toolbar" aria-label="Guide player">
      <div className="guide-chips" ref={chips}>
        {guide.steps.map((s, i) => (
          <button
            key={i}
            className={`guide-chip${i === p.step ? ' is-on' : i < p.step ? ' is-done' : ''}${s.warning ? ' has-warning' : ''}`}
            onClick={() => {
              p.goStep(i)
              p.setPlaying(true)
            }}
            title={`${i + 1}. ${s.title}`}
            aria-current={i === p.step ? 'step' : undefined}
          >
            {i + 1}
          </button>
        ))}
      </div>
      <div className="guide-controls">
        <button
          className="guide-btn"
          aria-label="Previous step"
          title="Previous step  ←"
          disabled={p.step === 0}
          onClick={() => {
            p.goStep(p.step - 1)
            p.setPlaying(true)
          }}
        >
          <Icon name="prev" size={14} />
        </button>
        <button className="guide-btn guide-btn--play" aria-label={p.playing ? 'Pause' : 'Play'} title={`${p.playing ? 'Pause' : 'Play'}  Space`} onClick={p.togglePlay}>
          <Icon name={p.playing ? 'pause' : 'play'} size={14} />
        </button>
        <button
          className="guide-btn"
          aria-label="Next step"
          title="Next step  →"
          disabled={p.step >= guide.steps.length - 1}
          onClick={() => {
            p.goStep(p.step + 1)
            p.setPlaying(true)
          }}
        >
          <Icon name="next" size={14} />
        </button>
        <div className="guide-scrub">
          <input
            ref={range}
            type="range"
            min={0}
            max={whole ? total : dur}
            step={0.01}
            defaultValue={0}
            aria-label={whole ? 'Explode' : 'Time in step'}
            onPointerDown={() => {
              p.clock.current.scrubbing = true
              p.setPlaying(false)
            }}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
            onBlur={endScrub}
            onKeyDown={(e) => {
              // Arrows nudge the scrubber here rather than changing steps.
              if (e.key.startsWith('Arrow')) {
                e.stopPropagation()
                p.setPlaying(false)
              }
            }}
            onChange={(e) => seek(Number(e.currentTarget.value))}
          />
          {whole && (
            <span className="guide-ticks" aria-hidden>
              {offsets.slice(1, -1).map((o, i) => (
                <i key={i} style={{ left: `${(o / total) * 100}%` }} />
              ))}
            </span>
          )}
        </div>
        <span className="guide-time" ref={time} />
        <div className="seg guide-speed" role="radiogroup" aria-label="Speed">
          {[0.5, 1, 2].map((s) => (
            <button key={s} role="radio" aria-checked={p.speed === s} onClick={() => p.setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <button
          className={`guide-auto${p.auto ? ' is-on' : ''}`}
          aria-pressed={p.auto}
          onClick={() => p.setAuto(!p.auto)}
          title={p.auto ? 'Plays straight through; click to stop after each step' : 'Stops after each step; click to play straight through'}
        >
          {p.auto ? 'auto' : 'step'}
        </button>
      </div>
    </div>
  )
}
