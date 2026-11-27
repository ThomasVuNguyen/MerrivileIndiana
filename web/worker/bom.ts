// Hardware lists and the bill of materials. Parts carry their own hardware (set_part_hardware), an
// assembly the hardware that joins its instances (set_assembly_hardware); the BOM counts both over
// every placed part, sub-assemblies flattened, and shows shop stock without ever taking it off:
// projects are plans, and twenty planned ones shouldn't block the twenty-first.

import type { AssemblyDoc, Bom, BomLine, PartDoc, PartHardware, ShopItem } from '../shared/protocol'
import type { ComponentRef } from './components'

export type HardwareInput = { item_id?: string; name: string; kind?: string; qty: number; tier?: PartHardware['tier']; source?: string }

/** Hardware as the AI wrote it, filled in from the shop where it names an item. */
export function resolveHardware(input: HardwareInput[], items: ShopItem[]): PartHardware[] {
  return input.map((h) => {
    const item = h.item_id ? items.find((i) => i.id === h.item_id) : undefined
    const source = item ? (item.tier === 'on-hand' ? [item.bin && `bin ${item.bin}`, item.qty !== undefined && `${item.qty} left`].filter(Boolean).join(' · ') : (item.price ?? '')) : (h.source ?? '')
    // The AI's name wins: "M3 × 12 SHCS" out of an M3 kit says more than the kit's name.
    return { qty: h.qty, name: h.name, kind: h.kind ?? '', tier: item?.tier ?? h.tier ?? 'order', source: item?.unit === 'kit' ? `from ${item.name} · ${source}` : source, itemId: item?.id }
  })
}

/** "M3 × 8", "m3x8" and "M3 x 8" are one line. */
export const normName = (name: string) => name.toLowerCase().replace(/[×*]/g, 'x').replace(/\s+/g, '')

/**
 * How hardware lines merge: by shop item, else by name. Made from every line that will be compared,
 * so a line written by name joins a shop item's line with the same name.
 */
export function hardwareKeys(all: { itemId?: string; name: string }[]) {
  const named = new Map<string, string>()
  for (const h of all) if (h.itemId) named.set(normName(h.name), `item:${h.itemId}`)
  return (h: { itemId?: string; name: string }) => (h.itemId ? `item:${h.itemId}` : (named.get(normName(h.name)) ?? `name:${normName(h.name)}`))
}

/** The joining hardware of an assembly and of every sub-assembly in it, once per placement. */
export function joiningHardware(a: AssemblyDoc, get: (id: string) => AssemblyDoc | null, seen = new Set<string>()): { h: PartHardware; from: string }[] {
  const out = (a.hardware ?? []).map((h) => ({ h, from: seen.size ? `${a.id} joining hardware` : 'joining hardware' }))
  for (const inst of a.instances) {
    if (!('assembly' in inst.ref) || seen.has(inst.ref.assembly)) continue
    const sub = get(inst.ref.assembly)
    if (sub) out.push(...joiningHardware(sub, get, new Set([...seen, a.id])))
  }
  return out
}

