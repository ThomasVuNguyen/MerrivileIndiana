import { useEffect, useRef, useState } from 'react'
import type { ThreadInfo } from '../shared/protocol'
import { chatNext } from './flags'
import { Icon } from './ui'

/** The chat each place (the Shop, a project) last showed, so a reload comes back to it. */
export const lastThread = {
  get: (scope: string) => {
    try {
      return localStorage.getItem(`merrivile:thread:${scope}`) ?? ''
    } catch {
      return ''
    }
  },
  set: (scope: string, id: string) => {
    try {
      if (id) localStorage.setItem(`merrivile:thread:${scope}`, id)
      else localStorage.removeItem(`merrivile:thread:${scope}`)
    } catch {
      // Private windows: the newest chat opens instead.
    }
  },
}

/** Socket state for the chats of one place. */
export type Threads = {
  threads: ThreadInfo[]
  thread: string
  /** The chat the AI is working in, if any. */
  runningIn: string | null
  open: (id: string) => void
  remove: (id: string) => void
}

/** The current chat's name, a list of the others, and a new chat. Sits on top of the open chat. */
export function ThreadBar({ threads, side, onSide }: { threads: Threads; side?: boolean; onSide?: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const current = threads.threads.find((t) => t.id === threads.thread)
  const busyElsewhere = threads.runningIn && threads.runningIn !== threads.thread ? threads.threads.find((t) => t.id === threads.runningIn) : null

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="thread-bar" ref={box}>
      <button className="thread-pick" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Chats">
        <span className="thread-title">{current?.title ?? 'New chat'}</span>
        {threads.threads.length > 0 && <span className="faint">{threads.threads.length === 1 ? '1 chat' : `${threads.threads.length} chats`} ▾</span>}
      </button>
      {busyElsewhere && <span className="thread-busy">working in “{busyElsewhere.title}”</span>}
      {chatNext ? (
        <span className="thread-icons">
          <button className="thread-icon" disabled={!threads.thread} aria-label="New chat" title="New chat" onClick={() => threads.open('')}>
            <Icon name="compose" size={14} />
          </button>
          {onSide && (
            <button className={`thread-icon${side ? ' is-on' : ''}`} aria-label={side ? 'Float the chat' : 'Open as a side panel'} title={side ? 'Float the chat' : 'Open as a side panel'} onClick={onSide}>
              <Icon name="panel" size={14} />
            </button>
          )}
        </span>
      ) : (
        <button
          className="link thread-new"
          disabled={!threads.thread}
          onClick={() => {
            setOpen(false)
            threads.open('')
          }}
        >
          + New chat
        </button>
      )}
      {open && (
        <ul className="thread-list">
          {threads.threads.map((t) => (
            <li key={t.id} className={t.id === threads.thread ? 'is-on' : ''}>
              <button
                className="thread-item"
                onClick={() => {
                  setOpen(false)
                  threads.open(t.id)
                }}
              >
                <span className="thread-item-title">
                  {t.id === threads.runningIn && <i className="thread-dot" aria-label="working" />}
                  {t.title}
                </span>
                <span className="faint">{ago(t.updatedAt)}</span>
              </button>
              <button
                className="thread-del"
                aria-label={`Delete ${t.title}`}
                disabled={t.id === threads.runningIn}
                onClick={() => confirm(`Delete the chat “${t.title}”? What it changed in the shop, memory and parts stays.`) && threads.remove(t.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ago(at: number) {
  const s = (Date.now() - at) / 1000
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)} m`
  if (s < 86400) return `${Math.floor(s / 3600)} h`
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Whether the chat sits as a full-height side panel instead of floating; remembered per browser. */
export function useSidePanel(): [boolean, () => void] {
  const [side, setSide] = useState(() => {
    try {
      return chatNext && localStorage.getItem('merrivile:chat-side') === '1'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setSide((s) => {
      try {
        localStorage.setItem('merrivile:chat-side', s ? '0' : '1')
      } catch {
        // fine
      }
      return !s
    })
  return [side, toggle]
}
