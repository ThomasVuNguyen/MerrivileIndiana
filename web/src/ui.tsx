import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { SWATCHES, sourceFor } from './data'
import type { Attachment, FaceRef } from '../shared/protocol'
import { clock, FILES_AT_ONCE, filesFrom, pictured, pool, shownUrl, sizeLabel, uploadFile } from './attach'
import { NoteChip } from './paper'
import { Prose } from './prose'
import type { Message, Part } from './data'
import { useWorkspace } from './workspace'

const PATHS: Record<string, string> = {
  sidebar: 'M3 4h18v16H3zM9 4v16',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'm15 14 5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  upload: 'M12 15V3m-5 5 5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  download: 'M12 3v12m-5-5 5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  fit: 'M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5',
  explode: 'M12 3v6M12 15v6M3 12h6M15 12h6M8 8 5 5M16 8l3-3M8 16l-3 3M16 16l3 3',
  section: 'M4 4h16v16H4zM4 20 20 4',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6',
  close: 'M6 6l12 12M18 6 6 18',
  send: 'M5 12h14m-6-6 6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  chevron: 'm6 9 6 6 6-6',
  code: 'm8 6-6 6 6 6M16 6l6 6-6 6',
  cube: 'M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 0v20M3 7l9 5 9-5',
  check: 'M5 12l5 5 9-10',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm10 3-5-5',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  stop: 'M7 7h10v10H7z',
  clip: 'm20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.3 3.3 0 0 1 4.7 4.7L9.2 17.2a1.7 1.7 0 0 1-2.4-2.4L14.5 7',
}

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name]} />
    </svg>
  )
}

export function IconButton({ icon, label, onClick, active, kbd }: { icon: string; label: string; onClick?: () => void; active?: boolean; kbd?: string }) {
  return (
    <button className={`icon-btn${active ? ' is-active' : ''}`} onClick={onClick} aria-label={label} aria-pressed={active} title={kbd ? `${label}  ${kbd}` : label}>
      <Icon name={icon} />
    </button>
  )
}

export function ChatThread({ compact }: { compact?: boolean }) {
  const ws = useWorkspace()
  return <Thread messages={ws.messages} busy={ws.busy} live={ws.live} compact={compact} onToggleNote={ws.toggleNote} />
}

/** A chat transcript; shared by the design dock and the Shop. */
export function Thread({
  messages,
  busy,
  live = true,
  compact,
  onToggleNote,
}: {
  messages: Message[]
  busy: boolean
  live?: boolean
  compact?: boolean
  onToggleNote?: (index: number, changeId: string) => void
}) {
  const end = useRef<HTMLDivElement>(null)
  const last = messages[messages.length - 1]
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, busy, last?.text.length])
  const waiting = busy && (!live || (last?.role === 'ai' && !last.text && !last.calls?.length))
  return (
    <div className={`thread${compact ? ' thread--compact' : ''}`}>
      {messages.map((m, i) => (
        <ChatMessage key={i} m={m} onToggleNote={onToggleNote && ((changeId) => onToggleNote(i, changeId))} />
      ))}
      {waiting && (
        <div className="msg msg--ai">
          <div className="msg-who">AI</div>
          <div className="call is-running">
            <span className="call-dot" />
            <span className="call-tool">thinking</span>
          </div>
        </div>
      )}
      <div ref={end} />
    </div>
  )
}

