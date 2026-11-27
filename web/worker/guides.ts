// Assembly guides: animated build guides, exploded views and explanations the AI writes and the
// person plays in the viewer. The AI writes poses with datum references ("lid.top", a hinge axis);
// every save resolves them into the assembly's frame, validates the guide, samples every motion
// with web/shared/guide.ts (the viewer's own math) for the geometry service to check for clashes
// along the way (geometry/guide.py), draws a sheet of the steps and saves a version. A guide keeps
// following its assembly's live leaves; a newer assembly save only means its check is out of date.

import type { AssemblyDoc, AssemblyLeaf, Datum, GuideDoc, GuideFinding, GuideHardware, GuideLabel, GuideMotion, GuidePose, GuideReport, GuideStep, PartDoc, ServerEvent, ShopItem, Vec3, ViewName } from '../shared/protocol'
import { ASSEMBLED, applyDir, applyPoint, guideState, isAssembled, mul, normalize, sampleTimes, stepDuration, stepFrame, stepStarts, VIEWS, within } from '../shared/guide'
import type { LeafState, M4 } from '../shared/guide'
import type { Assemblies, AssemblyOutcome, LeafInfo } from './assemblies'
import { hardwareKeys, joiningHardware } from './bom'
import type { Env } from './env'
import type { Block } from './llm'
import * as G from './tools-guide'
import type { GuideSource, PoseInput, StepInput } from './tools-guide'

const TIME_LIMIT = 30
/** Path checks sample every motion at most this far apart (mm, any corner of a moving instance's box)… */
const SPACING = 2
/** …with at most this many samples per step and per guide. */
const MAX_STEP_SAMPLES = 400
const MAX_SAMPLES = 2400
const CELL = 360

export type GuideHost = {
  sql: SqlStorage
  env: Env
  projectId(): string
  asm: Assemblies
  part(id: string): PartDoc | null
  items(): Promise<ShopItem[]>
  broadcast(event: ServerEvent): void
}

/** What resolving a guide needs to know about its assembly. */
type Ctx = {
  doc: AssemblyDoc
  leaves: AssemblyLeaf[]
  info: Map<string, LeafInfo>
  /** Every instance path (leaves and sub-assemblies) → its assembled matrix in the assembly's frame. */
  paths: Map<string, M4>
  items: ShopItem[]
}

type GeoGuide =
  | { ok: true; ms: number; findings: GuideFinding[]; partial: boolean; samples: number; check_ms: number; sheet?: string; thumb?: string; problems: string[] }
  | { ok: false; ms: number; error: { type: string; message: string } }

type Cell = {
  title: string
  warn: boolean
  dir: Vec3
  up: Vec3
  zoom: number
  frame: string[]
  items: { path: string; matrix: M4; alpha: number; ghost: boolean }[]
  labels: { text: string; point: Vec3 }[]
  trails: Vec3[][]
}

export class Guides {
  constructor(private h: GuideHost) {
    h.sql.exec(`
      CREATE TABLE IF NOT EXISTS guides (id TEXT PRIMARY KEY, assembly TEXT NOT NULL, doc TEXT NOT NULL, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS guide_versions (guide TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY (guide, version));`)
  }

  list(assembly?: string): GuideDoc[] {
    const rows = assembly ? this.h.sql.exec<{ doc: string }>('SELECT doc FROM guides WHERE assembly = ?', assembly) : this.h.sql.exec<{ doc: string }>('SELECT doc FROM guides')
    return rows.toArray().map((r) => JSON.parse(r.doc))
  }

  get(id: string): GuideDoc | null {
    const row = this.h.sql.exec<{ doc: string }>('SELECT doc FROM guides WHERE id = ?', id).toArray()[0]
    return row ? JSON.parse(row.doc) : null
  }

  private source(id: string): GuideSource | null {
    const row = this.h.sql.exec<{ source: string }>('SELECT source FROM guides WHERE id = ?', id).toArray()[0]
    return row ? JSON.parse(row.source) : null
  }

  /** The assembly was deleted: its guides go with it. */
  removeFor(assembly: string) {
    for (const g of this.list(assembly)) this.remove(g.id)
  }

  private remove(id: string) {
    this.h.sql.exec('DELETE FROM guides WHERE id = ?', id)
    this.h.sql.exec('DELETE FROM guide_versions WHERE guide = ?', id)
    this.h.broadcast({ type: 'guide_removed', id })
  }

  // ---------------------------------------------------------------- tools

  async run(name: string, input: unknown, signal: AbortSignal, withImage: boolean): Promise<AssemblyOutcome> {
    const fail = (text: string, detail: string): AssemblyOutcome => ({ content: [{ type: 'text', text }], isError: true, detail })
    const parse = <S extends { safeParse: (v: unknown) => { success: true; data: unknown } | { success: false; error: unknown } }>(schema: S) => {
      const r = schema.safeParse(input)
      return r.success ? (r.data as never) : null
    }
    const bad = (schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }) => fail(invalid(input, schema.safeParse(input).error as never), 'invalid input')

