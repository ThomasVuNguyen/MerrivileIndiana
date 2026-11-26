// Merrivile as an MCP server (Streamable HTTP, JSON responses) at /api/mcp, so outside agents
// (Claude Code and others) can build, edit, measure and review parts with the same powers as the
// in-app AI. They sign in with the account's email and password in the Authorization header.

import { signedLink, signedUpload } from './auth'
import type { Directory, User } from './auth'
import { runComponentTool } from './components'
import type { ComponentToolApi } from './components'
import type { Env } from './env'
import { accountOf } from './env'
import { runInspect } from './inspect'
import type { Section, View } from './inspect'
import { blockForLog, Trace } from './langfuse'
import type { Block } from './llm'
import { SYSTEM, TOOLS } from './prompt'
import { ASSEMBLY_TOOLS, COMPONENT_TOOL_NAMES, COMPONENT_TOOLS } from './tools-assembly'
import { runShopTool, SHOP_TOOLS } from './tools-shop'
import type { ShopApi } from './tools-shop'

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MAX_IMPORT = 40 * 1024 * 1024

type Spec = { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> }
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
type Reply = { content: Content[]; isError?: boolean }

const INSTRUCTIONS = `Merrivile is a CAD app. Parts are build123d 0.13 Python scripts (OpenCASCADE B-rep) built on the server. The owner reviews them in a 3D viewer at https://merry.beenex.company; what you change shows there live, and in the project's "Outside agent (MCP)" chat.

# Workflow
- list_projects, then list_parts, then read_part before you edit a part. write_part creates or rewrites; edit_part makes exact string replacements. Every build returns metrics, warnings and a 4-view render: check the numbers first, then the picture. Fix what's wrong before calling a part done. A failed build saves nothing: a new part isn't created and an existing one stays at its last good version.
- Parts can build on each other with part("id") in their source. Changing a part marks the parts that use it out of date (build report, list_parts, read_part); rebuild each with edit_part edits: [] and check it still fits.
- inspect is the measuring tool. It runs Python in the same environment as part scripts: build123d pre-imported, and part("id") is that part's exact solid, rebuilt from its last good source (no mesh, no STEP round trip). print() measurements; assign \`report\` for structured results; assign \`result\` to get its full-precision metrics and a render from the views you pick. A list or {name: shape} dict draws each part in its own colour (parts keep their colour even when moved, e.g. Pos(0, 0, 5) * part("lid")), with a legend. For a section view pass section ({normal: "x" | "y" | "z" | [x, y, z], offset?, keep?}): the picture is cut exactly and the cut faces are hatched. Nothing is saved. Use it for distances, radii, angles, wall thickness, concentricity, clearance and interference between parts (a & b), placing parts relative to each other with Location/Pos/Rot, and tolerance stacks.
- Precision: millimetres, double precision throughout. Build reports are rounded (to 0.01 mm); inspect is not. OpenCASCADE's modelling tolerance is 1e-7 mm. Booleans and fillets can leave slivers: check is_valid and the solid count.
- High-accuracy work (optics): put every critical dimension in an UPPER_CASE parameter with its tolerance in a comment, derive the rest from them, then measure the built solid with inspect against the intended numbers (seat diameters, bore coaxiality, distances from datum faces to optical surfaces, tilt of mounting faces). Measure the solid; don't trust the script.
- Every picture from inspect and render_part also appears in the project's "Outside agent (MCP)" chat, where the person sees it, with your caption under it; the result includes a link (valid 1 h, no login) you can give them. Write a caption that says what they're looking at and what to notice.
- export_part gives a download link (valid 1 h, no login needed) for STEP, STL or the render. import_step brings in vendor models (a lens, mount or sensor STEP from a URL) as parts you can build around.
- The shop (hardware and tools), memory and Library belong to the owner. Search the shop before choosing hardware, size holes to the exact item, and follow memory as standing preferences.

${SYSTEM.slice(SYSTEM.indexOf('# Script rules'))}`