export function ChatMessage({ m, onToggleNote }: { m: Message; onToggleNote?: (changeId: string) => void }) {
  if (m.role === 'user')
    return (
      <div className="msg msg--user">
        <div className="msg-who">You</div>
        {m.text && <div className="msg-text">{m.text}</div>}
        {m.images && m.images.length > 0 && (
          <div className="msg-images">
            {m.images.map((a) =>
              pictured(a) ? (
                <a key={a.key} className="msg-image" href={a.url} target="_blank" rel="noreferrer">
                  <img src={shownUrl(a)} alt="" />
                  {a.kind === 'video' && <span className="video-badge">▶ {clock(a.duration)}</span>}
                </a>
              ) : (
                <a key={a.key} className="file-chip" href={a.url} download={a.name}>
                  <span className="file-kind">{a.kind}</span>
                  {a.name}
                  <span className="faint">{sizeLabel(a.size)}</span>
                </a>
              ),
            )}
          </div>
        )}
        {m.faces?.map((f) => (
          <span key={`${f.part}-${f.index}`} className="face-chip face-chip--sent">
            {faceLabel(f)}
          </span>
        ))}
      </div>
    )
  return (
    <div className={`msg msg--ai${m.error ? ' is-error' : ''}`}>
      <div className="msg-who">{m.model ?? 'AI'}</div>
      {m.calls && m.calls.length > 0 && (
        <div className="calls">
          {m.calls.map((c, i) => (
            <div key={i} className={`call${c.state === 'running' ? ' is-running' : c.state === 'error' ? ' is-error' : ''}`}>
              <span className="call-dot" />
              <span className="call-tool">{c.tool}</span>
              <span className="call-detail">{c.detail}</span>
              {c.ms !== undefined && <span className="call-ms">{c.ms < 1000 ? `${c.ms} ms` : `${(c.ms / 1000).toFixed(1)} s`}</span>}
            </div>
          ))}
        </div>
      )}
      {m.text && (
        <div className="msg-text msg-text--prose">
          <Prose text={m.text} />
        </div>
      )}
      {m.notes?.map((n) => (
        <NoteChip key={n.changeId} note={n} onToggle={onToggleNote && (() => onToggleNote(n.changeId))} />
      ))}
    </div>
  )
}

