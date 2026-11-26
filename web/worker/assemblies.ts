// Assemblies: instances of the project's parts, the account's components and other assemblies,
// placed by position or by snapping datums together. Every save lays them out in the geometry
// service (geometry/assembly.py), checks the result (geometry/check.py) and renders it; findings
// are warnings and never block the save. The Project object owns the tables and hands this class
// what it needs; the in-app AI and outside agents (MCP) call the same tools.

import type { AssemblyDoc, AssemblyInstance, AssemblyLeaf, CheckReport, Datum, Finding, FindingKind, InstanceSpec, PartDoc, Requirement, ServerEvent, SnapResult } from '../shared/protocol'
import { geometryJson } from './components'
import type { ComponentRef } from './components'
import type { Env } from './env'
import type { Block } from './llm'
import * as T from './tools-assembly'

const DEFAULT_CLEARANCE = 0.2
const TIME_LIMIT = 30

/** What gets saved per version: the assembly as written. */
type Spec = { name: string; instances: InstanceSpec[]; requirements: Requirement[]; clearance: number }

export type AssemblyHost = {
  sql: SqlStorage
  env: Env
  projectId(): string
  parts(): PartDoc[]
  part(id: string): PartDoc | null
  componentRefs(ids: string[]): Promise<ComponentRef[]>
  /** Sources for part(id) (and pinned "id@v" entries are added here) and the assets of the parts named in `code`. */
  partInputs(code: string): Promise<{ parts: Record<string, string>; assets: Record<string, string> }>
  broadcast(event: ServerEvent): void
}

/** A tool's outcome: what the caller sees, a line for the chat, a fact for the in-app AI's history. */
export type AssemblyOutcome = { content: Block[]; isError?: boolean; detail: string; render?: string; line?: string; fact?: string }

type GeoFinding = Omit<Finding, 'mesh'> & { mesh?: number }
type GeoOut =
  | {
      ok: true
      ms: number
      instances?: { id: string; matrix: number[]; status: 'ok' | 'unresolved'; problem?: string; snaps?: (SnapResult & { at?: unknown; pairs?: unknown })[] }[]
      ground?: string
      leaves: { path: string; name: string; key: string; matrix: number[]; color: string }[]
      findings: GeoFinding[]
      clashes: unknown[]
      render?: string
      thumb?: string
      partial?: boolean
      pairs_checked?: number
      pairs_skipped?: number
      check_ms?: number
      step?: string
      step_bytes?: number
    }
  | { ok: false; ms: number; error: { type: string; message: string } }

export class Assemblies {
  constructor(private h: AssemblyHost) {
    h.sql.exec(`
      CREATE TABLE IF NOT EXISTS assemblies (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assembly_versions (assembly TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, PRIMARY KEY (assembly, version));`)
  }

  list(): AssemblyDoc[] {
    return this.h.sql.exec<{ doc: string }>('SELECT doc FROM assemblies').toArray().map((r) => JSON.parse(r.doc))
  }

  get(id: string): AssemblyDoc | null {
    const row = this.h.sql.exec<{ doc: string }>('SELECT doc FROM assemblies WHERE id = ?', id).toArray()[0]
    return row ? JSON.parse(row.doc) : null
  }

  /**
   * A part got a new version: the assemblies that use it (directly or through sub-assemblies) keep
   * their placement until their next save, which follows the new version. Returns lines for the build report.
   */
  markStale(partId: string, version: number): string[] {
    const lines: string[] = []
    const all = this.list()
    const uses = (a: AssemblyDoc, seen: Set<string>): boolean =>
      a.instances.some((i) => ('part' in i.ref && i.ref.part === partId && !i.ref.version) || ('assembly' in i.ref && !seen.has(i.ref.assembly) && !!this.get(i.ref.assembly) && uses(this.get(i.ref.assembly)!, new Set([...seen, i.ref.assembly]))))
    for (const a of all) {
      if (!uses(a, new Set([a.id]))) continue
      const stale = [...(a.stale ?? []).filter((s) => s.ref !== `part:${partId}`), { ref: `part:${partId}`, version }]
      this.store({ ...a, stale })
      lines.push(`assembly ${a.id} uses ${partId}; it keeps its placement and check until its next save (place with instances: [] re-places it; check_assembly previews)`)
    }
    return lines
  }

