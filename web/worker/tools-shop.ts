// Shop and memory tools, shared by the design agent (Project) and the shop
// agent (Account). Both reach the same store: Project through RPC to the
// user's Account object, Account directly.

import { z } from 'zod'
import type { Attachment, ChangeNote, LibraryItem, Memory, ShopItem, ShopTool } from '../shared/protocol'
import type { Env } from './env'
import { clock, imageKey, kind as kindOfFile, kindOf, MODEL_STEP, officeText, readText, sizeLabel, toBase64 } from './files'
import { geometryFetch } from './geometry'
import type { Block, ToolResult, ToolSpec } from './llm'
import type { ItemPatch, ToolPatch } from './shop'
import { itemLine } from './shop'

type Maybe<T> = T | Promise<T>

/** What the tools need from the store; the Account object implements it. */
export interface ShopApi {
  items(): Maybe<ShopItem[]>
  tools(): Maybe<ShopTool[]>
  memory(id: string): Maybe<Memory | null>
  addItem(fields: ItemPatch & { name: string; kind: string; tier: ShopItem['tier'] }): Maybe<{ item: ShopItem; changeId: string }>
  updateItem(id: string, patch: ItemPatch & { qtyDelta?: number }): Maybe<{ item: ShopItem; changeId: string } | null>
  removeItem(id: string): Maybe<string | null>
  upsertTool(id: string | undefined, patch: ToolPatch): Maybe<{ tool: ShopTool; changeId: string } | null>
  removeTool(id: string): Maybe<string | null>
  addMemory(text: string, scope: string, scopeName: string | undefined, source: string): Maybe<{ memory: Memory; changeId: string }>
  removeMemory(id: string): Maybe<string | null>
  libraryItems(): Maybe<LibraryItem[]>
  addLibraryItem(file: Attachment, note: string): Maybe<{ item: LibraryItem; changeId: string }>
}

export type ShopCtx = {
  api: ShopApi
  env: Env
  uid: string
  /** Images on the message being answered, in order (attachment 1, 2, …). */
  attachments: Attachment[]
  /** Files sent in this chat lately, newest first: run_python's working directory. */
  files?: Attachment[]
  projectId?: string
  projectName?: string
  /** In a project, a STEP from the Library becomes a part; returns what happened. */
  importStep?: (name: string, data: Uint8Array) => Promise<string>
  vision?: boolean
}

export type ShopToolOutcome = { result: ToolResult; detail: string; ok: boolean; notes?: ChangeNote[] }

const TIER = { type: 'string', enum: ['on-hand', 'prime', 'order'], description: 'on-hand: in the shop now. prime: arrives next day from Amazon Prime. order: anything else.' }
const ITEM_PROPS = {
  name: { type: 'string', description: 'The size as people say it: "M3 × 8", "608ZZ", "2020", "6 × 3".' },
  kind: { type: 'string', description: 'What it is: "Socket head cap screw", "Heat-set insert", "Bearing".' },
  category: { type: 'string', description: 'Group: Fasteners, Inserts and bearings, Magnets and stock, Electronics, Other.' },
  detail: { type: 'string', description: 'Standard, material or finish: "ISO 4762 · 12.9 black oxide".' },
  qty: { type: 'number', description: 'Count on hand, when known (e.g. a listing says 100 pcs). Omit when unknown.' },
  unit: { type: 'string', description: '"kit" for assortments; otherwise omit.' },
  bin: { type: 'string', description: 'Where it lives in the shop: "A3", "drawer B1".' },
  tier: TIER,
  price: { type: 'string', description: 'For prime/order: "$8.99 / 100", "Misumi $14 · 5 days".' },
  link: { type: 'string', description: 'Product link, e.g. the Amazon URL.' },
  notes: { type: 'string' },
}