    if (name === 'list_guides') {
      const f = parse(G.ListGuides) as { assembly?: string } | null
      if (!f) return bad(G.ListGuides)
      const all = this.list(f.assembly)
      const text = all.length ? all.map((g) => summaryLine(g, this.h.asm.get(g.assembly))).join('\n') : `No guides${f.assembly ? ` for ${f.assembly}` : ' in this project'} yet. Write one with write_guide.`
      return { content: [{ type: 'text', text }], detail: `${all.length} guides` }
    }
    if (name === 'read_guide') {
      const f = parse(G.ReadGuide) as { guide: string; version?: number } | null
      if (!f) return bad(G.ReadGuide)
      const g = this.get(f.guide)
      if (!g) return fail(this.missing(f.guide), `${f.guide} · not found`)
      if (f.version) {
        const row = this.h.sql.exec<{ spec: string; note: string }>('SELECT spec, note FROM guide_versions WHERE guide = ? AND version = ?', g.id, f.version).toArray()[0]
        if (!row) return fail(`${g.id} has no v${f.version}. ${versionsLine(g)}`, 'no such version')
        return { content: [{ type: 'text', text: `${g.id} v${f.version} (${row.note || '-'}) as written:\n${row.spec}\n${versionsLine(g)}` }], detail: `${g.id} v${f.version}` }
      }
      return { content: [{ type: 'text', text: describe(g, this.source(g.id), this.h.asm.get(g.assembly), true) }], detail: `${g.id} v${g.version}` }
    }
    if (name === 'delete_guide') {
      const f = parse(G.DeleteGuide) as { guide: string } | null
      if (!f) return bad(G.DeleteGuide)
      const g = this.get(f.guide)
      if (!g) return fail(this.missing(f.guide), `${f.guide} · not found`)
      this.remove(g.id)
      return { content: [{ type: 'text', text: `Deleted guide ${g.id} "${g.name}" and its ${g.version} version${g.version === 1 ? '' : 's'}.` }], detail: `${g.id} deleted`, line: `Deleted guide ${g.name}`, fact: `deleted guide ${g.id}` }
    }
    if (name === 'write_guide') {
      const f = parse(G.WriteGuide) as { assembly: string; id: string; name: string; kind: GuideSource['kind']; summary?: string; upcoming?: GuideSource['upcoming']; steps: StepInput[]; note?: string; time_limit?: number } | null
      if (!f) return bad(G.WriteGuide)
      const prev = this.get(f.id)
      const src: GuideSource = { name: f.name, kind: f.kind, ...(f.summary && { summary: f.summary }), upcoming: f.upcoming ?? 'ghost', steps: f.steps }
      return this.save(f.id, f.assembly, src, f.note ?? (prev ? 'Rewrote the guide' : 'First draft'), f.time_limit, signal, withImage)
    }
    if (name === 'edit_guide') {
      const f = parse(G.EditGuide) as { guide: string; name?: string; kind?: GuideSource['kind']; summary?: string | null; upcoming?: GuideSource['upcoming']; ops: { op: string; step: number; to?: number; value?: Record<string, unknown> }[]; note?: string; time_limit?: number } | null
      if (!f) return bad(G.EditGuide)
      const g = this.get(f.guide)
      const src = this.source(f.guide)
      if (!g || !src) return fail(this.missing(f.guide), `${f.guide} · not found`)
      const steps = [...src.steps]
      const done: string[] = []
      for (const [k, o] of f.ops.entries()) {
        const at = o.step - 1
        const where = `op ${k + 1} (${o.op} step ${o.step})`
        const inRange = o.op === 'insert' ? at <= steps.length : at < steps.length
        if (!inRange) return fail(`${where}: the guide has ${steps.length} steps at that point. Nothing was saved.`, 'no such step')
        if (o.op === 'delete') {
          steps.splice(at, 1)
          done.push(`deleted ${o.step}`)
          continue
        }
        if (o.op === 'move') {
          if (!o.to || o.to > steps.length) return fail(`${where}: move needs to (1 to ${steps.length}). Nothing was saved.`, 'bad move')
          const [s] = steps.splice(at, 1)
          steps.splice(o.to - 1, 0, s)
          done.push(`moved ${o.step}→${o.to}`)
          continue
        }
        if (!o.value) return fail(`${where}: needs value. Nothing was saved.`, 'no value')
        let next: unknown = o.value
        if (o.op === 'patch') {
          const merged: Record<string, unknown> = { ...steps[at] }
          for (const [key, v] of Object.entries(o.value)) {
            if (v === null) delete merged[key]
            else merged[key] = v
          }
          next = merged
        }
        const ok = G.StepIn.safeParse(next)
        if (!ok.success) return fail(`${where}: ${invalid(next, ok.error)} Nothing was saved.`, 'invalid step')
        if (o.op === 'insert') steps.splice(at, 0, ok.data)
        else steps[at] = ok.data
        done.push(o.op === 'patch' ? `changed ${o.step} (${Object.keys(o.value).join(', ')})` : `${o.op === 'insert' ? 'inserted' : 'replaced'} ${o.step}`)
      }
      if (!steps.length) return fail('That would leave the guide with no steps; delete_guide removes it. Nothing was saved.', 'no steps')
      const next: GuideSource = { ...src, steps, ...(f.name && { name: f.name }), ...(f.kind && { kind: f.kind }), ...(f.upcoming && { upcoming: f.upcoming }) }
      if (f.summary === null) delete next.summary
      else if (f.summary) next.summary = f.summary
      const fields = (['name', 'kind', 'summary', 'upcoming'] as const).filter((x) => f[x] !== undefined)
      const auto = [...(done.length ? [`Steps: ${done.join(', ')}`] : []), ...(fields.length ? [`set ${fields.join(', ')}`] : [])].join('; ')
      const note = f.note ?? (auto.length > 120 ? `${auto.slice(0, 119)}…` : auto || 'Re-checked')
      return this.save(g.id, g.assembly, next, note, f.time_limit, signal, withImage)
    }
    if (name === 'render_guide') {
      const f = parse(G.RenderGuide) as { guide: string; steps?: number[]; moment?: 'end' | 'start' | number; views?: ViewName[]; size?: number; caption?: string } | null
      if (!f) return bad(G.RenderGuide)
      const g = this.get(f.guide)
      if (!g) return fail(this.missing(f.guide), `${f.guide} · not found`)
      const doc = this.h.asm.get(g.assembly)
      if (!doc) return fail(`Guide ${g.id} belongs to assembly ${g.assembly}, which no longer exists.`, 'no assembly')
      const wrong = (f.steps ?? []).filter((n) => n > g.steps.length)
      if (wrong.length) return fail(`${g.id} has ${g.steps.length} steps; no step ${wrong.join(', ')}.`, 'no such step')
      const indexes = f.steps?.length ? f.steps.map((n) => n - 1) : g.steps.map((_, i) => i)
      const ctx = await this.context(doc)
      const cells = sheetCells(g, ctx, indexes, f.moment ?? 'end', f.views)
      const out = await this.h.asm.leafRequest<GeoGuide>('/guide', doc, { sheet: { cells, size: f.size ?? CELL, thumb: false } }, TIME_LIMIT, signal)
      if (!out.ok) return fail(`The render failed: ${out.error.message}`, 'render failed')
      if (!out.sheet) return fail('Nothing to draw.', 'empty')
      const key = `projects/${this.h.projectId()}/renders/${crypto.randomUUID()}.png`
      await this.h.env.FILES.put(key, bytes(out.sheet), { httpMetadata: { contentType: 'image/png' } })
      const moment = f.moment === undefined || f.moment === 'end' ? 'at its end' : f.moment === 'start' ? 'at its start' : `${f.moment} s in`
      const stale = g.assemblyVersion < doc.version ? ` The assembly is v${doc.version} now (checked against v${g.assemblyVersion}); edit_guide with ops: [] re-checks it.` : ''
      return {
        content: [
          { type: 'text', text: `${g.id} v${g.version}: ${indexes.length} step${indexes.length === 1 ? '' : 's'} ${moment}${f.views?.length ? `, from ${f.views.join(', ')}` : ', from each step\'s camera'}.${stale}${out.problems.length ? `\nProblems: ${out.problems.join('; ')}` : ''}` },
          { type: 'image', mediaType: 'image/png', data: out.sheet },
        ],
        detail: `${g.id} v${g.version} · ${indexes.length} steps`,
        render: key,
      }
    }
    return fail(`Unknown tool ${name}.`, 'unknown tool')
  }

  // ---------------------------------------------------------------- saving

  private async save(id: string, assembly: string, src: GuideSource, note: string, timeLimit: number | undefined, signal: AbortSignal, withImage: boolean): Promise<AssemblyOutcome> {
    const fail = (text: string, detail: string): AssemblyOutcome => ({ content: [{ type: 'text', text }], isError: true, detail })
    const prev = this.get(id)
    const kept = prev ? `; ${id} stays at v${prev.version}` : ''
    const doc = this.h.asm.get(assembly)
    if (!doc) return fail(`No assembly "${assembly}". Assemblies: ${this.h.asm.list().map((a) => a.id).join(', ') || 'none'}. Nothing was saved${kept}.`, `${assembly} · not found`)
    if (!doc.leaves.length) return fail(`${assembly} has nothing placed in it. Nothing was saved${kept}.`, 'empty assembly')
    const started = Date.now()
    const ctx = await this.context(doc)
    const r = resolveGuide(src, ctx)
    if (r.errors.length) {
      const instances = [...ctx.paths.keys()].join(', ')
      return fail(`Nothing was saved${kept}: the guide names instances or datums ${doc.id} doesn't have (missing):\n- ${r.errors.slice(0, 15).join('\n- ')}${r.errors.length > 15 ? `\n- … ${r.errors.length - 15} more` : ''}\nInstances: ${instances}.`, `${r.errors.length} missing`)
    }
    const g = { kind: src.kind, upcoming: src.upcoming, steps: r.steps }
    const findings = [...r.notes, ...validate(g, ctx, (pid) => this.h.part(pid), (aid) => this.h.asm.get(aid))]
    const check = pathCheck(g, ctx)
    const limit = timeLimit ?? TIME_LIMIT
    let out: GeoGuide
    try {
      out = await this.h.asm.leafRequest<GeoGuide>('/guide', doc, { check: check.steps, sheet: { cells: sheetCells(g, ctx, g.steps.map((_, i) => i), 'end'), size: CELL, thumb: true } }, limit, signal)
    } catch (err) {
      if (signal.aborted) throw err
      return fail(`The geometry service didn't respond (${(err as Error).message}). Nothing was saved${kept}.`, 'geometry unreachable')
    }
    if (!out.ok) return fail(`The path check failed: ${out.error.message}. Nothing was saved${kept}.`, out.error.type)

    const all = [...findings, ...out.findings]
    const report: GuideReport = { at: Date.now(), ms: out.check_ms, warnings: all.filter((x) => x.severity === 'warning').length, findings: all, partial: out.partial }
    const version = (prev?.version ?? 0) + 1
    const base = `projects/${this.h.projectId()}/guides/${id}/v${version}`
    await Promise.all([
      out.sheet && this.h.env.FILES.put(`${base}.png`, bytes(out.sheet), { httpMetadata: { contentType: 'image/png' } }),
      out.thumb && this.h.env.FILES.put(`${base}.thumb.png`, bytes(out.thumb), { httpMetadata: { contentType: 'image/png' } }),
    ])
    this.h.sql.exec('INSERT OR REPLACE INTO guide_versions VALUES (?, ?, ?, ?, ?)', id, version, JSON.stringify(src), note, Date.now())
    const saved = this.store(
      {
        id,
        assembly,
        name: src.name,
        kind: src.kind,
        ...(src.summary && { summary: src.summary }),
        upcoming: src.upcoming,
        steps: r.steps,
        assemblyVersion: doc.version,
        report,
        ...(out.sheet ? { files: { sheet: `/api/files/${base}.png`, thumb: `/api/files/${base}.thumb.png` } } : prev?.files && { files: prev.files }),
        version,
        updatedAt: Date.now(),
      },
      src,
    )
    this.h.broadcast({ type: 'guide', guide: saved })
    const total = r.steps.reduce((t, s) => t + stepDuration(s), 0)
    const header = `Saved guide ${id} v${version} "${src.name}" (${note}) in ${((Date.now() - started) / 1000).toFixed(1)} s: ${src.kind}, ${r.steps.length} steps, ${total.toFixed(1)} s long, for ${doc.id} v${doc.version}. Path check: ${out.samples} samples (at most ${SPACING} mm apart${check.coarse ? `, coarser in steps ${check.coarse.join(', ')} to stay under ${MAX_SAMPLES}` : ''}) in ${(out.check_ms / 1000).toFixed(1)} s${out.partial ? `, PARTIAL: the ${limit} s time limit stopped it; edit_guide with ops: [] and a longer time_limit` : ''}.`
    const content: Block[] = [{ type: 'text', text: `${header}\n${describe(saved, null, doc, false)}${out.problems.length ? `\nProblems drawing or checking: ${out.problems.join('; ')}` : ''}\nThe sheet shows each step at its end from its camera; dark arrows are where things moved (from the ring to the arrowhead).` }]
    if (withImage && out.sheet) content.push({ type: 'image', mediaType: 'image/png', data: out.sheet })
    const warn = report.warnings ? ` · ${report.warnings} warning${report.warnings === 1 ? '' : 's'}` : ' · no warnings'
    return {
      content,
      detail: `${id} v${version} · ${r.steps.length} steps${warn}`,
      line: `Guide ${src.name} v${version}: ${note}${warn}`,
      fact: `saved guide ${id} v${version} for ${doc.id} (${note}): ${r.steps.length} steps${warn}${report.warnings ? `: ${[...new Set(all.filter((x) => x.severity === 'warning').map((x) => x.kind))].join(', ')}` : ''}`,
      ...(out.sheet && { render: `${base}.png` }),
    }
  }

  private store(doc: GuideDoc, src: GuideSource): GuideDoc {
    const versions = this.h.sql
      .exec<{ version: number; note: string; created_at: number }>('SELECT version, note, created_at FROM guide_versions WHERE guide = ? ORDER BY version DESC LIMIT 12', doc.id)
      .toArray()
      .map((v) => ({ version: v.version, note: v.note, at: v.created_at }))
    const out = { ...doc, versions }
    this.h.sql.exec('INSERT OR REPLACE INTO guides VALUES (?, ?, ?, ?)', doc.id, doc.assembly, JSON.stringify(out), JSON.stringify(src))
    return out
  }

  private async context(doc: AssemblyDoc): Promise<Ctx> {
    const paths = new Map<string, M4>()
    const walk = (a: AssemblyDoc, prefix: string, m: M4, seen: Set<string>) => {
      for (const i of a.instances) {
        if (!('assembly' in i.ref)) continue
        const sub = this.h.asm.get(i.ref.assembly)
        const mm = mul(m, i.matrix)
        paths.set(prefix + i.id, mm)
        if (sub && !seen.has(sub.id)) walk(sub, `${prefix}${i.id}/`, mm, new Set([...seen, sub.id]))
      }
    }
    walk(doc, '', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], new Set([doc.id]))
    for (const l of doc.leaves) paths.set(l.path, l.matrix)
    return { doc, leaves: doc.leaves, info: await this.h.asm.leafInfo(doc), paths, items: await this.h.items() }
  }

  private missing(id: string) {
    return `No guide "${id}". Guides: ${this.list().map((g) => g.id).join(', ') || 'none'}.`
  }
}