const PROJECT = { type: 'string', description: 'Project id, from list_projects.' }
const PART = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$', description: 'Part id, e.g. "lens-cell".' }
const PRESETS = ['iso', 'front', 'top', 'right', 'back', 'left', 'bottom', 'iso-back', 'iso-below']
const VIEWS = {
  type: 'array',
  maxItems: 6,
  description: `Views to render, up to 6: ${PRESETS.join(', ')}, or {name, dir: [x, y, z] (camera looks back along it), up?: [x, y, z]}. Default iso, front, top, right; [] for no picture.`,
  items: {
    anyOf: [
      { type: 'string', enum: PRESETS },
      {
        type: 'object',
        properties: { name: { type: 'string' }, dir: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }, up: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } },
        required: ['dir'],
        additionalProperties: false,
      },
    ],
  },
}
const SIZE = { type: 'integer', minimum: 200, maximum: 1000, description: 'Pixels per view (default 420).' }
const SECTION = {
  type: 'object',
  description:
    'Cut the picture with a plane and keep one side, to see inside (walls, bores, seats, fits between parts). The cut is exact (B-rep split) and cut faces are drawn darker and hatched. Without views, shows the cut face straight on and from an iso angle. Only the picture is cut; metrics are of the whole result.',
  properties: {
    normal: { anyOf: [{ type: 'string', enum: ['x', 'y', 'z'] }, { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }], description: 'The plane\'s normal: an axis or [x, y, z].' },
    offset: { type: 'number', description: 'Where the plane is, in mm along the normal from the origin (the plane n·p = offset; "z" with 5 cuts at Z = 5). Default: through the centre of the bounding box.' },
    keep: { type: 'string', enum: ['below', 'above'], description: 'Which side to keep: below (default) is the side the normal points away from.' },
  },
  required: ['normal'],
  additionalProperties: false,
}
const CAPTION = { type: 'string', maxLength: 500, description: "Shown under the picture in the project's chat: what the person is looking at and what to notice." }

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false })
const READ = { readOnlyHint: true }

/** One of the chat AI's tools, inside a project. */
function inProject(name: string, description?: string): Spec {
  const t = TOOLS.find((x) => x.name === name)!
  const s = t.schema as { properties: Record<string, unknown>; required: string[] }
  return { name, description: description ?? t.description, inputSchema: { ...s, properties: { project: PROJECT, ...s.properties }, required: ['project', ...s.required] } }
}

/** An assembly tool, inside a project. */
function assemblyTool(name: string): Spec {
  const t = ASSEMBLY_TOOLS.find((x) => x.name === name)!
  const s = t.schema as { properties: Record<string, unknown>; required?: string[] }
  const properties = name === 'render_assembly' ? { ...s.properties, section: SECTION, caption: CAPTION } : { ...s.properties, ...(s.properties.section ? { section: SECTION } : {}) }
  return {
    name,
    description: t.description,
    inputSchema: { ...s, properties: { project: PROJECT, ...properties }, required: ['project', ...(s.required ?? [])] },
    ...(['read_assembly', 'list_assemblies', 'render_assembly', 'check_assembly'].includes(name) && { annotations: READ }),
  }
}