export const SHOP_TOOLS: ToolSpec[] = [
  {
    name: 'search_shop',
    description: 'Search the hardware list and tools. Use it before choosing screws, inserts, bearings or other bought parts, and before changing an item you need the id of.',
    schema: { type: 'object', properties: { query: { type: 'string', description: 'Words to match, e.g. "M3 screw", "bearing 8 mm". Empty lists everything.' } }, additionalProperties: false },
  },
  {
    name: 'add_shop_items',
    description:
      'Add hardware to the shop: one entry per distinct size, as many as the person showed you (a photo of a kit, an order screenshot, a whole spreadsheet) in ONE call, up to 200. Search first so you update instead of duplicating. The person gets one note with one undo for the batch.',
    schema: {
      type: 'object',
      properties: { items: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: ITEM_PROPS, required: ['name', 'kind', 'category', 'tier'], additionalProperties: false } } },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_shop_items',
    description: 'Change items: quantity used or restocked (qty_delta), bin, tier, price, link. Use when the person says they used some, ran out, moved or reordered things. Batch every change into one call.',
    schema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, ...ITEM_PROPS, qty_delta: { type: 'number', description: 'Add or subtract from the count, e.g. -12 after a build.' } },
            required: ['id'],
            additionalProperties: false,
          },
        },
      },
      required: ['updates'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_shop_items',
    description: 'Remove items the person no longer has and will not reorder, all in one call. For "ran out" set qty 0 with update_shop_items instead.',
    schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 500 } }, required: ['ids'], additionalProperties: false },
  },
  {
    name: 'set_item_picture',
    description:
      "Give an item a picture. Use exactly one source: an attachment on the person's message (with a crop box around just this item when the image shows more), an image URL from read_link, or a build123d script that renders standard hardware (bd_warehouse fasteners and bearings) when there's no photo.",
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        attachment: { type: 'integer', minimum: 1, description: 'Which image, 1-based, on the newest message that had images.' },
        box: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: 'Crop [x, y, width, height] in pixels of that image.' },
        image_url: { type: 'string' },
        render_source: { type: 'string', description: 'build123d script assigning the item to `result`, e.g. SocketHeadCapScrew("M3-0.5", 8, simple=True).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'upsert_tools',
    description:
      'Add or change tools, machines or outside services, all in one call. Set have=false for tools the person says they do NOT have, so you never plan work that needs them. Pass id to change an existing one; a tool with the same name is updated.',
    schema: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string', description: '"Bambu X1C", "Drill press", "SendCutSend".' },
              kind: { type: 'string', enum: ['machine', 'hand', 'service'] },
              can: { type: 'string', description: 'The one capability that matters: "256 mm³ · PLA PETG", "13 mm chuck", "M3–M6", "laser-cut sheet · 5 days".' },
              have: { type: 'boolean' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['tools'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_tool',
    description: 'Remove a tool entry entirely (rare; prefer upsert_tools with have=false).',
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'read_link',
    description: "Read a product page (Amazon or another store): title, price, bullet points and the main image URL. Use it when the person pastes a link. If it can't be read, ask for a screenshot.",
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  },
  {
    name: 'run_python',
    description:
      "Run Python 3.12 in a sandbox with no internet, to read, clean or crunch files: spreadsheets (any format), CSVs, logs, experiment data, Word or PowerPoint files, or to compute and plot. Installed: pandas, numpy, openpyxl, xlrd, odfpy, numbers-parser, python-docx, python-pptx, matplotlib, pillow. The working directory holds the files sent in this chat lately (up to 20, newest first) under their own names; add Library files by id with `library`. print() what you need (output is cut at 20 KB). Save charts and result files into out/ (plt.savefig('out/current.png'), df.to_csv('out/clean.csv')): pictures come back for you to see, and each out/ file gets a download link you can give the person as a markdown link. Files live only for this run.",
    schema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        library: { type: 'array', items: { type: 'string' }, description: 'Library ids whose files to put in the working directory.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_library',
    description:
      "Search the person's Library: photos of their office, lab and workshop, experiment photos and data, drawings and other reference files. Use it when the space things must fit in, sizes of rooms or doors, or past test results matter. Returns ids, their notes and a description of each file.",
    schema: { type: 'object', properties: { query: { type: 'string', description: 'Words to match, e.g. "door", "office", "motor test current". Empty lists the newest.' } }, additionalProperties: false },
  },
  {
    name: 'open_library_item',
    description: 'Look at one Library file: a photo or PDF you can see, a video as six timed frames, a text, CSV, spreadsheet or document file as text. In a project, a STEP file is imported as a part.',
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'save_to_library',
    description: "Save an attachment from the person's message to their Library, when they ask or when it's clearly reference material (a photo of their space, test data). Not for shop stock.",
    schema: {
      type: 'object',
      properties: {
        attachment: { type: 'integer', minimum: 1, description: 'Which attachment, 1-based, on the newest message that had attachments.' },
        note: { type: 'string', description: "A short note in the person's words, if they gave one." },
      },
      required: ['attachment'],
      additionalProperties: false,
    },
  },
  {
    name: 'remember',
    description:
      'Save a durable preference or fact about how the person works (process, printer, materials, tolerances, units, hardware preferences, budget rules). Not one-off details of the current design, and not tools or stock (those go in the shop). The person sees a note with an undo.',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One plain sentence, e.g. "Prints in PETG; press fits get 0.2 mm clearance."' },
        scope: { type: 'string', enum: ['everywhere', 'project'], description: 'project: only for the current project.' },
        told: { type: 'boolean', description: 'true when the person asked you to remember it.' },
      },
      required: ['text', 'scope'],
      additionalProperties: false,
    },
  },
  {
    name: 'forget',
    description: 'Delete a memory that turned out wrong or that the person asked you to forget.',
    schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
  },
]