// ---------------------------------------------------------------- resolving

/** Resolve datum references and defaults into the saved form; `errors` are things the assembly doesn't have. */
function resolveGuide(src: GuideSource, ctx: Ctx): { steps: GuideStep[]; errors: string[]; notes: GuideFinding[] } {
  const errors: string[] = []
  const notes: GuideFinding[] = []
  const poses = new Map<string, GuidePose>()
  const shown = new Set<string>(src.kind !== 'build' ? ctx.leaves.map((l) => l.path) : [])
  const known = (p: string, where: string) => {
    if (ctx.paths.has(p)) return true
    errors.push(`${where}: no instance "${p}"`)
    return false
  }
  const steps = src.steps.map((s, i): GuideStep => {
    const where = `step ${i + 1}`
    for (const p of s.add ?? []) known(p, `${where} add`)
    for (const p of s.remove ?? []) known(p, `${where} remove`)
    for (const p of s.focus ?? []) known(p, `${where} focus`)
    for (const p of s.camera?.frame ?? []) known(p, `${where} camera.frame`)
    const motions: GuideMotion[] = (s.motions ?? []).map((m, k) => {
      const w = `${where} motion ${k + 1} (${m.instance})`
      const ok = known(m.instance, w)
      const pose = (p: PoseInput | undefined, fallback: GuidePose, what: string) => (p === undefined || !ok ? fallback : resolvePose(p, m.instance, ctx, errors, `${w} ${what}`))
      return {
        instance: m.instance,
        from: pose(m.from, poses.get(m.instance) ?? ASSEMBLED, 'from'),
        to: pose(m.to, ASSEMBLED, 'to'),
        via: (m.via ?? []).map((v, j) => pose(v, ASSEMBLED, `via ${j + 1}`)),
        delay: m.delay ?? 0,
        duration: m.duration ?? 1,
        ease: m.ease ?? 'in-out',
      }
    })
    if (s.explode) {
      const now = new Set(shown)
      for (const l of ctx.leaves) if ((s.add ?? []).some((p) => within(l.path, p))) now.add(l.path)
      motions.push(...explode(s.explode, ctx, now, poses, new Set(motions.map((m) => m.instance)), errors, where))
    }
    const labels: GuideLabel[] = (s.labels ?? []).map((l) => ({ text: l.text, at: l.at, point: labelPoint(l.at, ctx, errors, `${where} label "${l.text}"`) }))
    const hardware: GuideHardware[] = (s.hardware ?? []).map((h) => {
      const item = h.item_id ? ctx.items.find((x) => x.id === h.item_id) : undefined
      if (h.item_id && !item) notes.push({ kind: 'hardware', severity: 'warning', step: i, instances: [], message: `Step ${i + 1}: shop item ${h.item_id} isn't in the shop; search_shop for its id.` })
      if (!h.name && !item) errors.push(`${where} hardware: give a name or a shop item_id`)
      return { qty: h.qty, name: h.name ?? item?.name ?? h.item_id ?? '?', ...(item && { itemId: item.id }), ...(item?.image && { image: item.image }), ...(h.note && { note: h.note }) }
    })
    for (const l of ctx.leaves) {
      if ((s.add ?? []).some((p) => within(l.path, p))) shown.add(l.path)
      if ((s.remove ?? []).some((p) => within(l.path, p))) shown.delete(l.path)
    }
    for (const m of motions) poses.set(m.instance, m.to)
    return {
      title: s.title,
      ...(s.text && { text: s.text }),
      add: s.add ?? [],
      remove: s.remove ?? [],
      motions,
      ...(s.camera && { camera: s.camera }),
      ...(s.focus && { focus: s.focus }),
      labels,
      hardware,
      tools: s.tools ?? [],
      ...(s.warning && { warning: s.warning }),
    }
  })
  return { steps, errors, notes }
}