export function billOfMaterials(a: AssemblyDoc, ctx: { assembly(id: string): AssemblyDoc | null; part(id: string): PartDoc | null; components: ComponentRef[]; items: ShopItem[] }): Bom {
  const notes: string[] = []
  const parts = new Map<string, { qty: number; paths: string[]; versions: Set<number> }>()
  const comps = new Map<string, { qty: number; paths: string[] }>()
  for (const l of a.leaves) {
    if ('component' in l.ref) {
      const c = comps.get(l.ref.component) ?? { qty: 0, paths: [] }
      c.qty++
      c.paths.push(l.path)
      comps.set(l.ref.component, c)
    } else {
      const p = parts.get(l.ref.part) ?? { qty: 0, paths: [], versions: new Set<number>() }
      p.qty++
      p.paths.push(l.path)
      p.versions.add(l.ref.version)
      parts.set(l.ref.part, p)
    }
  }
  const lines: BomLine[] = []
  let massG = 0
  const bare: string[] = []
  const hardware = new Map<string, BomLine & { tierIn?: PartHardware['tier'] }>()
  const joining = joiningHardware(a, ctx.assembly)
  const hardwareKey = hardwareKeys([...[...parts.keys()].flatMap((id) => ctx.part(id)?.hardware ?? []), ...joining.map((j) => j.h)])
  const addHardware = (h: PartHardware, qty: number, from: string) => {
    const k = hardwareKey(h)
    const line = hardware.get(k) ?? { kind: 'hardware' as const, ...(k.startsWith('item:') && { ref: k.slice(5) }), name: h.name, qty: 0, from: [], ...(h.kind && { kindLabel: h.kind }), tierIn: h.tier }
    line.qty += qty
    line.from.push(from)
    hardware.set(k, line)
  }
  for (const [id, p] of parts) {
    const doc = ctx.part(id)
    const mass = doc?.metrics ? (doc.metrics.volume_mm3 / 1000) * doc.density : undefined
    if (mass !== undefined) massG += mass * p.qty
    lines.push({ kind: 'part', ref: id, name: doc?.name ?? id, qty: p.qty, from: [paths(p.paths)], ...(doc && { material: doc.material }), ...(mass !== undefined && { massG: round(mass, 1) }) })
    if (p.versions.size > 1) notes.push(`${id} is placed at different versions (${[...p.versions].map((v) => `v${v}`).join(', ')}).`)
    if (!doc?.hardware?.length) bare.push(id)
    for (const h of doc?.hardware ?? []) addHardware(h, h.qty * p.qty, `${id} × ${p.qty} (${h.qty} each)`)
  }
  for (const [id, c] of comps) {
    const ref = ctx.components.find((r) => r.id === id)
    lines.push({ kind: 'component', ref: id, name: ref?.name ?? id, qty: c.qty, from: [paths(c.paths)], ...(ref?.vendor && { vendor: ref.vendor }), ...(ref?.partNumber && { partNumber: ref.partNumber }), ...(ref?.link && { link: ref.link }) })
  }
  for (const { h, from } of joining) addHardware(h, h.qty, from)
  // "box joining hardware" twice (two placements of a sub-assembly) reads as "… × 2".
  for (const line of hardware.values()) line.from = [...new Set(line.from)].map((f) => (line.from.filter((x) => x === f).length > 1 ? `${f} × ${line.from.filter((x) => x === f).length}` : f))
  for (const line of hardware.values()) {
    const { tierIn, ...rest } = line
    const item = rest.ref ? ctx.items.find((i) => i.id === rest.ref) : undefined
    const tier = item?.tier ?? tierIn
    const have = item && item.tier === 'on-hand' && item.qty !== undefined ? item.qty : undefined
    lines.push({
      ...rest,
      ...(item && { kindLabel: rest.kindLabel ?? item.kind }),
      ...(tier && { tier }),
      ...(item?.image && { image: item.image }),
      ...(item?.price && { price: item.price }),
      ...(have !== undefined && { have }),
      ...(have !== undefined && rest.qty > have && { short: rest.qty - have }),
    })
    if (rest.ref && !item) notes.push(`${rest.name}: shop item ${rest.ref} is no longer in the shop.`)
  }
  if (bare.length) notes.push(`No hardware listed on ${bare.join(', ')}; if they take screws, inserts or bearings, set_part_hardware.`)
  if (!joining.length) notes.push('No joining hardware set on this assembly (screws between parts, nuts, standoffs): set_assembly_hardware.')
  const offShop = lines.filter((l) => l.kind === 'hardware' && !l.ref).length
  if (offShop) notes.push(`${offShop} hardware line${offShop === 1 ? ' is' : 's are'} not a shop item, so stock isn't known.`)
  if (a.stale?.length) notes.push(`The assembly is out of date (${a.stale.map((s) => s.ref.replace('part:', '')).join(', ')} changed); counts are from its last save.`)
  const count = (k: BomLine['kind']) => lines.filter((l) => l.kind === k).reduce((n, l) => n + l.qty, 0)
  return {
    assembly: a.id,
    version: a.version,
    lines,
    totals: { parts: count('part'), components: count('component'), hardware: count('hardware'), toBuy: lines.filter((l) => l.kind === 'hardware' && (l.tier !== 'on-hand' || (l.short ?? 0) > 0)).length, massG: round(massG, 1) },
    notes,
  }
}

/** The BOM for the AI: one line per entry, then totals and notes. */
export function describeBom(b: Bom, name: string) {
  const out = [`Bill of materials for ${b.assembly} "${name}" v${b.version} (planned; shop stock is shown, never taken off):`]
  const section = (kind: BomLine['kind'], title: string, fmt: (l: BomLine) => string) => {
    const ls = b.lines.filter((l) => l.kind === kind)
    if (ls.length) out.push(`${title}:`, ...ls.map((l) => `- ${l.qty}× ${fmt(l)}`))
  }
  section('part', 'parts', (l) => `${l.ref} "${l.name}"${l.material ? `, ${l.material}` : ''}${l.massG !== undefined ? `, ${l.massG} g each` : ''} (${l.from.join('; ')})`)
  section('component', 'components', (l) => `${l.ref} "${l.name}"${l.vendor ? `, ${l.vendor}` : ''}${l.partNumber ? ` ${l.partNumber}` : ''}${l.link ? ` ${l.link}` : ''}`)
  section(
    'hardware',
    'hardware',
    (l) =>
      `${l.name}${l.kindLabel && !l.name.toLowerCase().includes(l.kindLabel.toLowerCase()) ? ` ${l.kindLabel}` : ''}${l.ref ? ` (shop ${l.ref})` : ''} · ${l.tier ?? 'tier unknown'}${l.price ? ` · ${l.price}` : ''}${l.have !== undefined ? ` · ${l.have} on hand${l.short ? `, ${l.short} SHORT` : ''}` : ''} · from ${l.from.join('; ')}`,
  )
  const t = b.totals
  out.push(`totals: ${t.parts} parts (${t.massG} g), ${t.components} components, ${t.hardware} pieces of hardware; ${t.toBuy} line${t.toBuy === 1 ? '' : 's'} to buy`)
  if (b.notes.length) out.push('notes:', ...b.notes.map((n) => `- ${n}`))
  return out.join('\n')
}

const round = (x: number, d: number) => +x.toFixed(d)
const paths = (ps: string[]) => (ps.length > 6 ? `${ps.slice(0, 6).join(', ')} …` : ps.join(', '))