export const SHOP_TOOL_NAMES = new Set(SHOP_TOOLS.map((t) => t.name))

const Num = z.number().finite()
const Item = z.object({
  name: z.string().min(1).max(60),
  kind: z.string().min(1).max(80),
  category: z.string().max(40).optional(),
  detail: z.string().max(120).optional(),
  qty: Num.min(0).optional(),
  unit: z.string().max(20).optional(),
  bin: z.string().max(40).optional(),
  tier: z.enum(['on-hand', 'prime', 'order']),
  price: z.string().max(60).optional(),
  link: z.string().max(500).optional(),
  notes: z.string().max(300).optional(),
})
const Update = Item.partial().extend({ id: z.string(), qty_delta: Num.optional() })
const AddItems = z.object({ items: z.array(Item).min(1).max(200) })
const UpdateItems = z.object({ updates: z.array(Update).min(1).max(200) })
const RemoveItems = z.object({ ids: z.array(z.string()).min(1).max(500) })
const Python = z.object({ code: z.string().min(1).max(100_000), library: z.array(z.string()).max(20).optional() })
const Picture = z.object({
  id: z.string(),
  attachment: z.number().int().min(1).optional(),
  box: z.array(Num).length(4).optional(),
  image_url: z.string().url().optional(),
  render_source: z.string().optional(),
})
const Tool = z.object({ id: z.string().optional(), name: z.string().min(1).max(60), kind: z.enum(['machine', 'hand', 'service']).optional(), can: z.string().max(120).optional(), have: z.boolean().optional() })
const UpsertTools = z.object({ tools: z.array(Tool).min(1).max(100) })
const Remember = z.object({ text: z.string().min(3).max(400), scope: z.enum(['everywhere', 'project']), told: z.boolean().optional() })
const Id = z.object({ id: z.string() })
const Query = z.object({ query: z.string().optional() })
const Link = z.object({ url: z.string().url() })
const SaveFile = z.object({ attachment: z.number().int().min(1), note: z.string().max(300).optional() })

/** "M3 × 8 socket head cap screw, 608ZZ bearing, … +12" */
const names = (items: ShopItem[]) => `${items.slice(0, 3).map((i) => `${i.name} ${i.kind.toLowerCase()}`).join(', ')}${items.length > 3 ? ` +${items.length - 3}` : ''}`

function libraryLine(l: LibraryItem) {
  const when = new Date(l.createdAt).toISOString().slice(0, 10)
  const what = l.kind === 'image' || !l.kind ? `image ${l.width}×${l.height}` : `${l.kind} "${l.name}"`
  return `- [${l.id}] ${what}, ${when}${l.note ? ` · note: ${l.note}` : ''}${l.description ? ` · ${l.description}` : ''}`
}