const PROJECT_TOOLS: Spec[] = [
  { name: 'list_parts', description: 'Every part in a project: id, name, version, material, build status, bounding box, volume, mass, hardware, the parts it uses and whether it is out of date.', inputSchema: obj({ project: PROJECT }, ['project']), annotations: READ },
  {
    name: 'read_part',
    description: "A part's current build123d source, metrics, hardware and version list. With version, that version's source instead. Read a part before editing it.",
    inputSchema: obj({ project: PROJECT, part: PART, version: { type: 'integer', minimum: 1 } }, ['project', 'part']),
    annotations: READ,
  },
  inProject('write_part'),
  inProject('edit_part'),
  {
    name: 'restore_part_version',
    description: "Rebuild an earlier version's source as the part's newest version. Returns the build report.",
    inputSchema: obj({ project: PROJECT, part: PART, version: { type: 'integer', minimum: 1 } }, ['project', 'part', 'version']),
  },
  { name: 'delete_part', description: 'Delete a part and its version history from a project.', inputSchema: obj({ project: PROJECT, part: PART }, ['project', 'part']), annotations: { destructiveHint: true } },
  inProject('set_part_hardware'),
  {
    name: 'inspect',
    description:
      'Run build123d Python to measure and check geometry without saving anything. build123d is pre-imported and part("id") returns that part\'s exact solid (rebuilt from its last good source), as in part scripts. print() what you measure; assign `report` (any JSON value) for structured output; assign `result` to get its full-precision metrics and a render. `result` can be a shape, a list of shapes or {"name": shape}: each part is drawn in its own colour (also when moved, e.g. Pos(0, 0, 2) * part("glass")), other shapes and loose solids in distinct colours, with a legend naming them. section cuts the picture to show the inside. Examples: hole = part("lens-cell").faces().filter_by(GeomType.CYLINDER).sort_by(SortBy.RADIUS)[-1]; print(hole.radius, hole.center()). Interference: print((part("a") & Pos(0, 0, 12) * part("b")).volume). Assembly: result = {"board": part("pcb"), "glass": Pos(0, 0, 1.6) * part("glass")} with section {normal: "y"}. The picture is saved, shown to the person in the project\'s "Outside agent (MCP)" chat with your caption, and linked in the result. Without a project only plain build123d is available. Limits: 120 s by default (timeout up to 300), 3 GB of memory, no files or network.',
    inputSchema: obj({ project: PROJECT, code: { type: 'string' }, views: VIEWS, size: SIZE, section: SECTION, caption: CAPTION, timeout: { type: 'number', minimum: 1, maximum: 300 } }, ['code']),
    annotations: READ,
  },
  {
    name: 'render_part',
    description:
      "Look at a part. Without views, size or section: its stored 4-view sheet (iso, front, top, right). With them: fresh renders from any direction, up to 1000 px per view, in the part's colour; section cuts it to show the inside. The picture is shown to the person in the project's \"Outside agent (MCP)\" chat with your caption, and linked in the result.",
    inputSchema: obj({ project: PROJECT, part: PART, views: VIEWS, size: SIZE, section: SECTION, caption: CAPTION }, ['project', 'part']),
    annotations: READ,
  },
  {
    name: 'export_part',
    description: "A download link (valid 1 hour, works without login) to a part's STEP, STL, PNG render or viewer mesh, for the current or an earlier version. curl -o works directly.",
    inputSchema: obj({ project: PROJECT, part: PART, format: { type: 'string', enum: ['step', 'stl', 'png', 'mesh'] }, version: { type: 'integer', minimum: 1 } }, ['project', 'part', 'format']),
    annotations: READ,
  },
  {
    name: 'import_step',
    description:
      'Bring a STEP file in as a new part (up to 40 MB): from a URL (vendor CAD such as Thorlabs or Edmund, fetched by the server), as STEP text, or base64. The part\'s source reads it with import_step(asset("<id>.step")); build on it with edit_part, or import it into other parts\' sources the same way to fit around it.',
    inputSchema: obj(
      { project: PROJECT, name: { type: 'string', description: 'File name, e.g. "LA1050-A.step"; it names the part.' }, url: { type: 'string' }, step: { type: 'string', description: 'The STEP file as text.' }, base64: { type: 'string' } },
      ['project', 'name'],
    ),
  },
  ...ASSEMBLY_TOOLS.map((t) => assemblyTool(t.name)),
  {
    name: 'read_chats',
    description: "The project's chats with the in-app AI: without chat, the list; with a chat id, its latest messages (the person's requests, the AI's tool calls and answers). Useful to learn what the person asked for.",
    inputSchema: obj({ project: PROJECT, chat: { type: 'string' }, last: { type: 'integer', minimum: 1, maximum: 200 } }, ['project']),
    annotations: READ,
  },
]

const ACCOUNT_TOOLS: Spec[] = [
  { name: 'list_projects', description: 'Every project: id, name, part count, last change.', inputSchema: obj({}), annotations: READ },
  { name: 'create_project', description: 'Make a new, empty project. Returns its id.', inputSchema: obj({ name: { type: 'string', minLength: 1, maxLength: 80 } }, ['name']) },
  { name: 'rename_project', description: 'Rename a project.', inputSchema: obj({ project: PROJECT, name: { type: 'string', minLength: 1, maxLength: 80 } }, ['project', 'name']) },
  {
    name: 'delete_project',
    description: 'Delete a project with all its parts, versions, chats and files. Cannot be undone. confirm_name must be the project\'s exact name.',
    inputSchema: obj({ project: PROJECT, confirm_name: { type: 'string' } }, ['project', 'confirm_name']),
    annotations: { destructiveHint: true },
  },
  { name: 'list_memory', description: "The person's saved preferences (memory), with ids.", inputSchema: obj({}), annotations: READ },
  // Components are the account's, usable in every project.
  ...COMPONENT_TOOLS.map((t): Spec => {
    const s = t.schema as { properties: Record<string, unknown>; required?: string[] }
    const { attachment: _a, ...properties } = s.properties
    return { name: t.name, description: t.description, inputSchema: { ...s, properties }, ...(['list_components', 'read_component'].includes(t.name) && { annotations: READ }) }
  }),
  {
    name: 'start_upload',
    description:
      'A one-time link (valid 1 hour, up to 95 MB) to upload a STEP file from your machine as a new component: curl -sS -T "Board.step" "<link>" (PUT; POST with --data-binary @file works too). The upload is read right away (a 13 MB board takes about 30 s) and curl prints the new component id. Use it for files too big to send as base64.',
    inputSchema: obj(
      {
        file: { type: 'string', description: 'The file name, e.g. "Raspberry Pi Zero 2 W.STEP".' },
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$' },
        name: { type: 'string' },
        vendor: { type: 'string' },
        part_number: { type: 'string' },
        link: { type: 'string' },
        notes: { type: 'string' },
      },
      ['file'],
    ),
  },
]