  // ---------------------------------------------------------------- tools

  async run(name: string, input: unknown, signal: AbortSignal, withImage: boolean): Promise<AssemblyOutcome> {
    const fail = (text: string, detail: string): AssemblyOutcome => ({ content: [{ type: 'text', text }], isError: true, detail })
    const parse = <S extends { safeParse: (v: unknown) => { success: true; data: unknown } | { success: false; error: unknown } }>(schema: S) => {
      const r = schema.safeParse(input)
      return r.success ? (r.data as never) : null
    }
    const bad = (schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }) => fail(T.invalid(input, schema.safeParse(input).error as never), 'invalid input')

    if (name === 'list_assemblies') {
      const all = this.list()
      return { content: [{ type: 'text', text: all.length ? all.map((a) => summaryLine(a)).join('\n') : 'No assemblies in this project yet. Make one with write_assembly.' }], detail: `${all.length} assemblies` }
    }
    if (name === 'read_assembly') {
      const f = parse(T.ReadAssembly) as { assembly: string; version?: number } | null
      if (!f) return bad(T.ReadAssembly)
      const doc = this.get(f.assembly)
      if (!doc) return fail(this.missing(f.assembly), `${f.assembly} · not found`)
      if (f.version) {
        const row = this.h.sql.exec<{ spec: string; note: string }>('SELECT spec, note FROM assembly_versions WHERE assembly = ? AND version = ?', doc.id, f.version).toArray()[0]
        if (!row) return fail(`${doc.id} has no v${f.version}. ${versionsLine(doc)}`, 'no such version')
        return { content: [{ type: 'text', text: `${doc.id} v${f.version} (${row.note || '-'}) as written:\n${row.spec}\n${versionsLine(doc)}` }], detail: `${doc.id} v${f.version}` }
      }
      return { content: [{ type: 'text', text: describe(doc) }], detail: `${doc.id} v${doc.version}` }
    }
    if (name === 'write_assembly') {
      const f = parse(T.WriteAssembly) as { id: string; name: string; instances: InstanceSpec[]; requirements?: Requirement[]; clearance?: number; note?: string; views?: string[]; section?: unknown } | null
      if (!f) return bad(T.WriteAssembly)
      const prev = this.get(f.id)
      const spec: Spec = { name: f.name, instances: f.instances, requirements: f.requirements ?? [], clearance: f.clearance ?? prev?.clearance ?? DEFAULT_CLEARANCE }
      return this.save(f.id, spec, f.note ?? (prev ? 'Rewrote the assembly' : 'First layout'), { views: f.views, section: f.section }, signal, withImage)
    }
    if (name === 'place') {
      const f = parse(T.Place) as { assembly: string; instances: (Partial<InstanceSpec> & { id: string; snap?: unknown; pos?: unknown; rot?: unknown })[]; note?: string; views?: string[]; section?: unknown } | null
      if (!f) return bad(T.Place)
      const doc = this.get(f.assembly)
      if (!doc) return fail(this.missing(f.assembly), `${f.assembly} · not found`)
      const instances = specOf(doc).instances.map((i) => ({ ...i }))
      for (const p of f.instances) {
        const at = instances.findIndex((i) => i.id === p.id)
        const merged: Record<string, unknown> = at >= 0 ? { ...instances[at] } : {}
        for (const [k, v] of Object.entries(p)) {
          if (v === null) delete merged[k]
          else if (v !== undefined) merged[k] = v
        }
        const ok = T.InstanceSchema.safeParse(merged)
        if (!ok.success) return fail(`Instance ${p.id}: ${at >= 0 ? '' : 'a new instance needs name and ref. '}${T.invalid(merged, ok.error)}`, 'invalid instance')
        if (at >= 0) instances[at] = ok.data as InstanceSpec
        else instances.push(ok.data as InstanceSpec)
      }
      const moved = f.instances.map((i) => i.id)
      return this.save(doc.id, { ...specOf(doc), instances }, f.note ?? (moved.length ? `Placed ${moved.join(', ')}` : 'Re-placed'), { views: f.views, section: f.section }, signal, withImage)
    }
    if (name === 'remove_instances') {
      const f = parse(T.RemoveInstances) as { assembly: string; ids: string[]; note?: string } | null
      if (!f) return bad(T.RemoveInstances)
      const doc = this.get(f.assembly)
      if (!doc) return fail(this.missing(f.assembly), `${f.assembly} · not found`)
      const unknown = f.ids.filter((id) => !doc.instances.some((i) => i.id === id))
      if (unknown.length) return fail(`${doc.id} has no instance ${unknown.join(', ')}. Instances: ${doc.instances.map((i) => i.id).join(', ')}.`, 'no such instance')
      const spec = specOf(doc)
      return this.save(doc.id, { ...spec, instances: spec.instances.filter((i) => !f.ids.includes(i.id)) }, f.note ?? `Removed ${f.ids.join(', ')}`, {}, signal, withImage)
    }
    if (name === 'render_assembly') {
      const f = parse(T.RenderAssembly) as { assembly: string; views?: string[]; section?: unknown; size?: number; caption?: string } | null
      if (!f) return bad(T.RenderAssembly)
      const doc = this.get(f.assembly)
      if (!doc) return fail(this.missing(f.assembly), `${f.assembly} · not found`)
      const highlight = (doc.report?.findings ?? []).filter((x) => x.kind === 'clash').map((x) => x.instances)
      const out = await this.geometry(doc, { leaves: doc.leaves.map((l) => ({ path: l.path, name: l.name, key: keyOfRef(l.ref, true), matrix: l.matrix, color: l.color })), render: { views: f.views, section: f.section, size: f.size }, highlight }, signal)
      if (!out.ok) return fail(`The render failed: ${out.error.message}`, 'render failed')
      if (!out.render) return fail('Nothing to draw (the section leaves nothing on the kept side?).', 'empty')
      const key = `projects/${this.h.projectId()}/renders/${crypto.randomUUID()}.png`
      await this.h.env.FILES.put(key, bytes(out.render), { httpMetadata: { contentType: 'image/png' } })
      return {
        content: [{ type: 'text', text: `${doc.id} v${doc.version} as saved: ${doc.leaves.length} instances drawn${highlight.length ? `, ${highlight.length} clash${highlight.length === 1 ? '' : 'es'} in red` : ''}.` }, { type: 'image', mediaType: 'image/png', data: out.render }],
        detail: `${doc.id} v${doc.version}`,
        render: key,
      }
    }
    if (name === 'check_assembly') {
      const f = parse(T.CheckAssembly) as { assembly: string; clearance?: number; requirements?: Requirement[]; time_limit?: number; views?: string[]; section?: unknown } | null
      if (!f) return bad(T.CheckAssembly)
      const doc = this.get(f.assembly)
      if (!doc) return fail(this.missing(f.assembly), `${f.assembly} · not found`)
      const saved = specOf(doc)
      const spec: Spec = { ...saved, clearance: f.clearance ?? saved.clearance, requirements: [...saved.requirements, ...(f.requirements ?? [])] }
      const started = Date.now()
      const out = await this.layout(doc.id, spec, doc, { check: true, render: { views: f.views, section: f.section }, time_limit: f.time_limit }, signal)
      if (typeof out === 'string') return fail(out, 'not checked')
      if (!out.ok) return fail(out.error.message, out.error.type)
      const report = toReport(out, spec.clearance, () => undefined)
      const preview = await this.document(doc.id, spec, out, doc.version, report, doc.files)
      let render: string | undefined
      const content: Block[] = [{ type: 'text', text: `Checked ${doc.id} in ${((Date.now() - started) / 1000).toFixed(1)} s (not saved; placed from its parts' latest versions${f.clearance !== undefined ? `, clearance ${spec.clearance} mm` : ''}${f.requirements?.length ? `, ${f.requirements.length} extra requirement${f.requirements.length === 1 ? '' : 's'}` : ''}).\n${describe(preview, false)}` }]
      if (out.render) {
        render = `projects/${this.h.projectId()}/renders/${crypto.randomUUID()}.png`
        await this.h.env.FILES.put(render, bytes(out.render), { httpMetadata: { contentType: 'image/png' } })
        if (withImage) content.push({ type: 'image', mediaType: 'image/png', data: out.render })
      }
      return { content, detail: `${doc.id} · ${report.warnings} warnings${report.partial ? ' · partial' : ''}`, render, line: `Checked ${doc.name}: ${report.warnings ? `${report.warnings} warnings` : 'no warnings'}` }
    }
    return fail(`Unknown tool ${name}.`, 'unknown tool')
  }

  // ---------------------------------------------------------------- saving

  private async save(id: string, spec: Spec, note: string, render: { views?: string[]; section?: unknown }, signal: AbortSignal, withImage: boolean): Promise<AssemblyOutcome> {
    const fail = (text: string, detail: string): AssemblyOutcome => ({ content: [{ type: 'text', text }], isError: true, detail })
    const ids = spec.instances.map((i) => i.id)
    const dupes = ids.filter((x, i) => ids.indexOf(x) !== i)
    if (dupes.length) return fail(`Instance ids must be unique; ${[...new Set(dupes)].join(', ')} repeat. Nothing was saved.`, 'duplicate ids')
    const prev = this.get(id)
    const started = Date.now()
    const out = await this.layout(id, spec, prev, { check: true, render }, signal)
    if (typeof out === 'string') return fail(`${out} Nothing was saved${prev ? `; ${id} stays at v${prev.version}` : ''}.`, 'not saved')
    if (!out.ok) return fail(`${out.error.message} Nothing was saved${prev ? `; ${id} stays at v${prev.version}` : ''}.`, `${out.error.type}`)

    const version = (prev?.version ?? 0) + 1
    const base = `projects/${this.h.projectId()}/assemblies/${id}/v${version}`
    const url = (suffix: string) => `/api/files/${base}${suffix}`
    await Promise.all([
      out.render && this.h.env.FILES.put(`${base}.png`, bytes(out.render), { httpMetadata: { contentType: 'image/png' } }),
      out.thumb && this.h.env.FILES.put(`${base}.thumb.png`, bytes(out.thumb), { httpMetadata: { contentType: 'image/png' } }),
      ...out.clashes.map((m, k) => this.h.env.FILES.put(`${base}.clash-${k}.json`, JSON.stringify(m), { httpMetadata: { contentType: 'application/json' } })),
    ])
    const report = toReport(out, spec.clearance, (k) => url(`.clash-${k}.json`))
    const doc = await this.document(id, spec, out, version, report, out.render ? { render: url('.png'), thumb: url('.thumb.png') } : prev?.files)
    this.h.sql.exec('INSERT OR REPLACE INTO assembly_versions VALUES (?, ?, ?, ?, ?)', id, version, JSON.stringify(spec), note, Date.now())
    const saved = this.store(doc)
    this.h.broadcast({ type: 'assembly', assembly: saved })
    const header = `Saved ${id} v${version} "${spec.name}" (${note}) in ${((Date.now() - started) / 1000).toFixed(1)} s; check ${((report.ms || 0) / 1000).toFixed(1)} s.`
    const content: Block[] = [{ type: 'text', text: `${header}\n${describe(saved, false)}` }]
    if (withImage && out.render) content.push({ type: 'image', mediaType: 'image/png', data: out.render })
    const warn = report.warnings ? ` · ${report.warnings} warning${report.warnings === 1 ? '' : 's'}` : ' · no warnings'
    return {
      content,
      detail: `${id} v${version} · ${spec.instances.length} instances${warn}`,
      line: `${spec.name} v${version}: ${note}${warn}`,
      fact: `saved assembly ${id} v${version} (${note}): ${spec.instances.length} instances${warn}${report.warnings ? `: ${report.findings.filter((x) => x.severity === 'warning').slice(0, 4).map((x) => x.kind).join(', ')}` : ''}`,
      ...(out.render && { render: `${base}.png` }),
    }
  }

  /** Lay out (and check, render) an assembly from its spec in the geometry service; a string is a problem with the spec. */
  private async layout(id: string, spec: Spec, prev: AssemblyDoc | null, opts: { check: boolean; render?: unknown; time_limit?: number }, signal: AbortSignal): Promise<GeoOut | string> {
    const subs: Record<string, Spec> = {}
    const partKeys = new Set<string>()
    const compIds = new Set<string>()
    const previous: Record<string, number[]> = {}
    for (const i of prev?.instances ?? []) previous[i.id] = i.matrix
    const visit = (sp: Spec, stack: string[], prefix: string): string | null => {
      for (const inst of sp.instances) {
        const r = inst.ref
        if ('part' in r) {
          const part = this.h.part(r.part)
          if (!part?.version) return `Instance ${prefix}${inst.id}: no built part "${r.part}". Parts: ${this.h.parts().filter((p) => p.version).map((p) => p.id).join(', ') || 'none'}.`
          if (r.version && !this.h.sql.exec('SELECT 1 FROM versions WHERE part = ? AND version = ?', r.part, r.version).toArray().length)
            return `Instance ${prefix}${inst.id}: ${r.part} has no v${r.version}.`
          partKeys.add(r.version ? `${r.part}@${r.version}` : r.part)
        } else if ('component' in r) compIds.add(r.component)
        else {
          if (r.assembly === id || stack.includes(r.assembly)) return `Instance ${prefix}${inst.id}: assembly ${r.assembly} would contain itself (${[...stack, r.assembly].join(' → ')}).`
          const sub = this.get(r.assembly)
          if (!sub) return `Instance ${prefix}${inst.id}: no assembly "${r.assembly}". Assemblies: ${this.list().map((a) => a.id).join(', ') || 'none'}.`
          subs[r.assembly] = specOf(sub)
          for (const i of sub.instances) previous[`${prefix}${inst.id}/${i.id}`] = i.matrix
          const why = visit(subs[r.assembly], [...stack, r.assembly], `${prefix}${inst.id}/`)
          if (why) return why
        }
      }
      return null
    }
    const why = visit(spec, [id], '')
    if (why) return why
    const refs = await this.h.componentRefs([...compIds])
    const missing = [...compIds].filter((c) => !refs.some((r) => r.id === c))
    if (missing.length) return `No component ${missing.join(', ')} in this account. Components: import them with import_component first.`
    return this.geometry(prev ?? { id, name: spec.name }, { spec, subs, partKeys: [...partKeys], refs, previous, ...opts }, signal)
  }

  /** One call to the geometry service's /assembly: either a spec to lay out, or placed leaves to draw or export. */
  private async geometry(
    doc: Pick<AssemblyDoc, 'id' | 'name'>,
    o: { spec?: Spec; subs?: Record<string, Spec>; partKeys?: string[]; refs?: ComponentRef[]; previous?: Record<string, number[]>; leaves?: { path: string; name: string; key: string; matrix: number[]; color?: string }[]; check?: boolean; render?: unknown; highlight?: string[][]; export?: boolean; time_limit?: number },
    signal: AbortSignal,
  ): Promise<GeoOut> {
    let partKeys = o.partKeys ?? []
    let refs = o.refs ?? []
    if (o.leaves) {
      partKeys = [...new Set(o.leaves.filter((l) => l.key.startsWith('part:')).map((l) => l.key.slice(5)))]
      refs = await this.h.componentRefs([...new Set(o.leaves.filter((l) => l.key.startsWith('component:')).map((l) => l.key.slice(10)))])
    }
    const ids = [...new Set(partKeys.map((k) => k.split('@')[0]))]
    const { parts, assets } = await this.h.partInputs(ids.map((p) => `part("${p}")`).join('\n'))
    const datums: Record<string, Record<string, Datum>> = {}
    const colors: Record<string, string> = {}
    for (const k of partKeys) {
      const [pid, v] = k.split('@')
      const part = this.h.part(pid)!
      colors[`part:${pid}`] = part.color
      if (v) {
        const row = this.h.sql.exec<{ source: string; datums: string }>('SELECT source, datums FROM versions WHERE part = ? AND version = ?', pid, Number(v)).toArray()[0]
        if (row) {
          parts[k] = row.source
          datums[`part:${k}`] = row.datums ? JSON.parse(row.datums) : {}
        }
      } else datums[`part:${pid}`] = part.datums ?? {}
    }
    const keepouts: Record<string, unknown> = {}
    for (const r of refs) {
      datums[`component:${r.id}`] = r.datums
      if (r.keepouts.length) keepouts[`component:${r.id}`] = r.keepouts
    }
    const body = {
      name: doc.name,
      ...(o.spec && { spec: { instances: o.spec.instances, requirements: o.spec.requirements, clearance: o.spec.clearance } }),
      ...(o.leaves && { leaves: o.leaves }),
      catalog: { datums, colors, keepouts, assemblies: Object.fromEntries(Object.entries(o.subs ?? {}).map(([k, s]) => [k, { instances: s.instances, requirements: s.requirements, clearance: s.clearance }])) },
      previous: o.previous ?? {},
      parts,
      assets,
      check: !!o.check,
      time_limit: o.time_limit ?? TIME_LIMIT,
      render: o.render ?? null,
      highlight: o.highlight ?? [],
      export: !!o.export,
      timeout: Math.max(120, (o.time_limit ?? TIME_LIMIT) + 90),
    }
    return geometryJson<GeoOut>(this.h.env, '/assembly', body, refs, signal)
  }

  private async document(id: string, spec: Spec, out: Extract<GeoOut, { ok: true }>, version: number, report: CheckReport, files: AssemblyDoc['files']): Promise<AssemblyDoc> {
    const refs = await this.h.componentRefs([...new Set(out.leaves.filter((l) => l.key.startsWith('component:')).map((l) => l.key.slice(10)))])
    const pid = this.h.projectId()
    const leaves: AssemblyLeaf[] = out.leaves.map((l) => {
      const [kind, ref] = [l.key.slice(0, l.key.indexOf(':')), l.key.slice(l.key.indexOf(':') + 1)]
      if (kind === 'component') return { path: l.path, name: l.name, ref: { component: ref }, matrix: l.matrix, mesh: refs.find((r) => r.id === ref)?.mesh ?? '', color: l.color }
      const [part, pinned] = ref.split('@')
      const v = pinned ? Number(pinned) : (this.h.part(part)?.version ?? 1)
      return { path: l.path, name: l.name, ref: { part, version: v }, matrix: l.matrix, mesh: `/api/files/projects/${pid}/${part}/v${v}.json`, color: l.color }
    })
    const placed = new Map((out.instances ?? []).map((i) => [i.id, i]))
    const instances: AssemblyInstance[] = spec.instances.map((inst) => {
      const p = placed.get(inst.id)
      const snaps = p?.snaps?.map(({ at: _at, pairs: _pairs, ...s }) => s)
      return {
        ...inst,
        matrix: p?.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        status: p?.status ?? 'ok',
        ...(p?.problem && { problem: p.problem }),
        ...(snaps?.length && { snaps }),
        ...('part' in inst.ref && { version: inst.ref.version ?? this.h.part(inst.ref.part)?.version }),
      }
    })
    const versions = this.h.sql
      .exec<{ version: number; note: string; created_at: number }>('SELECT version, note, created_at FROM assembly_versions WHERE assembly = ? ORDER BY version DESC LIMIT 11', id)
      .toArray()
      .map((v) => ({ version: v.version, note: v.note, at: v.created_at }))
    return {
      id,
      name: spec.name,
      version,
      instances,
      leaves,
      requirements: spec.requirements,
      clearance: spec.clearance,
      ground: out.ground ?? spec.instances.find((i) => i.ground)?.id ?? spec.instances[0]?.id ?? '',
      report,
      ...(files && { files }),
      versions,
      updatedAt: Date.now(),
    }
  }

  /** Writes the doc with its version list (the newest included once its row is in). */
  private store(doc: AssemblyDoc): AssemblyDoc {
    const versions = this.h.sql
      .exec<{ version: number; note: string; created_at: number }>('SELECT version, note, created_at FROM assembly_versions WHERE assembly = ? ORDER BY version DESC LIMIT 12', doc.id)
      .toArray()
      .map((v) => ({ version: v.version, note: v.note, at: v.created_at }))
    const out = { ...doc, versions }
    this.h.sql.exec('INSERT OR REPLACE INTO assemblies VALUES (?, ?)', doc.id, JSON.stringify(out))
    return out
  }

  private missing(id: string) {
    return `No assembly "${id}". Assemblies: ${this.list().map((a) => a.id).join(', ') || 'none'}.`
  }
}