export async function runShopTool(name: string, input: unknown, ctx: ShopCtx, callId: string): Promise<ShopToolOutcome> {
  const ok = (text: string, detail: string, notes?: ChangeNote[]): ShopToolOutcome => ({ result: { id: callId, content: [{ type: 'text', text }] }, detail, ok: true, notes })
  const fail = (text: string, detail: string): ShopToolOutcome => ({ result: { id: callId, isError: true, content: [{ type: 'text', text }] }, detail, ok: false })
  const parse = <T>(schema: z.ZodType<T>) => {
    const r = schema.safeParse(input)
    return r.success ? r.data : (fail(JSON.stringify({ INVALID_INPUT: input, problems: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }), 'invalid input') as never)
  }
  const bad = (r: unknown): r is ShopToolOutcome => typeof r === 'object' && r !== null && 'result' in r && 'ok' in r
  const shop = (text: string, changeId: string): ChangeNote => ({ kind: 'shop', text, changeId })

  switch (name) {
    case 'search_shop': {
      const q = parse(Query)
      if (bad(q)) return q
      const words = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const match = (s: string) => words.every((w) => s.toLowerCase().includes(w))
      const items = (await ctx.api.items()).filter((i) => !words.length || match(`${i.name} ${i.kind} ${i.detail ?? ''} ${i.category}`))
      const tools = (await ctx.api.tools()).filter((t) => !words.length || match(`${t.name} ${t.can}`))
      const text = [
        items.length ? `Hardware:\n${items.map(itemLine).join('\n')}` : 'Hardware: no match.',
        tools.length ? `Tools:\n${tools.map((t) => `- [${t.id}] ${t.name} (${t.kind}${t.can ? `, ${t.can}` : ''}) · ${t.have ? 'have' : 'DO NOT have'}`).join('\n')}` : 'Tools: no match.',
      ].join('\n\n')
      return ok(text, `${q.query ? `"${q.query}" · ` : ''}${items.length} items, ${tools.length} tools`)
    }
    case 'add_shop_items': {
      const f = parse(AddItems)
      if (bad(f)) return f
      const added: ShopItem[] = []
      const ids: string[] = []
      for (const fields of f.items) {
        const { item, changeId } = await ctx.api.addItem(fields)
        added.push(item)
        ids.push(changeId)
      }
      const one = added.length === 1 ? added[0] : null
      const text = one ? `Added ${one.name} ${one.kind.toLowerCase()}${one.qty !== undefined ? ` · ${one.qty}` : ''}${one.bin ? ` · bin ${one.bin}` : ''}` : `Added ${added.length} items · ${names(added)}`
      return ok(`Added:\n${added.map(itemLine).join('\n')}`, one ? `${one.name} ${one.kind.toLowerCase()}` : `${added.length} items`, [shop(text, ids.join(','))])
    }
    case 'update_shop_items': {
      const f = parse(UpdateItems)
      if (bad(f)) return f
      const lines: string[] = []
      const missing: string[] = []
      const changed: string[] = []
      const ids: string[] = []
      for (const { id, qty_delta, ...patch } of f.updates) {
        const r = await ctx.api.updateItem(id, { ...patch, qtyDelta: qty_delta })
        if (!r) {
          missing.push(id)
          continue
        }
        const what = qty_delta !== undefined ? `${qty_delta > 0 ? '+' : ''}${qty_delta} → ${r.item.qty}` : r.item.qty === 0 ? 'out' : Object.keys(patch).join(', ')
        lines.push(`Updated ${itemLine(r.item)}`)
        changed.push(`${r.item.name} ${r.item.kind.toLowerCase()} · ${what}`)
        ids.push(r.changeId)
      }
      const note = changed.length === 1 ? changed[0] : `Updated ${changed.length} items · ${changed.slice(0, 3).join('; ')}${changed.length > 3 ? ` +${changed.length - 3}` : ''}`
      const text = [...lines, ...(missing.length ? [`No item ${missing.join(', ')}. Use search_shop for ids.`] : [])].join('\n')
      if (!ids.length) return fail(text, 'not found')
      return ok(text, changed.length === 1 ? changed[0] : `${changed.length} items`, [shop(note, ids.join(','))])
    }
    case 'remove_shop_items': {
      const f = parse(RemoveItems)
      if (bad(f)) return f
      const all = await ctx.api.items()
      const gone: ShopItem[] = []
      const ids: string[] = []
      for (const id of f.ids) {
        const before = all.find((i) => i.id === id)
        const changeId = before && (await ctx.api.removeItem(id))
        if (before && changeId) {
          gone.push(before)
          ids.push(changeId)
        }
      }
      const missing = f.ids.filter((id) => !gone.some((g) => g.id === id))
      if (!gone.length) return fail(`No item ${missing.join(', ')}.`, 'not found')
      const text = gone.length === 1 ? `Removed ${gone[0].name} ${gone[0].kind.toLowerCase()}` : `Removed ${gone.length} items · ${names(gone)}`
      return ok(`${text}.${missing.length ? ` Not found: ${missing.join(', ')}.` : ''}`, gone.length === 1 ? `${gone[0].name} removed` : `${gone.length} removed`, [shop(text, ids.join(','))])
    }
    case 'set_item_picture': {
      const f = parse(Picture)
      if (bad(f)) return f
      const item = (await ctx.api.items()).find((i) => i.id === f.id)
      if (!item) return fail(`No item ${f.id}.`, `${f.id} · not found`)
      const sources = [f.attachment, f.image_url, f.render_source].filter((x) => x !== undefined).length
      if (sources !== 1) return fail('Give exactly one of attachment, image_url or render_source.', 'needs one source')
      let png: string
      try {
        png = await pictureFrom(f, ctx)
      } catch (err) {
        return fail(`Couldn't make the picture: ${(err as Error).message}`, `${item.name} · picture failed`)
      }
      const key = `users/${ctx.uid}/shop/${item.id}-${crypto.randomUUID().slice(0, 8)}.png`
      await ctx.env.FILES.put(key, b64bytes(png), { httpMetadata: { contentType: 'image/png' } })
      const r = await ctx.api.updateItem(item.id, { image: `/api/files/${key}` })
      return ok(`Picture set for ${item.name} ${item.kind}.`, `${item.name} · picture`, r ? [shop(`Picture for ${item.name} ${item.kind.toLowerCase()}`, r.changeId)] : [])
    }
    case 'upsert_tools': {
      const f = parse(UpsertTools)
      if (bad(f)) return f
      const all = await ctx.api.tools()
      const saved: ShopTool[] = []
      const ids: string[] = []
      for (const t of f.tools) {
        const existing = t.id ? null : all.find((x) => x.name.toLowerCase() === t.name.toLowerCase())
        const r = await ctx.api.upsertTool(t.id ?? existing?.id, { name: t.name, kind: t.kind, can: t.can, have: t.have })
        if (r) {
          saved.push(r.tool)
          ids.push(r.changeId)
        }
      }
      if (!saved.length) return fail('No such tool ids.', 'not found')
      const t = saved[0]
      const text =
        saved.length === 1 ? `Tools · ${t.name}${t.can ? `, ${t.can}` : ''}${t.have ? '' : ' · not in the shop'}` : `Tools · ${saved.length} saved: ${saved.slice(0, 3).map((x) => x.name).join(', ')}${saved.length > 3 ? ` +${saved.length - 3}` : ''}`
      return ok(saved.map((x) => `Saved tool [${x.id}] ${x.name} (${x.kind}, ${x.can}) · ${x.have ? 'have' : 'do not have'}`).join('\n'), saved.length === 1 ? `${t.name} · ${t.have ? 'have' : "don't have"}` : `${saved.length} tools`, [shop(text, ids.join(','))])
    }
    case 'run_python':
      return runPython(input, ctx, callId)
    case 'remove_tool': {
      const f = parse(Id)
      if (bad(f)) return f
      const before = (await ctx.api.tools()).find((t) => t.id === f.id)
      const changeId = await ctx.api.removeTool(f.id)
      if (!changeId || !before) return fail(`No tool ${f.id}.`, `${f.id} · not found`)
      return ok(`Removed ${before.name}.`, `${before.name} removed`, [shop(`Removed tool ${before.name}`, changeId)])
    }
    case 'read_link': {
      const f = parse(Link)
      if (bad(f)) return f
      try {
        const page = await readProduct(f.url)
        return ok(page.text, page.title.slice(0, 60))
      } catch (err) {
        return fail(`Couldn't read the page (${(err as Error).message}). Ask the person for a screenshot of it instead.`, 'page blocked')
      }
    }
    case 'search_library': {
      const q = parse(Query)
      if (bad(q)) return q
      const words = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      const all = await ctx.api.libraryItems()
      const hits = all.filter((l) => words.every((w) => `${l.note} ${l.description ?? ''} ${l.name ?? ''}`.toLowerCase().includes(w))).slice(0, 30)
      const text = hits.length ? hits.map(libraryLine).join('\n') : `No match${q.query ? ` for "${q.query}"` : ''} among ${all.length} files.`
      return ok(text, `${q.query ? `"${q.query}" · ` : ''}${hits.length} of ${all.length}`)
    }
    case 'open_library_item': {
      const f = parse(Id)
      if (bad(f)) return f
      const item = (await ctx.api.libraryItems()).find((l) => l.id === f.id)
      if (!item) return fail(`No library item ${f.id}. Use search_library.`, `${f.id} · not found`)
      const head = { type: 'text' as const, text: libraryLine(item) }
      const kind = kindOfFile(item)
      const label = item.note || item.name || item.id
      if (kind === 'image') {
        const key = imageKey(item)
        if (!key) return ok(`${head.text}\n(This photo has no preview the model can see.)`, label)
        const type = (await ctx.env.FILES.head(key))?.httpMetadata?.contentType ?? 'image/jpeg'
        return { ...ok('', label), result: { id: callId, content: [head, { type: 'image', mediaType: type, key }] } }
      }
      if (kind === 'video') {
        if (!item.framesKey) return ok(`${head.text}\n(${item.processing ? 'Still being processed; try again in a minute.' : item.problem ?? 'No frames to look at.'})`, label)
        const note = { type: 'text' as const, text: `${head.text}\nSix frames across the ${clock(item.duration)} video, each marked with its time:` }
        return { ...ok('', label), result: { id: callId, content: [note, { type: 'image', mediaType: 'image/jpeg', key: item.framesKey }] } }
      }
      if (kind === 'sheet' || kind === 'doc') return ok(`${head.text}\n--- ${item.name} ---\n${await officeText(ctx.env, item.key)}`, label)
      if (kind === 'file') return ok(`${head.text}\n(${sizeLabel(item.size)}; not a format you can read directly. Try run_python with library: ["${item.id}"].)`, label)
      if (kind === 'pdf') {
        if (!ctx.vision) return ok(`${head.text}\n(This model can't read PDFs.)`, label)
        if ((item.size ?? 0) > 25 * 1024 ** 2) return ok(`${head.text}\n(Too large to read, ${sizeLabel(item.size)}. Ask for the pages that matter.)`, label)
        return { ...ok('', label), result: { id: callId, content: [head, { type: 'document', mediaType: 'application/pdf', name: item.name ?? 'file.pdf', key: item.key }] } }
      }
      if (kind === 'step') {
        if (!ctx.importStep) return ok(`${head.text}\nSTEP models become parts inside a project chat.`, label)
        if ((item.size ?? 0) > MODEL_STEP) return ok(`${head.text}\n(Too large to import, ${sizeLabel(item.size)}; up to 45 MB.)`, label)
        const obj = await ctx.env.FILES.get(item.key)
        if (!obj) return fail('The file is no longer stored.', `${label} · missing`)
        return ok(`${head.text}\n${await ctx.importStep(item.name ?? 'part.step', new Uint8Array(await obj.arrayBuffer()))}`, `${label} → imported`)
      }
      return ok(`${head.text}\n--- ${item.name} ---\n${await readText(ctx.env, item.key)}`, label)
    }
    case 'save_to_library': {
      const f = parse(SaveFile)
      if (bad(f)) return f
      const a = ctx.attachments[f.attachment - 1]
      if (!a) return fail(`There is no attachment ${f.attachment}; the message has ${ctx.attachments.length}.`, 'no such attachment')
      const { item, changeId } = await ctx.api.addLibraryItem(a, f.note ?? '')
      const what = f.note || a.name || 'image'
      return ok(`Saved to the Library as [${item.id}].`, what.slice(0, 60), [{ kind: 'library', text: what, changeId }])
    }
    case 'remember': {
      const f = parse(Remember)
      if (bad(f)) return f
      const project = f.scope === 'project' && ctx.projectId
      const source = f.told ? 'you told it' : `learned in ${ctx.projectName ?? 'the shop chat'}`
      const { memory, changeId } = await ctx.api.addMemory(f.text, project ? ctx.projectId! : 'everywhere', project ? ctx.projectName : undefined, source)
      return ok(`Saved memory [${memory.id}].`, f.text.slice(0, 60), [{ kind: 'memory', text: f.text, changeId }])
    }
    case 'forget': {
      const f = parse(Id)
      if (bad(f)) return f
      const before = await ctx.api.memory(f.id)
      const changeId = await ctx.api.removeMemory(f.id)
      if (!changeId || !before) return fail(`No memory ${f.id}.`, `${f.id} · not found`)
      return ok(`Forgot: ${before.text}`, 'forgot', [{ kind: 'memory', text: `Forgot: ${before.text}`, changeId }])
    }
  }
  return fail(`Unknown tool ${name}.`, 'unknown tool')
}