type DatumAt = { kind: Datum['kind']; origin: Vec3; dir?: Vec3 }

/** A datum address resolved into the assembly's frame, where the instance sits assembled. */
function datumAt(address: string, ctx: Ctx, errors: string[], where: string): DatumAt | null {
  const dot = address.indexOf('.')
  const [path, name] = [address.slice(0, dot), address.slice(dot + 1)]
  if (!ctx.paths.has(path)) {
    errors.push(`${where}: no instance "${path}" (in ${address})`)
    return null
  }
  const info = ctx.info.get(path)
  if (!info) {
    errors.push(`${where}: ${path} is a sub-assembly; name a datum on one of its instances ("${path}/<child>.<datum>")`)
    return null
  }
  const d = info.datums[name]
  const m = ctx.paths.get(path)!
  if (!d) {
    errors.push(`${where}: ${path} has no datum "${name}" (it has ${Object.keys(info.datums).join(', ') || 'none'})`)
    return null
  }
  if (d.kind === 'plane') return { kind: d.kind, origin: applyPoint(m, d.origin), dir: applyDir(m, d.normal) }
  if (d.kind === 'axis') return { kind: d.kind, origin: applyPoint(m, d.origin), dir: applyDir(m, d.direction) }
  if (d.kind === 'point') return { kind: d.kind, origin: applyPoint(m, d.at) }
  const c = d.points.reduce((a, p) => add(a, p), [0, 0, 0] as Vec3).map((x) => x / d.points.length) as Vec3
  return { kind: d.kind, origin: applyPoint(m, c), dir: applyDir(m, d.normal) }
}

