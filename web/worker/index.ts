import { z } from 'zod'
import { AnthropicAdapter } from './anthropic'
import { COOKIE, sessionCookie, sessionToken } from './auth'
import type { User } from './auth'
import { accountOf, directoryOf } from './env'
import { kindOf, MAX_UPLOAD, SINGLE_UPLOAD, toBase64 } from './files'
import { GEOMETRY_VERSION, geometryFetch } from './geometry'
import type { Env } from './env'
import { Trace } from './langfuse'
import { ModelError } from './llm'
import type { ApiCall, ModelConfig } from './llm'
import { OpenAICompatAdapter } from './openai'
import { videoFrames } from './video'

export { Account } from './account'
export { Directory } from './auth'
export { Geometry, Video } from './geometry'
export { Project } from './project'

const Credentials = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^\S+@\S+\.\S+$/, 'Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
})

const NewModel = z
  .object({
    label: z.string().trim().min(1).max(60),
    provider: z.enum(['anthropic', 'workers-ai', 'openai']),
    model: z.string().trim().min(1).max(200),
    apiKey: z.string().trim().min(1).max(500),
    baseUrl: z.url().optional(),
    accountId: z.string().trim().regex(/^[0-9a-f]{32}$/, 'Cloudflare account ids are 32 hex characters').optional(),
    vision: z.boolean().optional(),
  })
  .refine((m) => m.provider !== 'workers-ai' || m.accountId, { message: 'Workers AI needs your Cloudflare account id', path: ['accountId'] })
  .refine((m) => m.provider !== 'openai' || m.baseUrl, { message: 'An OpenAI-compatible endpoint needs a base URL', path: ['baseUrl'] })

const LibraryAdd = z.object({
  file: z.object({
    key: z.string(),
    url: z.string(),
    kind: z.enum(['image', 'video', 'pdf', 'text', 'step', 'file']).optional(),
    name: z.string().max(160).optional(),
    previewKey: z.string().optional(),
    previewUrl: z.string().optional(),
    framesKey: z.string().optional(),
    duration: z.number().optional(),
    needsCopy: z.boolean().optional(),
    size: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
  }),
  note: z.string().max(300).optional(),
})

// Quick edits from the Shop page: steppers, bin, tier.
const ShopPatch = z
  .object({
    qty: z.number().int().min(0).optional(),
    qtyDelta: z.number().int().optional(),
    bin: z.string().max(40).optional(),
    tier: z.enum(['on-hand', 'prime', 'order']).optional(),
    price: z.string().max(60).optional(),
    link: z.string().max(500).optional(),
    name: z.string().min(1).max(60).optional(),
    kind: z.string().min(1).max(80).optional(),
  })
  .strict()

/** Streams a stored file; answers HEAD and byte ranges so big downloads can resume. Files never change once written. */
async function serveFile(env: Env, key: string, req: Request) {
  const head = req.method === 'HEAD'
  const obj = head ? await env.FILES.head(key) : await env.FILES.get(key, { range: req.headers })
  if (!obj) return new Response('not found', { status: 404 })
  const headers = new Headers()
  obj.writeHttpMetadata(headers)
  headers.set('etag', obj.httpEtag)
  headers.set('accept-ranges', 'bytes')
  headers.set('cache-control', 'private, max-age=31536000, immutable')
  const range = 'range' in obj ? (obj.range as { offset?: number; length?: number } | undefined) : undefined
  if (!head && range && req.headers.has('range')) {
    const offset = range.offset ?? 0
    const length = range.length ?? obj.size - offset
    headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${obj.size}`)
    headers.set('content-length', String(length))
    return new Response((obj as R2ObjectBody).body, { status: 206, headers })
  }
  headers.set('content-length', String(obj.size))
  return new Response(head ? null : (obj as R2ObjectBody).body, { headers })
}

// Pictures and videos display inline; everything else downloads under its own name.
function httpMetadata(name: string, contentType: string, kind: string): R2HTTPMetadata {
  return { contentType, ...(kind !== 'image' && kind !== 'video' && { contentDisposition: `attachment; filename="${name.replace(/["\\\r\n]/g, '')}"` }) }
}