async function pictureFrom(f: z.infer<typeof Picture>, ctx: ShopCtx): Promise<string> {
  if (f.render_source) {
    const res = await geometryFetch(ctx.env, '/build', { method: 'POST', body: JSON.stringify({ source: f.render_source, timeout: 60 }) })
    const out = (await res.json()) as { ok: boolean; thumb?: string; error?: { type: string; message: string } }
    if (!out.ok || !out.thumb) throw new Error(out.error ? `${out.error.type}: ${out.error.message}` : 'render failed')
    return out.thumb
  }
  let image: string
  if (f.attachment !== undefined) {
    const a = ctx.attachments[f.attachment - 1]
    if (!a) throw new Error(`there is no attachment ${f.attachment}; the message has ${ctx.attachments.length}`)
    if (a.kind && a.kind !== 'image') throw new Error(`attachment ${f.attachment} is a ${a.kind.toUpperCase()} file, not an image`)
    // The crop box is in the preview's pixels, which is what the model saw.
    const key = imageKey(a)
    if (!key) throw new Error(`attachment ${f.attachment} has no preview to crop from`)
    const obj = await ctx.env.FILES.get(key)
    if (!obj) throw new Error('the attachment is gone')
    image = toB64(new Uint8Array(await obj.arrayBuffer()))
  } else {
    const res = await fetch(f.image_url!, { headers: { 'user-agent': BROWSER } })
    if (!res.ok) throw new Error(`image URL returned ${res.status}`)
    image = toB64(new Uint8Array(await res.arrayBuffer()))
  }
  const res = await geometryFetch(ctx.env, '/image/crop', { method: 'POST', body: JSON.stringify({ image, box: f.box ?? null, size: 512 }) })
  const out = (await res.json()) as { ok: boolean; png?: string; error?: string }
  if (!out.ok || !out.png) throw new Error(out.error ?? 'crop failed')
  return out.png
}

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