function resolvePose(p: PoseInput, inst: string, ctx: Ctx, errors: string[], where: string): GuidePose {
  let offset: Vec3 = p.offset ?? [0, 0, 0]
  if (p.along) {
    const d = datumAt(p.along, ctx, errors, `${where} along`)
    if (d && !d.dir) errors.push(`${where}: along ${p.along} is a point; use a plane, axis or pattern datum, or an offset`)
    else if (d?.dir) {
      if (p.distance === undefined) errors.push(`${where}: along ${p.along} needs distance (mm)`)
      else offset = add(offset, scale(d.dir, p.distance))
    }
  } else if (p.distance !== undefined) errors.push(`${where}: distance needs along (a datum to move along)`)
  if (!p.turn) return { offset }
  const t = p.turn
  let axis: Vec3 | undefined = t.axis
  let pivot: Vec3 | undefined = t.pivot
  if (t.about) {
    const d = datumAt(t.about, ctx, errors, `${where} turn.about`)
    if (d && !d.dir) errors.push(`${where}: turn about ${t.about} needs an axis or plane datum (it turns about the axis, or the plane's normal through its origin)`)
    else if (d?.dir) {
      axis = axis ?? d.dir
      pivot = pivot ?? d.origin
    }
  }
  if (!axis) {
    if (!t.about) errors.push(`${where}: turn needs about (an axis or plane datum) or axis [x, y, z]`)
    return { offset }
  }
  const m = ctx.paths.get(inst)
  return { offset, turn: { axis: normalize(axis), deg: t.deg, pivot: pivot ?? (m ? [m[3], m[7], m[11]] : [0, 0, 0]) } }
}

function labelPoint(at: string | Vec3, ctx: Ctx, errors: string[], where: string): Vec3 {
  if (Array.isArray(at)) return at
  if (at.includes('.')) return datumAt(at, ctx, errors, where)?.origin ?? [0, 0, 0]
  if (!ctx.paths.has(at)) {
    errors.push(`${where}: no instance "${at}"`)
    return [0, 0, 0]
  }
  return centreOf(at, ctx)
}

/** The centre of an instance's box (all its leaves), assembled. */
function centreOf(path: string, ctx: Ctx): Vec3 {
  const b = boxOf(ctx.leaves.filter((l) => within(l.path, path)), ctx)
  return b ? (mid(b.min, b.max) as Vec3) : (ctx.paths.get(path)?.filter((_, i) => i === 3 || i === 7 || i === 11) as Vec3) ?? [0, 0, 0]
}

function boxOf(leaves: AssemblyLeaf[], ctx: Ctx): { min: Vec3; max: Vec3 } | null {
  let min: Vec3 | null = null
  let max: Vec3 | null = null
  for (const l of leaves) {
    const i = ctx.info.get(l.path)
    if (!i) continue
    for (const c of corners(i.min, i.max)) {
      const p = applyPoint(l.matrix, c)
      min = min ? (min.map((v, k) => Math.min(v, p[k])) as Vec3) : p
      max = max ? (max.map((v, k) => Math.max(v, p[k])) as Vec3) : p
    }
  }
  return min && max ? { min, max } : null
}

/** The explode shorthand: each instance moves out from the assembly's centre, further out going further. */
function explode(e: NonNullable<StepInput['explode']>, ctx: Ctx, shown: Set<string>, poses: Map<string, GuidePose>, moved: Set<string>, errors: string[], where: string): GuideMotion[] {
  const all = boxOf(ctx.leaves, ctx)
  if (!all) return []
  const centre = mid(all.min, all.max) as Vec3
  const size = Math.max(...all.max.map((v, k) => v - all.min[k]))
  const ids = e.instances ?? [...new Set(ctx.leaves.filter((l) => shown.has(l.path)).map((l) => l.path.split('/')[0]))].filter((p) => p !== ctx.doc.ground)
  const axis = e.axis ? normalize(e.axis) : null
  // Along an axis everything goes the same way, further along it going further: a stack lifts
  // apart off its ground instead of half of it sinking through the ground.
  const low = axis ? Math.min(...[ctx.doc.ground, ...ids].filter((p) => ctx.paths.has(p)).map((p) => dot(centreOf(p, ctx), axis))) : 0
  const out = ids
    .filter((p) => {
      if (!ctx.paths.has(p)) errors.push(`${where} explode: no instance "${p}"`)
      return ctx.paths.has(p) && !moved.has(p)
    })
    .map((p) => {
      const v = sub(centreOf(p, ctx), centre)
      if (axis) return { p, dir: axis, mag: dot(centreOf(p, ctx), axis) - low }
      const mag = Math.hypot(...v)
      return { p, dir: mag > 1e-6 ? scale(v, 1 / mag) : ([0, 0, 1] as Vec3), mag }
    })
  const far = Math.max(1e-6, ...out.map((o) => o.mag))
  const distance = e.distance ?? 0.4 * size
  out.sort((a, b) => (e.back ? a.mag - b.mag : b.mag - a.mag))
  return out.map((o, k) => ({
    instance: o.p,
    from: poses.get(o.p) ?? ASSEMBLED,
    to: e.back ? ASSEMBLED : { offset: scale(o.dir, distance * (far > 1e-3 ? 0.5 + (0.5 * o.mag) / far : 1)) },
    via: [],
    delay: k * (e.stagger ?? 0.15),
    duration: e.duration ?? 1,
    ease: e.ease ?? 'in-out',
  }))
}