const json = (body: unknown, status = 200, headers?: HeadersInit) => Response.json(body, { status, headers })

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req)
    const directory = directoryOf(env)

    // Starts the geometry service if it's asleep and builds a fixed test part.
    if (path === '/api/health') {
      const started = Date.now()
      try {
        const version = ((await (await geometryFetch(env, '/health', { method: 'GET', body: '' })).json()) as { version?: string }).version ?? 'unknown'
        const res = await geometryFetch(env, '/build', { method: 'POST', body: JSON.stringify({ source: 'from build123d import *\nresult = Box(10, 10, 10)' }) })
        const out = (await res.json()) as { ok: boolean; ms: number }
        const geometry = !out.ok ? 'failed' : version === GEOMETRY_VERSION ? 'ok' : 'stale'
        return json({ worker: 'ok', geometry, version, buildMs: out.ms, totalMs: Date.now() - started }, geometry === 'ok' ? 200 : 503)
      } catch (err) {
        return json({ worker: 'ok', geometry: `unreachable: ${(err as Error).message}`, totalMs: Date.now() - started }, 503)
      }
    }

    // ------------------------------------------------------------ auth
    if ((path === '/api/auth/signup' || path === '/api/auth/signin') && req.method === 'POST') {
      const creds = Credentials.safeParse(await req.json().catch(() => null))
      if (!creds.success) return json({ error: creds.error.issues[0]?.message ?? 'Invalid sign-in.' }, 400)
      const { email, password } = creds.data
      const user = path.endsWith('signup') ? await directory.signUp(email, password) : await directory.signIn(email, password)
      if (!user) return json({ error: 'Wrong email or password.' }, 401)
      if ('error' in user) return json({ error: user.error }, 409)
      const session = await directory.createSession(user.id)
      return json(user, 200, { 'set-cookie': sessionCookie(req, session.token, session.maxAge) })
    }
    if (path === '/api/auth/signout' && req.method === 'POST') {
      const token = sessionToken(req)
      if (token) await directory.endSession(token)
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` })
    }

    const token = sessionToken(req)
    const user: User | null = token ? await directory.user(token) : null
    if (!user) return json({ error: 'Sign in first.' }, 401)
    if (path === '/api/auth/me') return json(user)
    const account = accountOf(env, user.id)

    // ------------------------------------------------------------ models
    if (path === '/api/models' && req.method === 'GET') return json(await account.listModels())
    if (path === '/api/models' && req.method === 'POST') {
      const parsed = NewModel.safeParse(await req.json().catch(() => null))
      if (!parsed.success) return json({ error: parsed.error.issues[0]?.message ?? 'invalid model' }, 400)
      const m = parsed.data
      // Only save models that answer, so a typo in a key shows up here and not mid-design.
      const check = await ping(env, ctx, user, { ...m, vision: m.vision ?? m.provider === 'anthropic' })
      if (!check.ok) return json({ error: check.error }, 422)
      return json(await account.addModel(m))
    }
    const model = path.match(/^\/api\/models\/([\w-]+)(\/default|\/test)?$/)
    if (model) {
      const [, id, action] = model
      if (req.method === 'DELETE' && !action) return (await account.removeModel(id), json({ ok: true }))
      if (req.method === 'POST' && action === '/default') return (await account.setDefault(id), json({ ok: true }))
      if (req.method === 'POST' && action === '/test') {
        const cfg = await account.modelConfig(id)
        return cfg ? json(await ping(env, ctx, user, cfg)) : json({ error: 'no such model' }, 404)
      }
    }

    // ------------------------------------------------------------ projects
    if (path === '/api/projects' && req.method === 'GET') return json(await account.listProjects())
    if (path === '/api/projects' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { name?: string }
      const name = (body.name ?? '').trim().slice(0, 80) || 'Untitled'
      return json(await account.createProject(name))
    }
    const project = path.match(/^\/api\/projects\/([\w-]+)\/(socket|import)$/)
    if (project) {
      const [, id] = project
      if (!(await account.project(id))) return json({ error: 'no such project' }, 404)
      const headers = new Headers(req.headers)
      headers.set('x-project-id', id)
      headers.set('x-account-id', user.id)
      headers.set('x-user-email', user.email)
      return env.PROJECT.get(env.PROJECT.idFromName(id)).fetch(new Request(req, { headers }))
    }

    // ------------------------------------------------------------ uploads (chat attachments, Library)
    // Up to ~95 MB streams straight through; bigger files come in multipart chunks.
    if (path === '/api/uploads' && req.method === 'POST') {
      const name = decodeURIComponent(req.headers.get('x-filename') ?? 'file').slice(0, 160)
      const size = Number(req.headers.get('content-length') ?? 0)
      if (!size || !req.body) return json({ error: `${name} is empty.` }, 400)
      if (size > SINGLE_UPLOAD) return json({ error: 'Too big for one request; upload it in parts.' }, 413)
      const file = kindOf(name, (req.headers.get('content-type') ?? '').split(';')[0])
      // A preview (or a video's frame sheet) is stored next to its original.
      const preview = req.headers.get('x-preview-of')
      const suffix = req.headers.get('x-preview-as') === 'frames' ? 'frames' : 'preview'
      const key = preview?.startsWith(`users/${user.id}/uploads/`) ? `${preview}.${suffix}.jpg` : `users/${user.id}/uploads/${crypto.randomUUID()}.${file.ext}`
      await env.FILES.put(key, req.body, { httpMetadata: httpMetadata(name, preview ? 'image/jpeg' : file.type, preview ? 'image' : file.kind) })
      return json({ key, url: `/api/files/${key}`, kind: file.kind, name, size })
    }
    if (path === '/api/uploads/multipart' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { name?: string; type?: string; size?: number }
      const name = (body.name ?? 'file').slice(0, 160)
      if (!body.size || body.size > MAX_UPLOAD) return json({ error: `${name}: files up to 5 GB.` }, 413)
      const file = kindOf(name, body.type ?? '')
      const key = `users/${user.id}/uploads/${crypto.randomUUID()}.${file.ext}`
      const upload = await env.FILES.createMultipartUpload(key, { httpMetadata: httpMetadata(name, file.type, file.kind) })
      return json({ key, uploadId: upload.uploadId, kind: file.kind })
    }
    if (path === '/api/uploads/multipart/part' && req.method === 'PUT') {
      const q = new URL(req.url).searchParams
      const key = q.get('key') ?? ''
      const part = Number(q.get('part'))
      if (!key.startsWith(`users/${user.id}/uploads/`) || !(part >= 1 && part <= 10000) || !req.body) return json({ error: 'bad part' }, 400)
      const uploaded = await env.FILES.resumeMultipartUpload(key, q.get('uploadId') ?? '').uploadPart(part, req.body)
      return json({ partNumber: uploaded.partNumber, etag: uploaded.etag })
    }
    if ((path === '/api/uploads/multipart/complete' || path === '/api/uploads/multipart/abort') && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { key?: string; uploadId?: string; parts?: R2UploadedPart[]; name?: string }
      if (!body.key?.startsWith(`users/${user.id}/uploads/`) || !body.uploadId) return json({ error: 'bad upload' }, 400)
      const upload = env.FILES.resumeMultipartUpload(body.key, body.uploadId)
      if (path.endsWith('abort')) return (await upload.abort(), json({ ok: true }))
      const obj = await upload.complete(body.parts ?? [])
      return json({ key: body.key, url: `/api/files/${body.key}`, size: obj.size })
    }
    // Browsers can't all show HEIC; the geometry container makes a JPEG preview.
    if (path === '/api/uploads/preview' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { key?: string }
      if (!body.key?.startsWith(`users/${user.id}/uploads/`)) return json({ error: 'unknown file' }, 403)
      const obj = await env.FILES.get(body.key)
      if (!obj) return json({ error: 'not found' }, 404)
      if (obj.size > 40 * 1024 ** 2) return json({ error: 'Too large to preview (40 MB); the original is kept.' }, 413)
      const res = await geometryFetch(env, '/image/preview', { method: 'POST', body: JSON.stringify({ image: toBase64(new Uint8Array(await obj.arrayBuffer())) }) })
      const out = (await res.json()) as { ok: boolean; jpeg?: string; width?: number; height?: number; error?: string }
      if (!out.ok || !out.jpeg) return json({ error: `Couldn't read that image: ${out.error ?? 'unknown format'}` }, 422)
      const previewKey = `${body.key}.preview.jpg`
      await env.FILES.put(previewKey, Uint8Array.from(atob(out.jpeg), (c) => c.charCodeAt(0)), { httpMetadata: { contentType: 'image/jpeg' } })
      return json({ previewKey, previewUrl: `/api/files/${previewKey}`, width: out.width, height: out.height })
    }

    // Videos this browser couldn't open: the video container makes the poster and frames.
    if (path === '/api/uploads/video' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { key?: string }
      if (!body.key?.startsWith(`users/${user.id}/uploads/`)) return json({ error: 'unknown file' }, 403)
      try {
        return json(await videoFrames(env, body.key))
      } catch (err) {
        return json({ error: (err as Error).message }, 422)
      }
    }

    // ------------------------------------------------------------ shop
    if (path === '/api/shop/socket') {
      const headers = new Headers(req.headers)
      headers.set('x-account-id', user.id)
      headers.set('x-user-email', user.email)
      return account.fetch(new Request(req, { headers }))
    }
    const shopItem = path.match(/^\/api\/shop\/items\/(\w+)$/)
    if (shopItem && req.method === 'PATCH') {
      const patch = ShopPatch.safeParse(await req.json().catch(() => null))
      if (!patch.success) return json({ error: patch.error.issues[0]?.message ?? 'invalid change' }, 400)
      const r = await account.updateItem(shopItem[1], patch.data)
      return r ? json(r.item) : json({ error: 'no such item' }, 404)
    }
    if (shopItem && req.method === 'DELETE') return (await account.removeItem(shopItem[1])) ? json({ ok: true }) : json({ error: 'no such item' }, 404)
    const shopTool = path.match(/^\/api\/shop\/tools\/(\w+)$/)
    if (shopTool && req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { have?: boolean }
      if (typeof body.have !== 'boolean') return json({ error: 'expected {have}' }, 400)
      const r = await account.upsertTool(shopTool[1], { have: body.have })
      return r ? json(r.tool) : json({ error: 'no such tool' }, 404)
    }

    // ------------------------------------------------------------ library
    if (path === '/api/library' && req.method === 'GET') return json(await account.libraryItems())
    if (path === '/api/library' && req.method === 'POST') {
      const body = LibraryAdd.safeParse(await req.json().catch(() => null))
      if (!body.success) return json({ error: body.error.issues[0]?.message ?? 'invalid file' }, 400)
      // Only files this user uploaded.
      const mine = (k?: string) => !k || k.startsWith(`users/${user.id}/uploads/`)
      if (!body.data.file.key || !mine(body.data.file.key) || !mine(body.data.file.previewKey) || !mine(body.data.file.framesKey)) return json({ error: 'unknown file' }, 403)
      const { item } = await account.addLibraryItem(body.data.file, body.data.note ?? '')
      // The searchable description is written in the background.
      ctx.waitUntil(account.describeLibraryItem(item.id))
      return json(item)
    }
    const libraryItem = path.match(/^\/api\/library\/(\w+)$/)
    if (libraryItem && req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { note?: string }
      if (typeof body.note !== 'string' || body.note.length > 300) return json({ error: 'expected {note}, up to 300 characters' }, 400)
      const item = await account.updateLibraryNote(libraryItem[1], body.note)
      return item ? json(item) : json({ error: 'no such file' }, 404)
    }
    const copy = path.match(/^\/api\/library\/(\w+)\/copy$/)
    if (copy && req.method === 'POST') {
      const item = await account.requestCopy(copy[1])
      return item ? json(item) : json({ error: 'no such file' }, 404)
    }
    if (libraryItem && req.method === 'DELETE') return (await account.removeLibraryItem(libraryItem[1])) ? json({ ok: true }) : json({ error: 'no such file' }, 404)

    // ------------------------------------------------------------ memory
    if (path === '/api/memory' && req.method === 'GET') return json(await account.memories())
    if (path === '/api/memory' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { text?: string }
      const text = (body.text ?? '').trim()
      if (text.length < 3 || text.length > 400) return json({ error: 'A memory is 3 to 400 characters.' }, 400)
      return json((await account.addMemory(text, 'everywhere', undefined, 'you added it')).memory)
    }
    const memory = path.match(/^\/api\/memory\/(\w+)$/)
    if (memory && req.method === 'PATCH') {
      const body = (await req.json().catch(() => ({}))) as { text?: string }
      const text = (body.text ?? '').trim()
      if (text.length < 3 || text.length > 400) return json({ error: 'A memory is 3 to 400 characters.' }, 400)
      return (await account.editMemory(memory[1], text)) ? json({ ok: true }) : json({ error: 'no such memory' }, 404)
    }
    if (memory && req.method === 'DELETE') return (await account.removeMemory(memory[1])) ? json({ ok: true }) : json({ error: 'no such memory' }, 404)

    // ------------------------------------------------------------ files
    const own = path.match(/^\/api\/files\/(users\/([\w-]+)\/.+)$/)
    if (own && (req.method === 'GET' || req.method === 'HEAD')) {
      if (own[2] !== user.id) return new Response('not found', { status: 404 })
      return serveFile(env, decodeURIComponent(own[1]), req)
    }
    const file = path.match(/^\/api\/files\/(projects\/([\w-]+)\/.+)$/)
    if (file && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!(await account.project(file[2]))) return new Response('not found', { status: 404 })
      return serveFile(env, decodeURIComponent(file[1]), req)
    }

    return json({ error: 'not found' }, 404)
  },
} satisfies ExportedHandler<Env>