/** Title, price, bullets and main image from a product page. Amazon is the main target. */
async function readProduct(url: string) {
  const res = await fetch(url, { headers: { 'user-agent': BROWSER, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const html = await res.text()
  if (/captcha|robot check/i.test(html.slice(0, 20000)) && !/productTitle/.test(html)) throw new Error('the store asked for a captcha')
  const pick = (re: RegExp) => decode(html.match(re)?.[1]?.trim() ?? '')
  const title = pick(/id="productTitle"[^>]*>([^<]+)</) || pick(/<meta property="og:title" content="([^"]+)"/) || pick(/<title>([^<]+)</)
  if (!title) throw new Error('no product title on the page')
  const whole = html.match(/a-price-whole">([\d,]+)/)?.[1]
  const fraction = html.match(/a-price-fraction">(\d+)/)?.[1]
  const price = whole ? `$${whole}${fraction ? `.${fraction}` : ''}` : pick(/<meta property="product:price:amount" content="([^"]+)"/)
  const bullets = [...html.matchAll(/<li[^>]*class="a-spacing-mini"[^>]*>\s*<span class="a-list-item">\s*([^<]{8,300})/g)].slice(0, 6).map((m) => decode(m[1].trim()))
  const image = html.match(/"hiRes":"(https:[^"]+)"/)?.[1] ?? html.match(/data-old-hires="(https:[^"]+)"/)?.[1] ?? html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? ''
  const prime = /isPrime|prime-logo|a-icon-prime/i.test(html)
  const text = [`Title: ${title}`, price && `Price: ${price}`, `Prime badge on page: ${prime ? 'yes' : 'not found'}`, bullets.length ? `Bullets:\n- ${bullets.join('\n- ')}` : '', image && `Main image: ${image}`, `URL: ${url}`]
    .filter(Boolean)
    .join('\n')
  return { title, text }
}

function decode(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ')
}

function toB64(data: Uint8Array) {
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(bin)
}

function b64bytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Up to this much of the person's files go into one Python run (the request is base64 JSON).
const PYTHON_FILES = 40 * 1024 ** 2
const SEE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** Runs AI-written Python in the geometry container over the person's files; out/ files come back as downloads. */
async function runPython(input: unknown, ctx: ShopCtx, callId: string): Promise<ShopToolOutcome> {
  const f = Python.safeParse(input)
  if (!f.success) return { result: { id: callId, isError: true, content: [{ type: 'text', text: f.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }] }, detail: 'invalid input', ok: false }
  const library = f.data.library?.length ? (await ctx.api.libraryItems()).filter((l) => f.data.library!.includes(l.id)) : []
  const files: Record<string, string> = {}
  const skipped: string[] = []
  let total = 0
  for (const a of [...library, ...(ctx.files ?? ctx.attachments)]) {
    let name = (a.name ?? a.key.split('/').pop() ?? 'file').replace(/[/\\]/g, '_')
    for (let n = 2; name in files; n++) name = name.replace(/(\.[^.]*)?$/, ` (${n})$1`)
    if (total + (a.size ?? 0) > PYTHON_FILES) {
      skipped.push(`${name} (${sizeLabel(a.size)})`)
      continue
    }
    const obj = await ctx.env.FILES.get(a.key)
    if (!obj) continue
    total += obj.size
    files[name] = toBase64(new Uint8Array(await obj.arrayBuffer()))
  }
  const res = await geometryFetch(ctx.env, '/python', { method: 'POST', body: JSON.stringify({ code: f.data.code, files, timeout: 120 }) })
  const out = (await res.json().catch(() => ({ ok: false, error: `sandbox error ${res.status}` }))) as { ok: boolean; stdout?: string; stderr?: string; error?: string; files?: Record<string, string> }
  const links: string[] = []
  const images: Block[] = []
  for (const [name, b64] of Object.entries(out.files ?? {})) {
    const k = kindOf(name, '')
    const key = `users/${ctx.uid}/uploads/${crypto.randomUUID()}.${k.ext}`
    const inline = k.kind === 'image' || k.kind === 'video'
    await ctx.env.FILES.put(key, b64bytes(b64), { httpMetadata: { contentType: k.type, ...(!inline && { contentDisposition: `attachment; filename="${name.replace(/["\\\r\n]/g, '')}"` }) } })
    links.push(`- out/${name}: /api/files/${key}`)
    if (SEE.has(k.ext) && images.length < 4) images.push({ type: 'image', mediaType: k.type, key })
  }
  const text = [
    out.ok ? 'Finished.' : `Failed: ${out.error ?? 'see stderr'}`,
    `Files in the working directory: ${Object.keys(files).join(', ') || 'none'}${skipped.length ? `. Too large for one run (40 MB in all), left out: ${skipped.join(', ')}` : ''}`,
    out.stdout ? `--- stdout ---\n${out.stdout}` : 'No output printed.',
    out.stderr ? `--- stderr ---\n${out.stderr}` : '',
    links.length ? `--- saved (give these links to the person as markdown links) ---\n${links.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const detail = `${out.ok ? 'ran' : 'failed'}${links.length ? ` · ${links.length} file${links.length > 1 ? 's' : ''}` : ''}`
  return { result: { id: callId, isError: !out.ok || undefined, content: [{ type: 'text', text }, ...images] }, detail, ok: out.ok }
}
