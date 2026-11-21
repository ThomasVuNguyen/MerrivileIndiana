// The shop (hardware and tools) and memory, stored in the user's Account
// object. Every change the AI makes goes through the change log, so the chat
// can offer an undo.

import type { Attachment, LibraryItem, Memory, ShopItem, ShopTool, Tier } from '../shared/protocol'

type Kind = 'item' | 'tool' | 'memory' | 'library'
const TABLE: Record<Kind, string> = { item: 'items', tool: 'tools', memory: 'memories', library: 'library' }

export const ITEM_FIELDS = ['name', 'kind', 'category', 'detail', 'qty', 'full', 'unit', 'bin', 'tier', 'price', 'link', 'image', 'notes'] as const
export type ItemPatch = Partial<Pick<ShopItem, (typeof ITEM_FIELDS)[number]>>
export type ToolPatch = Partial<Pick<ShopTool, 'name' | 'kind' | 'can' | 'have'>>

export class ShopStore {
  constructor(private sql: SqlStorage) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tools (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL,
        before TEXT, after TEXT, undone INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);`)
  }

  // ------------------------------------------------------------ reads

  items(): ShopItem[] {
    return this.all<ShopItem>('item').sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, undefined, { numeric: true }))
  }

  tools(): ShopTool[] {
    const order = { machine: 0, hand: 1, service: 2 }
    return this.all<ShopTool>('tool').sort((a, b) => Number(b.have) - Number(a.have) || order[a.kind] - order[b.kind] || a.name.localeCompare(b.name))
  }

  memories(projectId?: string): Memory[] {
    return this.all<Memory>('memory')
      .filter((m) => !projectId || m.scope === 'everywhere' || m.scope === projectId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  item(id: string) {
    return this.get<ShopItem>('item', id)
  }

  library(): LibraryItem[] {
    return this.all<LibraryItem>('library').sort((a, b) => b.createdAt - a.createdAt)
  }

  libraryItem(id: string) {
    return this.get<LibraryItem>('library', id)
  }

  addLibraryItem(file: Attachment, note: string) {
    const item: LibraryItem = { ...file, id: newId('l'), note: note.trim(), createdAt: Date.now() }
    return { item, changeId: this.write('library', item.id, item) }
  }

  updateLibraryItem(id: string, patch: Partial<Omit<LibraryItem, 'id' | 'createdAt'>>) {
    const before = this.libraryItem(id)
    if (!before) return null
    const item = { ...before, ...clean(patch) }
    return { item, changeId: this.write('library', id, item) }
  }

  removeLibraryItem(id: string) {
    return this.libraryItem(id) ? this.write('library', id, null) : null
  }

  tool(id: string) {
    return this.get<ShopTool>('tool', id)
  }

  memory(id: string) {
    return this.get<Memory>('memory', id)
  }

  // ------------------------------------------------------------ writes (each one logged)

  addItem(fields: ItemPatch & { name: string; kind: string; tier: Tier }) {
    const item: ShopItem = { category: 'Other', ...clean(fields), id: newId('h'), updatedAt: Date.now() } as ShopItem
    if (item.qty !== undefined && item.full === undefined) item.full = item.qty
    return { item, changeId: this.write('item', item.id, item) }
  }

  updateItem(id: string, patch: ItemPatch & { qtyDelta?: number }) {
    const before = this.item(id)
    if (!before) return null
    const { qtyDelta, ...rest } = patch
    const item: ShopItem = { ...before, ...clean(rest), updatedAt: Date.now() }
    if (qtyDelta !== undefined) item.qty = Math.max(0, (item.qty ?? 0) + qtyDelta)
    // A restock above the old pack size becomes the new full mark.
    if (item.qty !== undefined && (item.full === undefined || item.qty > item.full)) item.full = item.qty
    return { item, changeId: this.write('item', id, item) }
  }

  removeItem(id: string) {
    return this.item(id) ? this.write('item', id, null) : null
  }

  upsertTool(id: string | undefined, patch: ToolPatch) {
    const before = id ? this.tool(id) : null
    if (id && !before) return null
    const tool: ShopTool = { kind: 'hand', can: '', have: true, ...before, ...clean(patch), id: before?.id ?? newId('t'), updatedAt: Date.now() } as ShopTool
    return { tool, changeId: this.write('tool', tool.id, tool) }
  }

  removeTool(id: string) {
    return this.tool(id) ? this.write('tool', id, null) : null
  }

  addMemory(text: string, scope: string, scopeName: string | undefined, source: string) {
    const memory: Memory = { id: newId('m'), text, scope, scopeName, source, createdAt: Date.now() }
    return { memory, changeId: this.write('memory', memory.id, memory) }
  }

  editMemory(id: string, text: string) {
    const before = this.memory(id)
    if (!before) return null
    return this.write('memory', id, { ...before, text })
  }

  removeMemory(id: string) {
    return this.memory(id) ? this.write('memory', id, null) : null
  }

  /** Puts the target back the way it was before the change; `redo` re-applies it. */
  undo(changeId: string, redo = false) {
    const c = this.sql.exec<{ kind: Kind; target: string; before: string | null; after: string | null; undone: number }>('SELECT * FROM changes WHERE id = ?', changeId).toArray()[0]
    if (!c || Boolean(c.undone) === !redo) return false
    this.put(c.kind, c.target, redo ? c.after : c.before)
    this.sql.exec('UPDATE changes SET undone = ? WHERE id = ?', redo ? 0 : 1, changeId)
    return true
  }

  // ------------------------------------------------------------ prompt context

  /** What the AI should know every run: memory, stock and tools, compact. */
  context(projectId?: string, projectName?: string) {
    const memories = this.memories(projectId)
    const items = this.items()
    const tools = this.tools()
    const lines: string[] = []
    lines.push(
      memories.length
        ? `Memory (what you know about this person; ids in brackets for forget):\n${memories.map((m) => `- [${m.id}]${m.scope === 'everywhere' ? '' : ` (${projectName ?? 'this project'} only)`} ${m.text}`).join('\n')}`
        : 'Memory: nothing saved yet.',
    )
    if (!items.length) lines.push('Shop hardware: nothing listed yet.')
    else if (items.length > 120) lines.push(`Shop hardware: ${items.length} items; use search_shop to find what fits.`)
    else lines.push(`Shop hardware (id · size kind · tier · qty · where/price):\n${items.map(itemLine).join('\n')}`)
    const have = tools.filter((t) => t.have)
    const lack = tools.filter((t) => !t.have)
    lines.push(
      tools.length
        ? `Tools they have: ${have.map((t) => `${t.name}${t.can ? ` (${t.can})` : ''}`).join('; ') || 'none listed'}.${lack.length ? ` They do NOT have: ${lack.map((t) => t.name).join(', ')}.` : ''}`
        : 'Tools: none listed yet; ask before planning anything beyond basic hand tools and a 3D printer.',
    )
    const files = this.library().length
    lines.push(files ? `Library: ${files} files (photos of their space, experiment data, references). Use search_library when where things go, sizes of rooms or past results matter.` : 'Library: empty.')
    return lines.join('\n\n')
  }

  // ------------------------------------------------------------ storage

  private all<T>(kind: Kind): T[] {
    return this.sql.exec<{ doc: string }>(`SELECT doc FROM ${TABLE[kind]}`).toArray().map((r) => JSON.parse(r.doc))
  }

  private get<T>(kind: Kind, id: string): T | null {
    const row = this.sql.exec<{ doc: string }>(`SELECT doc FROM ${TABLE[kind]} WHERE id = ?`, id).toArray()[0]
    return row ? JSON.parse(row.doc) : null
  }

  private write(kind: Kind, id: string, doc: object | null) {
    const before = this.sql.exec<{ doc: string }>(`SELECT doc FROM ${TABLE[kind]} WHERE id = ?`, id).toArray()[0]?.doc ?? null
    const after = doc ? JSON.stringify(doc) : null
    this.put(kind, id, after)
    const changeId = newId('c')
    this.sql.exec('INSERT INTO changes VALUES (?, ?, ?, ?, ?, 0, ?)', changeId, kind, id, before, after, Date.now())
    return changeId
  }

  private put(kind: Kind, id: string, doc: string | null) {
    if (doc) this.sql.exec(`INSERT OR REPLACE INTO ${TABLE[kind]} VALUES (?, ?)`, id, doc)
    else this.sql.exec(`DELETE FROM ${TABLE[kind]} WHERE id = ?`, id)
  }
}

export function itemLine(i: ShopItem) {
  const qty = i.unit === 'kit' ? 'kit' : i.qty === undefined ? 'qty unknown' : i.qty === 0 ? 'OUT' : `${i.qty}${i.full && i.qty / i.full < 0.2 ? ' (low)' : ''}`
  const where = i.tier === 'on-hand' ? (i.bin ? `bin ${i.bin}` : '') : (i.price ?? '')
  return `- [${i.id}] ${i.name} ${i.kind}${i.detail ? ` (${i.detail})` : ''} · ${i.tier} · ${qty}${where ? ` · ${where}` : ''}`
}

const newId = (prefix: string) => `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`

// Drop undefined and null fields so a patch never erases what it didn't mention.
function clean<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>
}
