import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryItem } from '../shared/protocol'
import { clock, FILES_AT_ONCE, filesFrom, pool, shownUrl, sizeLabel, uploadFile } from './attach'
import { TopBar } from './paper'
import { Icon } from './ui'

let uploadId = 0

/** A free-form place for reference files: photos of the space, experiments, data. Notes are optional. */
export function LibraryPage() {
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [pending, setPending] = useState<{ id: number; name: string; progress: number }[]>([])
  const uploading = pending.length
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const picker = useRef<HTMLInputElement>(null)

  const load = useCallback(
    () =>
      fetch('/api/library')
        .then((r) => r.json())
        .then(setItems, () => setItems([])),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  // The AI's description lands a few seconds after a file is added; videos may take the server a while.
  const indexing = items?.some((i) => i.processing || (!i.description && Date.now() - i.createdAt < 120_000))
  useEffect(() => {
    if (!indexing) return
    const t = window.setInterval(load, 4000)
    return () => window.clearInterval(t)
  }, [indexing, load])

  const add = useCallback(async (files: File[]) => {
    if (!files.length) return
    setError(null)
    const batch = files.map((f) => ({ id: ++uploadId, f }))
    setPending((p) => [...p, ...batch.map((b) => ({ id: b.id, name: b.f.name, progress: 0 }))])
    await pool(batch, FILES_AT_ONCE, async ({ id, f }) => {
      try {
        const file = await uploadFile(f, (progress) => setPending((p) => p.map((x) => (x.id === id ? { ...x, progress } : x))))
        const res = await fetch('/api/library', {
          method: 'POST',
          body: JSON.stringify({ file }),
        })
        const item = (await res.json()) as LibraryItem & { error?: string }
        if (!res.ok) throw new Error(item.error ?? `Couldn't add ${f.name}`)
        setItems((all) => [item, ...(all ?? [])])
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setPending((p) => p.filter((x) => x.id !== id))
      }
    })
  }, [])

  // Paste anywhere on the page, unless you're typing.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (e.target instanceof Element && e.target.closest('input, textarea')) return
      const files = filesFrom(e.clipboardData)
      if (files.length) {
        e.preventDefault()
        add(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [add])

  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = (items ?? []).filter((i) => words.every((w) => `${i.note} ${i.name ?? ''} ${i.description ?? ''}`.toLowerCase().includes(w)))
  const item = items?.find((i) => i.id === open) ?? null

  return (
    <div
      className={`projects library${dragging ? ' is-dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        add(filesFrom(e.dataTransfer))
      }}
    >
      <TopBar active="library" />
      <section className="shop-body">
        <div className="shop-head">
          <h1>Library</h1>
          {items && items.length > 0 && (
            <div className="shop-opts">
              <input className="library-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter" aria-label="Filter the library" />
              <span className="faint small">{items.length} files</span>
            </div>
          )}
        </div>
        {items?.length === 0 && !uploading && (
          <p className="shop-empty">
            Photos of your office and lab, experiments and their data, drawings, anything worth keeping. Drop, paste or pick files; a note is optional. The AI looks here when it
            needs to know where something has to fit or what a test showed.
          </p>
        )}
        {error && <p className="auth-error">{error}</p>}
        <div className="library-grid">
          <button className="add-tile library-add" onClick={() => picker.current?.click()}>
            <span className="add-plus">+</span>
            <span>Add</span>
            <span className="faint">drop, paste or pick files</span>
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            data-testid="library-input"
            onChange={(e) => {
              add([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          {pending.map((p) => (
            <div key={p.id} className="library-card is-loading">
              <span className="library-progress">
                <span>{p.name}</span>
                <span>{Math.round(p.progress * 100)}%</span>
              </span>
              <span className="library-bar" style={{ width: `${p.progress * 100}%` }} />
            </div>
          ))}
          {shown.map((i) => (
            <button key={i.id} className="library-card" onClick={() => setOpen(i.id)}>
              <Tile item={i} />
              {i.note && <span className="library-note">{i.note}</span>}
            </button>
          ))}
        </div>
      </section>
      {item && <LibrarySheet key={item.id} item={item} onClose={() => setOpen(null)} onChanged={load} />}
      {dragging && <div className="library-drop">Drop to add to the Library</div>}
    </div>
  )
}

function Tile({ item: i }: { item: LibraryItem }) {
  const kind = i.kind ?? 'image'
  const picture = kind === 'image' ? i.previewUrl || !/\.(heic|heif)$/i.test(i.key) : kind === 'video' && !!i.previewUrl
  if (picture)
    return (
      <>
        <img
          src={shownUrl(i)}
          alt={i.note || ''}
          loading="lazy"
          style={{
            aspectRatio: i.width && i.height ? `${i.width} / ${i.height}` : undefined,
          }}
        />
        {kind === 'video' && <span className="video-badge">▶ {clock(i.duration)}</span>}
      </>
    )
  return (
    <span className="library-file">
      <span className="file-kind">{/\.(heic|heif)$/i.test(i.key) ? 'heic' : kind}</span>
      <span>{i.name}</span>
      <span className="faint">{i.processing ? 'processing…' : i.problem ? "can't preview" : sizeLabel(i.size)}</span>
    </span>
  )
}

function LibrarySheet({ item, onClose, onChanged }: { item: LibraryItem; onClose: () => void; onChanged: () => void }) {
  const [note, setNote] = useState(item.note)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const save = async () => {
    if (note === item.note) return
    await fetch(`/api/library/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    })
    onChanged()
  }
  return (
    <aside className="paper-card item-sheet library-sheet" aria-label={item.name ?? 'Library file'}>
      <button className="item-close" onClick={onClose} aria-label="Close">
        <Icon name="close" size={14} />
      </button>
      {(item.kind ?? 'image') === 'image' ? (
        <a href={item.url} target="_blank" rel="noreferrer">
          <img className="library-preview" src={shownUrl(item)} alt="" />
        </a>
      ) : item.kind === 'video' ? (
        <Player key={item.playUrl ?? item.url} item={item} onChanged={onChanged} />
      ) : (
        <div className="item-visual">
          <span className="file-kind">{item.kind}</span>
        </div>
      )}
      <div className="eyebrow">
        {item.name ?? 'image'} ·{' '}
        {new Date(item.createdAt).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}
      </div>
      <textarea className="library-note-edit" value={note} placeholder="Add a note (optional)" rows={3} onChange={(e) => setNote(e.target.value)} onBlur={save} />
      {item.description && <p className="faint small library-desc">AI index: {item.description}</p>}
      <div className="item-actions">
        <a className="link" href={item.url} target="_blank" rel="noreferrer" download={(item.kind ?? 'image') === 'image' ? undefined : item.name}>
          {(item.kind ?? 'image') === 'image'
            ? `Original${item.size ? ` · ${sizeLabel(item.size)}` : ''} ↗`
            : `Download${item.kind === 'video' ? ' original' : ''} · ${sizeLabel(item.size)}`}
        </a>
        <button
          className="link item-delete"
          onClick={async () => {
            if (!confirm('Delete this file from the Library?')) return
            await fetch(`/api/library/${item.id}`, { method: 'DELETE' })
            onClose()
            onChanged()
          }}
        >
          Delete
        </button>
      </div>
    </aside>
  )
}

/** Plays the original, or the MP4 copy for formats browsers can't play. */
function Player({ item, onChanged }: { item: LibraryItem; onChanged: () => void }) {
  // The server couldn't read it either (corrupt, or not really a video): nothing to play or convert.
  const unreadable = !item.previewUrl && !!item.problem
  const [failed, setFailed] = useState(unreadable)
  const waiting = item.needsCopy && !item.playUrl && !unreadable
  // This browser can't play the original (HEVC outside Safari and Chrome on Mac, for one): ask for an MP4 copy.
  const cantPlay = () => {
    setFailed(true)
    if (!item.playUrl && !item.processing && !unreadable) fetch(`/api/library/${item.id}/copy`, { method: 'POST' }).then(onChanged)
  }
  const status = waiting
    ? item.processing
      ? 'Making a copy that plays in this browser…'
      : (item.problem ?? "This format doesn't play in browsers.")
    : unreadable
      ? item.problem
      : failed
        ? "This browser can't play this video; download the original."
        : item.processing
          ? 'Processing…'
          : item.problem
  return (
    <div className="library-player">
      {waiting || failed ? (
        item.previewUrl ? (
          <img className="library-preview" src={item.previewUrl} alt="" />
        ) : (
          <div className="item-visual">
            <span className="file-kind">video</span>
          </div>
        )
      ) : (
        <video
          className="library-preview"
          src={item.playUrl ?? item.url}
          poster={item.previewUrl}
          controls
          playsInline
          preload="metadata"
          onError={cantPlay}
          // Some browsers play an HEVC file's sound with no picture instead of failing.
          onLoadedMetadata={(e) => !e.currentTarget.videoWidth && cantPlay()}
        />
      )}
      {status && <p className="faint small">{status}</p>}
    </div>
  )
}