export function Composer({ placeholder = 'Describe a part or a change…', footer }: { placeholder?: string; footer?: ReactNode }) {
  const ws = useWorkspace()
  return (
    <ChatInput
      placeholder={placeholder}
      footer={footer ?? <span className="composer-model">model · build123d</span>}
      busy={ws.busy}
      canStop={ws.live && ws.busy}
      onStop={ws.stop}
      attachments={ws.live}
      onSend={(text, images) => ws.send(text, images)}
      chips={
        ws.faces.length > 0 && (
          <div className="face-chips">
            {ws.faces.map((f) => (
              <span key={`${f.part}-${f.index}`} className="face-chip">
                {faceLabel(f)}
                <button type="button" aria-label="Remove face" onClick={() => ws.toggleFace(f, true)}>
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        )
      }
    />
  )
}

/**
 * The message box: Enter sends, Shift+Enter breaks a line. Images come in by
 * the paperclip, by pasting (Ctrl/Cmd+V) or by dropping them on the box.
 */
export function ChatInput({
  placeholder,
  footer,
  chips,
  busy,
  canStop,
  onStop,
  onSend,
  attachments = true,
  textRef,
}: {
  placeholder: string
  footer?: ReactNode
  chips?: ReactNode
  busy: boolean
  canStop: boolean
  onStop: () => void
  onSend: (text: string, images: Attachment[]) => void
  attachments?: boolean
  textRef?: React.RefObject<HTMLTextAreaElement | null>
}) {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [pending, setPending] = useState<{ id: number; name: string; progress: number }[]>([])
  const uploading = pending.length
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)

  const add = async (files: File[]) => {
    if (!attachments || !files.length) return
    setError(null)
    const batch = files.slice(0, 10).map((f, i) => ({ id: Date.now() + i, file: f }))
    setPending((p) => [...p, ...batch.map((b) => ({ id: b.id, name: b.file.name, progress: 0 }))])
    // Up together; they land in the order they were picked.
    const done = await pool(batch, FILES_AT_ONCE, async (b) => {
      try {
        return await uploadFile(b.file, (progress) => setPending((p) => p.map((x) => (x.id === b.id ? { ...x, progress } : x))))
      } catch (err) {
        setError((err as Error).message)
        return null
      }
    })
    setPending((p) => p.filter((x) => !batch.some((b) => b.id === x.id)))
    setImages((im) => [...im, ...done.filter((a) => a !== null)].slice(0, 10))
  }
  const ready = (text.trim() || images.length) && !uploading && !busy
  const submit = () => {
    if (!ready) return
    onSend(text.trim(), images)
    setText('')
    setImages([])
  }

  return (
    <form
      className={`composer${dragging ? ' is-dragging' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (canStop) onStop()
        else submit()
      }}
      onDragOver={(e) => {
        if (!attachments || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!attachments) return
        e.preventDefault()
        setDragging(false)
        add(filesFrom(e.dataTransfer))
      }}
    >
      {chips}
      {(images.length > 0 || uploading > 0) && (
        <div className="attach-strip">
          {images.map((a) => {
            const remove = (
              <button type="button" aria-label={`Remove ${a.name ?? 'attachment'}`} onClick={() => setImages((all) => all.filter((x) => x.key !== a.key))}>
                <Icon name="close" size={10} />
              </button>
            )
            return pictured(a) ? (
              <span key={a.key} className="attach-thumb" title={a.name}>
                <img src={shownUrl(a)} alt="" />
                {a.kind === 'video' && <span className="video-badge">▶</span>}
                {remove}
              </span>
            ) : (
              <span key={a.key} className="file-chip file-chip--draft" title={a.name}>
                <span className="file-kind">{a.kind}</span>
                <span className="file-name">{a.name}</span>
                <span className="faint">{sizeLabel(a.size)}</span>
                {remove}
              </span>
            )
          })}
          {pending.map((p) => (
            <span key={p.id} className="attach-thumb is-loading" title={p.name}>
              <span className="attach-progress">{Math.round(p.progress * 100)}%</span>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={textRef}
        value={text}
        rows={2}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const files = filesFrom(e.clipboardData)
          if (files.length) {
            e.preventDefault()
            add(files)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {error && <p className="attach-error">{error}</p>}
      <div className="composer-row">
        {footer}
        <span className="composer-actions">
          {attachments && (
            <>
              <button type="button" className="attach-btn" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach files up to 5 GB: photos (HEIC too), PDFs, CSV/text, STEP, anything (or paste and drop them)">
                <Icon name="clip" size={15} />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                data-testid="attach-input"
                onChange={(e) => {
                  add([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
            </>
          )}
          <button className="send" type="submit" disabled={canStop ? false : !ready} aria-label={canStop ? 'Stop' : 'Send'}>
            <Icon name={busy ? 'stop' : 'send'} size={15} />
          </button>
        </span>
      </div>
    </form>
  )
}

export function ImportButton({ children, className = 'btn' }: { children?: ReactNode; className?: string }) {
  const ws = useWorkspace()
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button className={className} onClick={() => input.current?.click()} title="Import STEP">
        {children ?? (
          <>
            <Icon name="upload" size={15} /> Import
          </>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept=".step,.stp"
        hidden
        data-testid="import-input"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) ws.importStep(f)
          e.target.value = ''
        }}
      />
    </>
  )
}

export function ExportMenu({ className = 'btn', label, align = 'right' }: { className?: string; label?: ReactNode; align?: 'left' | 'right' }) {
  const ws = useWorkspace()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const part = ws.selectedPart
  const go = (format: 'step' | 'stl', scope: 'part' | 'assembly') => {
    ws.exportFile(format, scope)
    setOpen(false)
  }
  return (
    <div className="menu-anchor" ref={ref}>
      <button className={className} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {label ?? (
          <>
            <Icon name="download" size={15} /> Export
          </>
        )}
      </button>
      {open && (
        <div className={`menu menu--${align}`} role="menu">
          <div className="menu-label">{part ? part.name : 'Select a part to export it alone'}</div>
          <button role="menuitem" disabled={!part} onClick={() => go('step', 'part')}>
            STEP <span>.step</span>
          </button>
          <button role="menuitem" disabled={!part} onClick={() => go('stl', 'part')}>
            STL <span>.stl</span>
          </button>
          {!ws.live && (
            <>
              <div className="menu-sep" />
              <div className="menu-label">Whole assembly</div>
              <button role="menuitem" onClick={() => go('step', 'assembly')}>
                STEP <span>{ws.parts.length} solids</span>
              </button>
              <button role="menuitem" onClick={() => go('stl', 'assembly')}>
                STL <span>mesh</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function Appearance({ part }: { part: Part }) {
  const ws = useWorkspace()
  const look = ws.look[part.id]
  if (!look) return null
  return (
    <div className="appearance">
      <div className="swatches">
        {SWATCHES.map((c) => (
          <button
            key={c}
            className={`swatch${look.color.toLowerCase() === c ? ' is-on' : ''}`}
            style={{ background: c }}
            onClick={() => ws.setAppearance(part.id, { color: c })}
            aria-label={`Color ${c}`}
          />
        ))}
        <label className="swatch swatch--custom" title="Custom color">
          <input type="color" value={look.color} onChange={(e) => ws.setAppearance(part.id, { color: e.target.value })} />
        </label>
      </div>
      <label className="slider">
        <span>Opacity</span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.05}
          value={look.opacity}
          onChange={(e) => ws.setAppearance(part.id, { opacity: +e.target.value })}
        />
        <output>{Math.round(look.opacity * 100)}%</output>
      </label>
    </div>
  )
}

export function Properties({ part }: { part: Part }) {
  const rows: [string, string][] = [
    ['Material', part.material],
    ['Mass', part.mass_g ? `${part.mass_g.toLocaleString()} g` : '—'],
    ['Size', part.bbox.map((v) => +v.toFixed(1)).join(' × ') + ' mm'],
    ['Faces', String(part.faces)],
    ['Source', part.source === 'step' ? 'Imported STEP' : `build123d · ${part.fn}()`],
  ]
  return (
    <dl className="props">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Source({ part }: { part: Part }) {
  const code = part.live ? part.live.source : sourceFor(part.fn)
  if (!code) return <p className="muted small">Imported geometry has no source. Ask the AI to rebuild it in build123d.</p>
  return <pre className="code">{code}</pre>
}

export function Toast() {
  const ws = useWorkspace()
  if (!ws.toast) return null
  return (
    <div className="toast" role="status">
      <Icon name="check" size={14} /> {ws.toast}
    </div>
  )
}

export function totalMass(parts: Part[]) {
  return parts.reduce((n, p) => n + p.mass_g * p.qty, 0)
}

export function faceLabel(f: FaceRef) {
  const kind = f.type === 'bspline' ? 'freeform' : f.type
  return `${f.part} · face ${f.index} · ${kind}${f.radius ? ` r${+f.radius.toFixed(2)}` : ''} · ${f.area < 100 ? f.area.toFixed(1) : Math.round(f.area)} mm²`
}

/** Which of the user's models answers the next message. */
export function ModelPicker() {
  const ws = useWorkspace()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  if (ws.models && ws.models.length === 0)
    return (
      <a className="composer-model link" href="#/settings">
        Add a model to start →
      </a>
    )
  return (
    <div className="menu-anchor" ref={ref}>
      <button type="button" className="composer-model model-pick" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {ws.model?.label ?? '…'} <Icon name="chevron" size={11} />
      </button>
      {open && (
        <div className="menu menu--left menu--up" role="menu">
          <div className="menu-label">Model for the next message</div>
          {ws.models?.map((m) => (
            <button
              key={m.id}
              role="menuitemradio"
              aria-checked={ws.model?.id === m.id}
              onClick={() => {
                ws.setModelId(m.id)
                setOpen(false)
              }}
            >
              {m.label} <span>{ws.model?.id === m.id ? '●' : m.model}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <a role="menuitem" className="menu-link" href="#/settings">
            Manage models…
          </a>
        </div>
      )}
    </div>
  )
}
