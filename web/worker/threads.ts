// Several chats in one Durable Object: the Shop's, or a project's. Each keeps what the person
// sees, what the model sees, and a little state of its own (its latest attachments, and which
// shop and memory it has been shown).

import type { ChatEntry, ThreadInfo } from '../shared/protocol'
import type { HistoryItem } from './llm'

export class Threads {
  constructor(
    private sql: SqlStorage,
    legacy: { chat: string; history: string },
  ) {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS thread_chat (thread TEXT NOT NULL, idx INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (thread, idx));
      CREATE TABLE IF NOT EXISTS thread_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, item TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS thread_history_by_thread ON thread_history (thread, seq);
      CREATE TABLE IF NOT EXISTS thread_meta (thread TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, PRIMARY KEY (thread, k));`)
    this.migrate(legacy)
  }

  /** The one chat from before there were several becomes the first thread, state and all. */
  private migrate({ chat, history }: { chat: string; history: string }) {
    if (!this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", chat).toArray().length) return
    const rows = this.sql.exec<{ entry: string }>(`SELECT entry FROM ${chat} ORDER BY seq`).toArray()
    if (rows.length) {
      const first = rows.map((r) => JSON.parse(r.entry) as ChatEntry).find((e) => e.role === 'user')
      const id = this.create(first ? titleOf(first) : 'First chat').id
      rows.forEach((r, i) => this.sql.exec('INSERT INTO thread_chat VALUES (?, ?, ?)', id, i, r.entry))
      this.sql.exec(`INSERT INTO thread_history (thread, item) SELECT ?, item FROM ${history} ORDER BY seq`, id)
      for (const k of ['images', 'files', 'context']) {
        const v = this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v
        if (v !== undefined) this.setMeta(id, k, v)
      }
    }
    this.sql.exec(`DROP TABLE ${chat}; DROP TABLE IF EXISTS ${history}`)
  }

  list(): ThreadInfo[] {
    return this.sql
      .exec<{ id: string; title: string; updated_at: number; n: number }>(
        'SELECT t.id, t.title, t.updated_at, (SELECT count(*) FROM thread_chat c WHERE c.thread = t.id) AS n FROM threads t ORDER BY t.updated_at DESC',
      )
      .toArray()
      .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, messages: r.n }))
  }

  has(id: string) {
    return this.sql.exec('SELECT 1 FROM threads WHERE id = ?', id).toArray().length > 0
  }

  /** The thread to show when none is asked for: the one used last. */
  latest() {
    return this.list()[0]?.id ?? ''
  }

  create(title = 'New chat') {
    const now = Date.now()
    const id = `t${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
    this.sql.exec('INSERT INTO threads VALUES (?, ?, ?, ?)', id, title, now, now)
    return { id, title }
  }

  remove(id: string) {
    for (const table of ['threads', 'thread_chat', 'thread_history', 'thread_meta']) this.sql.exec(`DELETE FROM ${table} WHERE ${table === 'threads' ? 'id' : 'thread'} = ?`, id)
  }

  entries(thread: string): ChatEntry[] {
    return this.sql.exec<{ entry: string }>('SELECT entry FROM thread_chat WHERE thread = ? ORDER BY idx', thread).toArray().map((r) => JSON.parse(r.entry))
  }

  entry(thread: string, idx: number): ChatEntry | null {
    const row = this.sql.exec<{ entry: string }>('SELECT entry FROM thread_chat WHERE thread = ? AND idx = ?', thread, idx).toArray()[0]
    return row ? JSON.parse(row.entry) : null
  }

  /** Adds a message and returns its index. The first message names the thread. */
  push(thread: string, entry: ChatEntry) {
    const idx = this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM thread_chat WHERE thread = ?', thread).one().n
    this.sql.exec('INSERT INTO thread_chat VALUES (?, ?, ?)', thread, idx, JSON.stringify(entry))
    if (idx === 0 && entry.role === 'user') this.sql.exec('UPDATE threads SET title = ? WHERE id = ?', titleOf(entry), thread)
    this.sql.exec('UPDATE threads SET updated_at = ? WHERE id = ?', Date.now(), thread)
    return idx
  }

  save(thread: string, idx: number, entry: ChatEntry) {
    this.sql.exec('UPDATE thread_chat SET entry = ? WHERE thread = ? AND idx = ?', JSON.stringify(entry), thread, idx)
  }

  history(thread: string): HistoryItem[] {
    return this.sql.exec<{ item: string }>('SELECT item FROM thread_history WHERE thread = ? ORDER BY seq', thread).toArray().map((r) => JSON.parse(r.item))
  }

  append(thread: string, item: HistoryItem) {
    this.sql.exec('INSERT INTO thread_history (thread, item) VALUES (?, ?)', thread, JSON.stringify(item))
  }

  meta(thread: string, k: string) {
    return this.sql.exec<{ v: string }>('SELECT v FROM thread_meta WHERE thread = ? AND k = ?', thread, k).toArray()[0]?.v ?? ''
  }

  setMeta(thread: string, k: string, v: string) {
    this.sql.exec('INSERT OR REPLACE INTO thread_meta VALUES (?, ?, ?)', thread, k, v)
  }
}

/** "Add these into the shop" → the thread's name; a file's name when there's no text. */
function titleOf(entry: ChatEntry) {
  const text = entry.text.replace(/\s+/g, ' ').trim() || (entry.role === 'user' && entry.images?.[0]?.name) || 'Files'
  if (text.length <= 48) return text
  const cut = text.slice(0, 48)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 24 ? cut.lastIndexOf(' ') : 48)}…`
}