// ---------------------------------------------------------------- validation

type G3 = { kind: GuideDoc['kind']; upcoming: GuideDoc['upcoming']; steps: GuideStep[] }

function validate(g: G3, ctx: Ctx, part: (id: string) => PartDoc | null, assembly: (id: string) => AssemblyDoc | null): GuideFinding[] {
  const out: GuideFinding[] = []
  const starts = stepStarts(g, ctx.leaves)
  const leavesIn = (p: string) => ctx.leaves.filter((l) => within(l.path, p))
  g.steps.forEach((step, i) => {
    const start = starts[i]
    const present = (path: string) => start.shown.has(path) || step.add.some((p) => within(path, p))
    for (const p of step.add) {
      const already = leavesIn(p).filter((l) => start.shown.has(l.path))
      if (already.length)
        out.push({ kind: 'added_twice', severity: 'warning', step: i, instances: [p], message: `Step ${i + 1} adds ${p}, but ${already.length === leavesIn(p).length ? 'it is' : `${already.map((l) => l.path).join(', ')} ${already.length === 1 ? 'is' : 'are'}`} already shown${g.kind === 'build' ? '' : ` (a${g.kind === 'exploded' ? 'n exploded view' : 'n explanation'} starts with everything shown)`}.` })
    }
    const need = (p: string, what: string) => {
      if (!leavesIn(p).some((l) => present(l.path))) out.push({ kind: 'not_present', severity: 'warning', step: i, instances: [p], message: `Step ${i + 1} ${what} ${p}, which isn't shown then${start.gone.has(leavesIn(p)[0]?.path ?? '') ? ' (an earlier step removed it)' : g.kind === 'build' ? ' (add it in this step or an earlier one)' : ''}.` })
    }
    for (const m of step.motions) need(m.instance, 'moves')
    for (const p of step.focus ?? []) need(p, 'focuses on')
    for (const p of step.remove) need(p, 'removes')
    for (const l of step.labels) if (typeof l.at === 'string') need(l.at.split('.')[0], `labels "${l.text}" on`)
  })
  const end = starts[g.steps.length]
  if (g.kind === 'build') {
    const never = ctx.leaves.filter((l) => !end.shown.has(l.path) && !end.gone.has(l.path)).map((l) => l.path)
    // One finding per top-level instance that never shows at all, else per leaf.
    const tops = [...new Set(never.map((p) => p.split('/')[0]))]
    for (const t of tops) {
      const whole = leavesIn(t).every((l) => never.includes(l.path))
      const ps = whole ? [t] : never.filter((p) => within(p, t))
      out.push({ kind: 'never_added', severity: 'warning', instances: ps, message: `${ps.join(', ')} ${ps.length === 1 ? 'is' : 'are'} never added; the build ends without ${ps.length === 1 ? 'it' : 'them'}.` })
    }
    for (const [p, pose] of end.poses) {
      if (isAssembled(pose, 1e-3) || leavesIn(p).every((l) => end.gone.has(l.path))) continue
      const last = g.steps.map((s, k) => (s.motions.some((m) => m.instance === p) ? k : -1)).reduce((a, b) => Math.max(a, b), -1)
      out.push({ kind: 'ends_apart', severity: 'warning', step: last, instances: [p], value: +Math.hypot(...pose.offset).toFixed(3), unit: 'mm', message: `${p} ends ${poseText(pose)} from where it sits assembled (left there by step ${last + 1}); a build guide should end with everything in place.` })
    }
  }
  // Hardware: the steps' against the joining hardware (parts' own hardware may appear in steps too).
  const joined = joiningHardware(ctx.doc, assembly).map((j) => j.h)
  const partHardware = ctx.leaves.flatMap((l) => ('part' in l.ref ? (part(l.ref.part)?.hardware ?? []) : []))
  const hardwareKey = hardwareKeys([...joined, ...partHardware, ...g.steps.flatMap((s) => s.hardware)])
  const used = new Map<string, { qty: number; name: string }>()
  for (const s of g.steps)
    for (const h of s.hardware) {
      const k = hardwareKey(h)
      used.set(k, { qty: (used.get(k)?.qty ?? 0) + h.qty, name: used.get(k)?.name ?? h.name })
    }
  const joining = new Map<string, { qty: number; name: string }>()
  for (const h of joined) {
    const k = hardwareKey(h)
    joining.set(k, { qty: (joining.get(k)?.qty ?? 0) + h.qty, name: joining.get(k)?.name ?? h.name })
  }
  const ofParts = new Set(partHardware.map(hardwareKey))
  if (!joining.size) {
    if (used.size) out.push({ kind: 'hardware', severity: 'info', instances: [], message: `The steps use ${[...used.values()].map((u) => `${u.qty}× ${u.name}`).join(', ')}; ${ctx.doc.id} has no joining hardware set to check them against (set_assembly_hardware).` })
  } else if (g.kind === 'build' || used.size) {
    const diffs: string[] = []
    for (const [k, j] of joining) {
      const u = used.get(k)?.qty ?? 0
      if (u !== j.qty) diffs.push(`${j.name}: the steps use ${u}, the joining hardware lists ${j.qty}`)
    }
    for (const [k, u] of used) if (!joining.has(k) && !ofParts.has(k)) diffs.push(`${u.name}: the steps use ${u.qty}, but it isn't in the joining hardware or any part's`)
    if (diffs.length) out.push({ kind: 'hardware', severity: 'warning', instances: [], message: `The steps' hardware doesn't add up: ${diffs.join('; ')}.` })
  }
  return out
}

// ---------------------------------------------------------------- what the geometry service gets

/**
 * Samples for the path check, from the viewer's own math: per step with motions, the matrices of
 * the present leaves when it starts and, per sample, those of the moving ones and which of them still
 * count (a motion that ends assembled has arrived at its last moment: parts touch there).
 */