// ---------------------------------------------------------------- helpers

/** The assembly as written, from its doc. */
export function specOf(doc: AssemblyDoc): Spec {
  const instances = doc.instances.map(({ matrix: _m, status: _s, problem: _p, snaps: _sn, version: _v, ...spec }) => spec as InstanceSpec)
  return { name: doc.name, instances, requirements: doc.requirements, clearance: doc.clearance }
}

/** "part:<id>", "part:<id>@<v>" or "component:<id>"; a leaf's part ref always carries the version it was placed with. */
function keyOfRef(ref: AssemblyLeaf['ref'], pinned: boolean) {
  if ('component' in ref) return `component:${ref.component}`
  return pinned ? `part:${ref.part}@${ref.version}` : `part:${ref.part}`
}

function toReport(out: Extract<GeoOut, { ok: true }>, clearance: number, meshUrl: (k: number) => string | undefined): CheckReport {
  const findings: Finding[] = out.findings.map((f) => ({ ...f, mesh: f.mesh !== undefined ? meshUrl(f.mesh) : undefined }))
  const counts: Partial<Record<FindingKind, number>> = {}
  for (const f of findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1
  return {
    at: Date.now(),
    ms: out.check_ms ?? 0,
    partial: !!out.partial,
    clearance,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    counts,
    findings,
    pairsChecked: out.pairs_checked ?? 0,
    pairsSkipped: out.pairs_skipped ?? 0,
  }
}

const n = (x: number, d = 3) => +x.toFixed(d)
const v3 = (v: number[]) => `[${v.map((x) => n(x)).join(', ')}]`

/** pos and rot (degrees, Rot convention) from a row-major matrix. */
export function placement(m: number[]) {
  const ry = Math.asin(Math.max(-1, Math.min(1, m[2])))
  let rx: number, rz: number
  if (Math.abs(m[2]) < 1 - 1e-9) {
    rx = Math.atan2(-m[6], m[10])
    rz = Math.atan2(-m[1], m[0])
  } else {
    rx = Math.atan2(m[9], m[5])
    rz = 0
  }
  const deg = (r: number) => n((r * 180) / Math.PI, 4) + 0
  return { pos: [m[3], m[7], m[11]], rot: [deg(rx), deg(ry), deg(rz)] }
}

function refLabel(ref: InstanceSpec['ref']) {
  if ('part' in ref) return `part ${ref.part}${ref.version ? ` (pinned v${ref.version})` : ''}`
  if ('component' in ref) return `component ${ref.component}`
  return `sub-assembly ${ref.assembly}`
}

function summaryLine(a: AssemblyDoc) {
  const r = a.report
  return `${a.id} "${a.name}" v${a.version} · ${a.instances.length} instances · ${r ? (r.warnings ? `${r.warnings} warnings (${Object.entries(r.counts).filter(([k]) => r.findings.some((f) => f.kind === k && f.severity === 'warning')).map(([k, c]) => `${c} ${k}`).join(', ')})` : 'no warnings') : 'not checked'}${a.stale?.length ? ' · OUT OF DATE' : ''}`
}

function versionsLine(a: AssemblyDoc) {
  return `versions (newest first): ${(a.versions ?? []).map((v) => `v${v.version} ${new Date(v.at).toISOString().slice(0, 16)} ${v.note || '-'}`).join('; ')}`
}

/** An assembly for the AI: instances, how each is placed and where it went, the last check. */
export function describe(a: AssemblyDoc, full = true) {
  const lines = [`${a.id} "${a.name}" v${a.version}, ground ${a.ground}, clearance ${a.clearance} mm`, 'instances:']
  for (const i of a.instances) {
    const { pos, rot } = placement(i.matrix)
    const how = i.snap ? (Array.isArray(i.snap) ? i.snap : [i.snap]).map((s) => `${s.own} → ${s.to}${s.offset ? ` offset ${s.offset}` : ''}${s.flip ? ' flip' : ''}${s.spin ? ` spin ${s.spin}°` : ''}`).join(' + ') : i.id === a.ground ? 'ground' : 'pos/rot'
    lines.push(`- ${i.id} "${i.name}": ${refLabel(i.ref)}${'part' in i.ref && i.version ? ` v${i.version}` : ''} · ${how} · at pos ${v3(pos)} rot ${v3(rot)}${i.color ? ` · ${i.color}` : ''}${i.status === 'unresolved' ? ` · UNRESOLVED: ${i.problem}` : ''}`)
    for (const s of i.snaps ?? []) {
      if (s.kind === 'pattern') lines.push(`    ${s.own} → ${s.to}: worst point ${n(s.residual_mm, 4)} mm, rms ${n(s.rms_mm ?? 0, 4)} mm, normals ${n(s.residual_deg, 4)}°`)
      else if (s.residual_mm > 1e-4 || s.residual_deg > 1e-4) lines.push(`    ${s.own} → ${s.to}: off by ${n(s.residual_mm, 4)} mm, ${n(s.residual_deg, 4)}°`)
    }
  }
  if (a.requirements.length) lines.push(`requirements: ${a.requirements.map((r) => r.name ?? `${r.kind}(${r.a}, ${r.b}${r.kind === 'distance' ? `, ${r.value}` : ''})`).join('; ')}`)
  if (a.stale?.length) lines.push(`OUT OF DATE: ${a.stale.map((s) => `${s.ref.replace('part:', '')} is now v${s.version}`).join(', ')}; the next save follows it (place with instances: [])`)
  const r = a.report
  if (r) {
    lines.push(`check (${(r.ms / 1000).toFixed(1)} s, ${r.pairsChecked} solid pairs looked at): ${r.warnings ? `${r.warnings} warning${r.warnings === 1 ? '' : 's'}` : 'no warnings'}`)
    if (r.partial) lines.push(`  PARTIAL: the time limit stopped it with ${r.pairsSkipped} pairs unchecked; run check_assembly with a longer time_limit.`)
    for (const f of r.findings.filter((x) => x.severity === 'warning')) lines.push(`- ${f.kind}: ${f.message}`)
    const info = r.findings.filter((x) => x.severity === 'info')
    const contacts = info.filter((x) => x.kind === 'contact')
    if (contacts.length) lines.push(`- contacts: ${contacts.map((c) => c.instances.join('–')).join(', ')}`)
    for (const f of info.filter((x) => x.kind !== 'contact')) lines.push(`- ${f.kind}: ${f.message}`)
  }
  if (full) lines.push(versionsLine(a))
  return lines.join('\n')
}

function bytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
