import { useEffect, useState } from 'react'
import type { Memory } from '../shared/protocol'
import { SettingsTabs, TopBar } from './paper'

/** Settings → Memory: what the AI remembers about how you work. */
export function MemoryPage() {
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    fetch('/api/memory')
      .then((r) => r.json())
      .then((m: Memory[]) => setMemories(m), () => setMemories([]))
  useEffect(() => {
    load()
  }, [])

  const call = async (path: string, method: string, body?: unknown) => {
    setError(null)
    const res = await fetch(path, { method, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Failed (${res.status})`)
    await load()
    return res.ok
  }

  const groups = new Map<string, { name: string; items: Memory[] }>()
  for (const m of memories ?? []) {
    const key = m.scope
    if (!groups.has(key)) groups.set(key, { name: m.scope === 'everywhere' ? 'Everywhere' : (m.scopeName ?? 'One project'), items: [] })
    groups.get(key)!.items.push(m)
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (a === 'everywhere' ? -1 : b === 'everywhere' ? 1 : 0))

  return (
    <div className="projects settings">
      <TopBar active="settings" />
      <section className="settings-body">
        <a className="link settings-back" href="#/projects">
          ← Projects
        </a>
        <SettingsTabs active="memory" />
        <h1>Memory</h1>
        <p className="muted">
          What the AI remembers about how you work. It saves things as it learns them and shows each one in the chat with an undo. Tools and hardware live in the
          Shop.
        </p>
        {memories && memories.length === 0 && <p className="settings-empty">Nothing yet. Tell it how you work, or add something below.</p>}
        {ordered.map(([scope, g]) => (
          <div key={scope} className="memory-group">
            <div className="eyebrow">{g.name}</div>
            {g.items.map((m) => (
              <div key={m.id} className="memory-row">
                <div className="memory-main">
                  {editing === m.id ? (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault()
                        if (await call(`/api/memory/${m.id}`, 'PATCH', { text: draft })) setEditing(null)
                      }}
                    >
                      <input className="memory-edit" value={draft} autoFocus onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} />
                    </form>
                  ) : (
                    <span>{m.text}</span>
                  )}
                  <span className="faint">
                    {m.source} · {new Date(m.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </div>
                {editing === m.id ? (
                  <button className="link" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                ) : (
                  <button
                    className="link"
                    onClick={() => {
                      setEditing(m.id)
                      setDraft(m.text)
                    }}
                  >
                    Edit
                  </button>
                )}
                <button className="link" onClick={() => call(`/api/memory/${m.id}`, 'DELETE')}>
                  Delete
                </button>
              </div>
            ))}
          </div>
        ))}
        {error && <p className="auth-error">{error}</p>}
        <form
          className="memory-add"
          onSubmit={async (e) => {
            e.preventDefault()
            if (adding.trim() && (await call('/api/memory', 'POST', { text: adding }))) setAdding('')
          }}
        >
          <input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add something it should always know, e.g. “my printer bed is 256 mm”" />
          <button className="btn btn--solid" type="submit" disabled={!adding.trim()}>
            Add
          </button>
        </form>
      </section>
    </div>
  )
}