// The chat AI's shop, memory and Library tools. Saving a message's attachment has no meaning here.
const SHOP_SPECS: Spec[] = SHOP_TOOLS.filter((t) => t.name !== 'save_to_library').map((t) => {
  const s = t.schema as { properties: Record<string, unknown>; required?: string[] }
  // A project memory needs to know the project.
  const inputSchema = t.name === 'remember' ? { ...s, properties: { ...s.properties, project: { ...PROJECT, description: 'For scope "project": which one.' } } } : s
  return { name: t.name, description: t.description, inputSchema, ...(['search_shop', 'search_library', 'open_library_item', 'read_link', 'run_python'].includes(t.name) && { annotations: READ }) }
})

const SPECS: Spec[] = [...ACCOUNT_TOOLS, ...PROJECT_TOOLS, ...SHOP_SPECS]
const PROJECT_TOOL_NAMES = new Set(PROJECT_TOOLS.map((t) => t.name))

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
const text = (t: string, isError = false): Reply => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })

function toContent(blocks: Block[]): Content[] {
  return blocks.flatMap((b): Content[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }]
    if (b.type === 'image' && b.data) return [{ type: 'image', data: b.data, mimeType: b.mediaType }]
    return []
  })
}

export async function handleMcp(req: Request, env: Env, ctx: ExecutionContext, user: User, directory: DurableObjectStub<Directory>): Promise<Response> {
  if (req.method !== 'POST') return new Response('POST JSON-RPC messages here; this server has no event stream.', { status: 405, headers: { allow: 'POST' } })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json(rpcError(null, -32700, 'Parse error'), { status: 400 })
  }
  const origin = new URL(req.url).origin
  const one = async (msg: { id?: unknown; method?: string; params?: Record<string, unknown> }) => {
    // Notifications (no id) get no answer.
    if (msg.id === undefined || msg.id === null) return null
    if (msg.method === 'initialize') {
      const asked = String(msg.params?.protocolVersion ?? '')
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'merrivile', title: 'Merrivile CAD', version: '1.0.0' },
          instructions: INSTRUCTIONS,
        },
      }
    }
    if (msg.method === 'ping') return { jsonrpc: '2.0', id: msg.id, result: {} }
    if (msg.method === 'tools/list') return { jsonrpc: '2.0', id: msg.id, result: { tools: SPECS } }
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      if (!SPECS.some((s) => s.name === name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`)
      const input = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const started = new Date()
      let reply: Reply
      try {
        reply = await callTool(name, input, { env, user, directory, origin })
      } catch (err) {
        reply = text(`The tool failed: ${(err as Error).message}`, true)
      }
      const trace = new Trace(env, { name: `mcp ${name}`, userId: user.email, sessionId: typeof input.project === 'string' ? `mcp-${input.project}` : 'mcp', input, tags: ['merrivile', 'mcp'] })
      trace.span({ name, startTime: started, endTime: new Date(), input, output: reply.content.map((c) => (c.type === 'text' ? c.text : blockForLog({ type: 'image', mediaType: c.mimeType, data: c.data }))), level: reply.isError ? 'WARNING' : 'DEFAULT' })
      ctx.waitUntil(trace.end({ output: reply.content.find((c) => c.type === 'text')?.text.slice(0, 2000), level: reply.isError ? 'WARNING' : 'DEFAULT' }))
      return { jsonrpc: '2.0', id: msg.id, result: reply }
    }
    return rpcError(msg.id, -32601, `Method not found: ${msg.method}`)
  }
  const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map(one))).filter(Boolean)
  if (!replies.length) return new Response(null, { status: 202 })
  return Response.json(Array.isArray(body) ? replies : replies[0])
}

async function callTool(name: string, input: Record<string, unknown>, o: { env: Env; user: User; directory: DurableObjectStub<Directory>; origin: string }): Promise<Reply> {
  const { env, user } = o
  const account = accountOf(env, user.id)
  const projectId = typeof input.project === 'string' ? input.project : ''
  const info = projectId ? await account.project(projectId) : null
  if (projectId && !info) return text(`No project "${projectId}". Call list_projects for ids.`, true)
  const stub = () => env.PROJECT.get(env.PROJECT.idFromName(projectId))
  const who = { projectId, owner: user.id, email: user.email }

  if (name === 'list_projects') {
    const all = await account.listProjects()
    return text(all.map((p) => `${p.id}  "${p.name}"  ${p.parts} part${p.parts === 1 ? '' : 's'}  changed ${new Date(p.updatedAt).toISOString().slice(0, 16)}`).join('\n') || 'No projects yet.')
  }
  if (name === 'create_project') {
    const p = await account.createProject(String(input.name ?? '').trim().slice(0, 80) || 'Untitled')
    return text(`Created project ${p.id} "${p.name}". Open it at ${o.origin}/#/p/${p.id}`)
  }
  if (name === 'rename_project') {
    const name = String(input.name ?? '').trim().slice(0, 80)
    if (!info || !name) return text('Give a project and a name.', true)
    await account.renameProject(projectId, name)
    return text(`Renamed ${projectId} to "${name}".`)
  }
  if (name === 'delete_project') {
    if (!info) return text('Give a project.', true)
    if (input.confirm_name !== info.name) return text(`confirm_name must be exactly "${info.name}". Nothing was deleted.`, true)
    await stub().destroy()
    await account.removeProject(projectId)
    let cursor: string | undefined
    do {
      const page = await env.FILES.list({ prefix: `projects/${projectId}/`, cursor })
      if (page.objects.length) await env.FILES.delete(page.objects.map((x) => x.key))
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return text(`Deleted project ${projectId} "${info.name}".`)
  }
  if (name === 'list_memory') {
    const all = await account.memories()
    return text(all.map((m) => `[${m.id}] ${m.text}${m.scopeName ? ` (project ${m.scopeName})` : ''}`).join('\n') || 'No memories saved.')
  }

  if (COMPONENT_TOOL_NAMES.has(name)) {
    const r = await runComponentTool(name, input, { env, uid: user.id, api: account as unknown as ComponentToolApi })
    return { content: toContent(r.content), isError: r.isError }
  }
  if (name === 'start_upload') {
    const file = String(input.file ?? '').replace(/[^\w. ()-]/g, '_').slice(0, 160) || 'component.step'
    const meta = { file, ...Object.fromEntries(['id', 'name', 'vendor', 'part_number', 'link', 'notes'].filter((k) => typeof input[k] === 'string').map((k) => [k, input[k]])) }
    const id = await account.startUpload(meta, 3600_000)
    const link = await signedUpload(o.directory, o.origin, user.id, id)
    return text(`Upload link for ${file} (one use, valid 1 hour, up to 95 MB):\n${link}\nFor example: curl -sS -T "${file}" "${link}"\nThe reply names the new component once it's read (about 30 s for a 13 MB board).`)
  }

  if (name === 'inspect' && !projectId) {
    const r = await runInspect(env, { code: String(input.code ?? ''), views: input.views as View[] | undefined, size: input.size as number | undefined, section: input.section as Section | undefined, timeout: input.timeout as number | undefined })
    // No project chat to show it in, but the person can still open the link.
    let key: string | undefined
    if (r.png) {
      key = `users/${user.id}/renders/${crypto.randomUUID()}.png`
      await env.FILES.put(key, Uint8Array.from(atob(r.png), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: 'image/png' } })
    }
    return withLink({ content: toContent(r.content), isError: r.isError }, key, o, false)
  }
  if (PROJECT_TOOL_NAMES.has(name)) {
    if (!projectId) return text('This tool needs a project id; call list_projects.', true)
    if (name === 'export_part') return exportPart(input, o, projectId, stub)
    if (name === 'import_step') {
      const data = await stepBytes(input)
      if (typeof data === 'string') return text(data, true)
      const r = await stub().mcp(who, name, { name: String(input.name).replace(/[^\w. -]/g, '_').slice(0, 120) || 'part.step', data })
      return { content: toContent(r.content), isError: r.isError }
    }
    const r = await stub().mcp(who, name, input)
    return withLink({ content: toContent(r.content), isError: r.isError }, r.render, o, true)
  }

  // Shop, memory and Library: the same code as the chat AI's tools.
  const out = await runShopTool(name, input, { api: account as unknown as ShopApi, env, uid: user.id, attachments: [], files: [], projectId: projectId || undefined, projectName: info?.name, vision: true }, `mcp-${Date.now()}`)
  return { content: toContent(out.result.content), isError: out.result.isError }
}