async function ping(env: Env, ctx: ExecutionContext, user: User, cfg: ModelConfig): Promise<{ ok: true; name: string; ms: number } | { ok: false; error: string }> {
  const started = Date.now()
  const adapter = cfg.provider === 'anthropic' ? new AnthropicAdapter(cfg) : new OpenAICompatAdapter(cfg)
  // Checks that spend tokens (OpenAI-compatible endpoints) are traced like any other call.
  const trace = new Trace(env, { name: 'model-test', userId: user.email, input: { provider: cfg.provider, model: cfg.model }, tags: ['merrivile', 'model-test'] })
  let spent = false
  const onCall = (c: ApiCall) => {
    spent = true
    trace.generation({ name: 'model test', model: c.model, startTime: c.startTime, endTime: c.endTime, input: 'Reply with OK.', output: c.output, usage: c.usage, modelParameters: c.params })
  }
  let result: { ok: true; name: string; ms: number } | { ok: false; error: string }
  try {
    const name = await adapter.ping(AbortSignal.timeout(20_000), onCall)
    result = { ok: true, name, ms: Date.now() - started }
  } catch (err) {
    result = { ok: false, error: err instanceof ModelError ? err.message : `Check failed: ${(err as Error).message}` }
  }
  if (spent) ctx.waitUntil(trace.end({ output: result, level: result.ok ? 'DEFAULT' : 'WARNING' }))
  return result
}
