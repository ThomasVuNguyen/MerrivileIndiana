import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

// workerd caps PBKDF2 at 100k iterations.
const ITERATIONS = 100_000
const SESSION_DAYS = 30
export const COOKIE = 'mv_session'

export type User = { id: string; email: string }

/** Users and sessions. One instance; each user's data lives in their own Account object. */
export class Directory extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, hash TEXT NOT NULL,
        salt TEXT NOT NULL, iterations INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);`)
  }

  async signUp(email: string, password: string): Promise<User | { error: string }> {
    // The deployment is public; the first account is the owner's.
    const users = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM users').one().n
    if (users > 0 && this.env.OPEN_SIGNUP !== 'true') return { error: 'Sign-ups are closed on this instance.' }
    if (this.sql.exec('SELECT 1 FROM users WHERE email = ?', email).toArray().length) return { error: 'An account with this email already exists. Sign in instead.' }
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const hash = await derive(password, salt, ITERATIONS)
    const id = crypto.randomUUID()
    this.sql.exec('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)', id, email, b64(hash), b64(salt), ITERATIONS, Date.now())
    return { id, email }
  }

  async signIn(email: string, password: string): Promise<User | null> {
    const row = this.sql.exec<{ id: string; hash: string; salt: string; iterations: number }>('SELECT id, hash, salt, iterations FROM users WHERE email = ?', email).toArray()[0]
    // Hash anyway for unknown emails so timing doesn't reveal which accounts exist.
    const hash = await derive(password, row ? unb64(row.salt) : new Uint8Array(16), row?.iterations ?? ITERATIONS)
    if (!row || !equal(hash, unb64(row.hash))) return null
    return { id: row.id, email }
  }

  async createSession(userId: string): Promise<{ token: string; maxAge: number }> {
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)))
    const maxAge = SESSION_DAYS * 86400
    this.sql.exec('INSERT INTO sessions VALUES (?, ?, ?)', await sha256(token), userId, Date.now() + maxAge * 1000)
    this.sql.exec('DELETE FROM sessions WHERE expires_at < ?', Date.now())
    return { token, maxAge }
  }

  async user(token: string): Promise<User | null> {
    const row = this.sql
      .exec<{ id: string; email: string }>(
        'SELECT users.id, users.email FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?',
        await sha256(token),
        Date.now(),
      )
      .toArray()[0]
    return row ?? null
  }

  async endSession(token: string) {
    this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', await sha256(token))
  }
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}

async function sha256(text: string) {
  return b64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}

function equal(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a))
const b64url = (a: Uint8Array) => b64(a).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

export function sessionToken(req: Request) {
  const cookie = req.headers.get('cookie') ?? ''
  return cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))?.[1] ?? null
}

export function sessionCookie(req: Request, token: string, maxAge: number) {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : ''
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}