/** Adds a signed link to a saved render, so the agent can hand the picture to the person. */
async function withLink(reply: Reply, key: string | undefined, o: { directory: DurableObjectStub<Directory>; origin: string }, inChat: boolean): Promise<Reply> {
  if (!key) return reply
  const link = await signedLink(o.directory, o.origin, key)
  const where = inChat ? `The person sees it in the project's "Outside agent (MCP)" chat. ` : ''
  reply.content.push({ type: 'text', text: `${where}Link to the picture (PNG, valid 1 hour, no login), to give the person: ${link}` })
  return reply
}

async function exportPart(input: Record<string, unknown>, o: { directory: DurableObjectStub<Directory>; origin: string; env: Env }, projectId: string, stub: () => DurableObjectStub<import('./project').Project>): Promise<Reply> {
  const part = await stub().partDoc(String(input.part ?? ''))
  if (!part?.files) return text(`No built part "${input.part}".`, true)
  const version = Number(input.version ?? part.version)
  const ext = { step: 'step', stl: 'stl', png: 'png', mesh: 'json' }[String(input.format)] ?? 'step'
  const key = `projects/${projectId}/${part.id}/v${version}.${ext}`
  const head = await o.env.FILES.head(key)
  if (!head) return text(`${part.id} has no v${version} ${input.format} file. Versions: ${(part.versions ?? []).map((v) => v.version).join(', ')}.`, true)
  const link = await signedLink(o.directory, o.origin, key)
  return text(`${part.id} v${version} ${String(input.format).toUpperCase()}, ${(head.size / 1024).toFixed(1)} KB (valid 1 hour):\n${link}\nFor example: curl -o ${part.id}-v${version}.${ext === 'json' ? 'mesh.json' : ext} "${link}"`)
}