function pathCheck(g: G3, ctx: Ctx) {
  const starts = stepStarts(g, ctx.leaves)
  const plans: { i: number; n: number }[] = []
  g.steps.forEach((step, i) => {
    if (!step.motions.length) return
    const duration = stepDuration(step)
    const F = 120
    let worst = 0
    let prev: Map<string, Vec3[]> | null = null
    for (let k = 0; k < F; k++) {
      const st = guideState(g, ctx.leaves, i, (duration * k) / (F - 1), starts)
      const now = new Map<string, Vec3[]>()
      for (const l of ctx.leaves) {
        const s = st.get(l.path)!
        const info = ctx.info.get(l.path)
        if (!s.present || !s.moving || !info) continue
        const cs = corners(info.min, info.max).map((c) => applyPoint(s.matrix, c))
        now.set(l.path, cs)
        const before = prev?.get(l.path)
        if (before) for (let c = 0; c < 8; c++) worst = Math.max(worst, Math.hypot(...sub(cs[c], before[c])))
      }
      prev = now
    }
    plans.push({ i, n: Math.min(MAX_STEP_SAMPLES, Math.max(2, Math.ceil(((F - 1) * worst) / SPACING) + 1)) })
  })
  const total = plans.reduce((t, p) => t + p.n, 0)
  const coarse: number[] = []
  if (total > MAX_SAMPLES)
    for (const p of plans) {
      const n = Math.max(2, Math.floor((p.n * MAX_SAMPLES) / total))
      if (n < p.n) coarse.push(p.i + 1)
      p.n = n
    }
  const steps = plans.map(({ i, n }) => {
    const step = g.steps[i]
    const st0 = guideState(g, ctx.leaves, i, 0, starts)
    const present = ctx.leaves.filter((l) => st0.get(l.path)!.present).map((l) => l.path)
    const samples = sampleTimes(step, n).map((t) => {
      const st = guideState(g, ctx.leaves, i, t, starts)
      const m: Record<string, number[]> = {}
      const active: string[] = []
      for (const l of ctx.leaves) {
        const s = st.get(l.path)!
        if (!s.present || !s.moving) continue
        m[l.path] = s.matrix
        const holders = step.motions.filter((mo) => within(l.path, mo.instance))
        if (!holders.every((mo) => t >= mo.delay + mo.duration - 1e-9 && isAssembled(mo.to))) active.push(l.path)
      }
      return { t, m, active }
    })
    return { step: i, duration: stepDuration(step), present, static: Object.fromEntries(present.map((p) => [p, st0.get(p)!.matrix])), samples }
  })
  return { steps, coarse: coarse.length ? coarse : null }
}

/** One picture per step (and view) at a moment: what shows how, the camera, labels where they are then, and motion trails. */
function sheetCells(g: G3, ctx: Ctx, indexes: number[], moment: 'end' | 'start' | number, views?: ViewName[]): Cell[] {
  const starts = stepStarts(g, ctx.leaves)
  const cells: Cell[] = []
  for (const i of indexes) {
    const step = g.steps[i]
    const duration = stepDuration(step)
    const t = moment === 'end' ? duration : moment === 'start' ? 0 : Math.min(moment, duration)
    const st = guideState(g, ctx.leaves, i, t, starts)
    const items = ctx.leaves.flatMap((l) => {
      const s = st.get(l.path)!
      return s.opacity > 0.001 ? [{ path: l.path, matrix: s.matrix, alpha: s.opacity, ghost: s.ghost }] : []
    })
    const framed = stepFrame(step)
    const frame = framed.length ? items.filter((x) => framed.some((p) => within(x.path, p))).map((x) => x.path) : []
    const labels = step.labels.map((l) => ({ text: l.text, point: typeof l.at === 'string' ? follow(l.point, l.at.split('.')[0], ctx, st) : l.point }))
    // Where each moving instance's centre went, up to this moment.
    const trails: Vec3[][] = []
    if (t > 0 && step.motions.length) {
      const states = Array.from({ length: 24 }, (_, k) => guideState(g, ctx.leaves, i, (t * k) / 23, starts))
      for (const m of step.motions) {
        const ls = ctx.leaves.filter((l) => within(l.path, m.instance) && ctx.info.has(l.path))
        if (!ls.length) continue
        const pts = states.map((s) => {
          const cs = ls.map((l) => applyPoint(s.get(l.path)!.matrix, mid(ctx.info.get(l.path)!.min, ctx.info.get(l.path)!.max) as Vec3))
          return cs.reduce((a, c) => add(a, scale(c, 1 / cs.length)), [0, 0, 0] as Vec3)
        })
        const length = pts.slice(1).reduce((n, p, k) => n + Math.hypot(...sub(p, pts[k])), 0)
        if (length > 0.5) trails.push(pts)
      }
    }
    for (const v of views ?? [null]) {
      const view = v ? VIEWS[v] : resolveView(step.camera?.view)
      const turned = !v && step.camera?.orbit ? rotateAbout(view.dir, view.up, (step.camera.orbit * t) / duration) : view.dir
      cells.push({ title: `${i + 1}. ${step.title}${v ? ` (${v})` : ''}`, warn: !!step.warning, dir: turned, up: view.up, zoom: v ? 1 : (step.camera?.zoom ?? 1), frame, items, labels, trails })
    }
  }
  return cells
}

function resolveView(v: NonNullable<GuideStep['camera']>['view']): { dir: Vec3; up: Vec3 } {
  if (!v) return VIEWS.iso
  if (typeof v === 'string') return VIEWS[v]
  const dir = normalize(v.dir)
  const up = v.up ? normalize(v.up) : Math.abs(dir[2]) > 0.95 ? ([0, 1, 0] as Vec3) : ([0, 0, 1] as Vec3)
  return { dir, up }
}

/** A point given on an instance, carried along with the instance's pose at that moment. */
function follow(point: Vec3, inst: string, ctx: Ctx, st: Map<string, LeafState>): Vec3 {
  const leaf = ctx.leaves.find((l) => within(l.path, inst))
  const s = leaf && st.get(leaf.path)
  if (!leaf || !s?.present) return point
  return applyPoint(mul(s.matrix, invertRigid(leaf.matrix)), point)
}

// ---------------------------------------------------------------- text for the AI