async function stepBytes(input: Record<string, unknown>): Promise<Uint8Array | string> {
  if (typeof input.step === 'string' && input.step.trim()) return new TextEncoder().encode(input.step)
  if (typeof input.base64 === 'string' && input.base64.trim()) {
    try {
      return Uint8Array.from(atob(input.base64.replace(/\s+/g, '')), (c) => c.charCodeAt(0))
    } catch {
      return 'base64 is not valid base64.'
    }
  }
  if (typeof input.url !== 'string' || !/^https?:\/\//.test(input.url)) return 'Give the STEP file as url, step (text) or base64.'
  const res = await fetch(input.url, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Merrivile CAD import)' } }).catch((err: Error) => err)
  if (res instanceof Error) return `Couldn't fetch ${input.url}: ${res.message}`
  if (!res.ok) return `Fetching ${input.url} answered HTTP ${res.status}.`
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMPORT) return 'That file is over the 40 MB import limit.'
  const data = new Uint8Array(await res.arrayBuffer())
  if (data.length > MAX_IMPORT) return 'That file is over the 40 MB import limit.'
  // Vendors often serve a zip or an HTML page instead of the STEP itself.
  if (data[0] === 0x50 && data[1] === 0x4b) return 'That URL serves a zip archive. Unzip it locally and send the STEP with step or base64.'
  if (!new TextDecoder().decode(data.subarray(0, 200)).includes('ISO-10303')) return `That URL didn't return a STEP file (it starts with "${new TextDecoder().decode(data.subarray(0, 60)).replace(/\s+/g, ' ')}").`
  return data
}