function poseText(p: GuidePose) {
  const parts: string[] = []
  if (Math.hypot(...p.offset) > 1e-6) parts.push(`[${p.offset.map((x) => +x.toFixed(2)).join(', ')}] mm`)
  if (p.turn?.deg) parts.push(`turned ${+p.turn.deg.toFixed(1)}° about [${p.turn.axis.map((x) => +x.toFixed(3)).join(', ')}] through [${p.turn.pivot.map((x) => +x.toFixed(2)).join(', ')}]`)
  return parts.join(', ') || 'assembled'
}

function stepLine(s: GuideStep, i: number) {
  const bits: string[] = []
  if (s.add.length) bits.push(`add ${s.add.join(', ')}`)
  if (s.remove.length) bits.push(`remove ${s.remove.join(', ')}`)
  for (const m of s.motions) bits.push(`${m.instance} ${poseText(m.from)} → ${m.via.length ? `${m.via.map(poseText).join(' → ')} → ` : ''}${poseText(m.to)}${m.delay ? ` from ${m.delay} s` : ''} over ${m.duration} s`)
  if (s.camera) bits.push(`camera ${typeof s.camera.view === 'object' ? `[${s.camera.view.dir.join(', ')}]` : (s.camera.view ?? 'iso')}${s.camera.frame ? ` on ${s.camera.frame.join(', ')}` : ''}${s.camera.zoom ? ` ×${s.camera.zoom}` : ''}${s.camera.orbit ? ` orbit ${s.camera.orbit}°` : ''}`)
  if (s.focus) bits.push(`focus ${s.focus.join(', ')}`)
  if (s.labels.length) bits.push(`labels ${s.labels.map((l) => `"${l.text}"`).join(', ')}`)
  if (s.hardware.length) bits.push(`hardware ${s.hardware.map((h) => `${h.qty}× ${h.name}${h.itemId ? ` (shop ${h.itemId})` : ''}`).join(', ')}`)
  if (s.tools.length) bits.push(`tools ${s.tools.join(', ')}`)
  if (s.warning) bits.push(`warning "${s.warning}"`)
  return `${i + 1}. ${s.title} (${stepDuration(s).toFixed(1)} s): ${bits.join('; ') || 'holds'}`
}

function describe(g: GuideDoc, src: GuideSource | null, a: AssemblyDoc | null, full: boolean) {
  const total = g.steps.reduce((t, s) => t + stepDuration(s), 0)
  const lines = [`${g.id} "${g.name}" v${g.version}: ${g.kind} guide for ${g.assembly}${a ? ` (checked against v${g.assemblyVersion}${a.version > g.assemblyVersion ? `; the assembly is v${a.version} now, so the check is out of date: edit_guide with ops: [] re-checks` : ''})` : ' (ASSEMBLY DELETED)'}, ${g.steps.length} steps, ${total.toFixed(1)} s${g.kind === 'build' ? `, upcoming ${g.upcoming}` : ''}`]
  if (g.summary) lines.push(`summary: ${g.summary}`)
  lines.push('steps:', ...g.steps.map(stepLine))
  const r = g.report
  if (r) {
    lines.push(`findings: ${r.warnings ? `${r.warnings} warning${r.warnings === 1 ? '' : 's'}` : 'no warnings'}${r.partial ? ' (PARTIAL path check: the time limit stopped it)' : ''}`)
    for (const f of [...r.findings].sort((x, y) => (x.severity === y.severity ? 0 : x.severity === 'warning' ? -1 : 1))) lines.push(`- ${f.kind}${f.severity === 'info' ? ' (info)' : ''}${f.step !== undefined ? ` [step ${f.step + 1}]` : ''}: ${f.message}`)
  }
  if (full && src) lines.push('as written (edit_guide changes these by number):', ...src.steps.map((s, i) => `${i + 1}. ${JSON.stringify(s)}`))
  if (full) lines.push(versionsLine(g))
  return lines.join('\n')
}

function summaryLine(g: GuideDoc, a: AssemblyDoc | null) {
  const total = g.steps.reduce((t, s) => t + stepDuration(s), 0)
  const r = g.report
  return `${g.id} "${g.name}" v${g.version} · ${g.kind} · ${g.assembly} · ${g.steps.length} steps, ${total.toFixed(1)} s · ${r ? (r.warnings ? `${r.warnings} warning${r.warnings === 1 ? '' : 's'} (${[...new Set(r.findings.filter((f) => f.severity === 'warning').map((f) => f.kind))].join(', ')})` : 'no warnings') : 'not checked'}${!a ? ' · ASSEMBLY DELETED' : a.version > g.assemblyVersion ? ` · assembly changed since (v${g.assemblyVersion} → v${a.version})` : ''}`
}

function versionsLine(g: GuideDoc) {
  return `versions (newest first): ${(g.versions ?? []).map((v) => `v${v.version} ${new Date(v.at).toISOString().slice(0, 16)} ${v.note || '-'}`).join('; ')}`
}

// ---------------------------------------------------------------- small maths

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const mid = (a: number[], b: number[]) => a.map((v, k) => (v + b[k]) / 2)

function corners(min: Vec3, max: Vec3): Vec3[] {
  const out: Vec3[] = []
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) out.push([x, y, z])
  return out
}

/** The inverse of a rotation-and-translation matrix. */
function invertRigid(m: M4): M4 {
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]]
  const t = [m[3], m[7], m[11]]
  const it = [-(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]), -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]), -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2])]
  return [r[0], r[1], r[2], it[0], r[3], r[4], r[5], it[1], r[6], r[7], r[8], it[2], 0, 0, 0, 1]
}

/** `v` turned `deg` about the unit axis `k` (Rodrigues). */
function rotateAbout(v: Vec3, k: Vec3, deg: number): Vec3 {
  const a = (deg * Math.PI) / 180
  const u = normalize(k)
  const c = Math.cos(a)
  const s = Math.sin(a)
  const cr: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  return add(add(scale(v, c), scale(cr, s)), scale(u, dot(u, v) * (1 - c)))
}

function invalid(input: unknown, error: { issues: { path: PropertyKey[]; message: string }[] }) {
  return JSON.stringify({ INVALID_INPUT: input, problems: error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`) })
}

function bytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
