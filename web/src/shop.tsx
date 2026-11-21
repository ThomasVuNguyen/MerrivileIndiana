import { useCallback, useEffect, useRef, useState } from 'react'
import type { Attachment, ChatEntry, ModelInfo, ServerEvent, ShopItem, ShopTool, Tier } from '../shared/protocol'
import { api } from './api'
import { TierMark, TIER_LABEL, TopBar } from './paper'
import { plainFirst } from './prose'
import { ChatInput, Icon, Thread } from './ui'

/** The shop's live state: items, tools and the shop chat, over one socket. */
function useShop() {
  const [items, setItems] = useState<ShopItem[]>([])
  const [tools, setTools] = useState<ShopTool[]>([])
  const [chat, setChat] = useState<ChatEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const socket = useRef<WebSocket | null>(null)

  useEffect(() => {
    let closed = false
    let retry = 0
    let timer: number | undefined
    const connect = () => {
      const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/shop/socket`)
      socket.current = sock
      sock.onopen = () => (retry = 0)
      sock.onclose = () => {
        if (!closed) timer = window.setTimeout(connect, Math.min(8000, 500 * 2 ** retry++))
      }
      sock.onmessage = (e) => {
        const ev = JSON.parse(e.data) as ServerEvent
        if (ev.type === 'shop-snapshot') {
          setItems(ev.items)
          setTools(ev.tools)
          setChat(ev.chat)
          setBusy(ev.running)
          setReady(true)
        } else if (ev.type === 'shop') {
          setItems(ev.items)
          setTools(ev.tools)
        } else if (ev.type === 'chat') {
          setChat((c) => {
            const next = [...c]
            next[ev.index] = ev.entry
            return next
          })
        } else if (ev.type === 'text') {
          setChat((c) => c.map((x, i) => (i === ev.index ? { ...x, text: x.text + ev.delta } : x)))
        } else if (ev.type === 'call') {
          setChat((c) =>
            c.map((x, i) => {
              if (i !== ev.index || x.role !== 'ai') return x
              const at = x.calls.findIndex((k) => k.id === ev.call.id)
              return { ...x, calls: at < 0 ? [...x.calls, ev.call] : x.calls.map((k, j) => (j === at ? ev.call : k)) }
            }),
          )
        } else if (ev.type === 'notes') {
          setChat((c) => c.map((x, i) => (i === ev.index && x.role === 'ai' ? { ...x, notes: ev.notes } : x)))
        } else if (ev.type === 'running') setBusy(ev.running)
      }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(timer)
      socket.current?.close()
    }
  }, [])

  const send = useCallback((text: string, images: Attachment[]) => socket.current?.send(JSON.stringify({ type: 'send', text, images })), [])
  const stop = useCallback(() => socket.current?.send(JSON.stringify({ type: 'stop' })), [])
  const toggleNote = useCallback((index: number, changeId: string) => socket.current?.send(JSON.stringify({ type: 'undo', index, changeId })), [])
  // Quick edits go over REST; the socket brings back the new state.
  const patchItem = useCallback((id: string, patch: Partial<ShopItem> & { qtyDelta?: number }) => {
    setItems((all) => all.map((i) => (i.id === id ? { ...i, ...patch, qty: patch.qtyDelta !== undefined ? Math.max(0, (i.qty ?? 0) + patch.qtyDelta) : (patch.qty ?? i.qty) } : i)))
    return fetch(`/api/shop/items/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
  }, [])
  const removeItem = useCallback((id: string) => fetch(`/api/shop/items/${id}`, { method: 'DELETE' }), [])
  const setHave = useCallback((id: string, have: boolean) => {
    setTools((all) => all.map((t) => (t.id === id ? { ...t, have } : t)))
    return fetch(`/api/shop/tools/${id}`, { method: 'PATCH', body: JSON.stringify({ have }) })
  }, [])
  return { items, tools, chat, busy, ready, send, stop, toggleNote, patchItem, removeItem, setHave }
}

type Shop = ReturnType<typeof useShop>

const isOut = (i: ShopItem) => i.qty === 0
const isLow = (i: ShopItem) => !!i.full && i.qty !== undefined && i.qty > 0 && i.qty / i.full < 0.2
const level = (i: ShopItem) => (i.unit === 'kit' ? 0.6 : i.qty === undefined ? null : i.full ? Math.min(1, i.qty / i.full) : 1)
const qtyText = (i: ShopItem) => (i.unit === 'kit' ? 'kit' : i.qty === undefined ? (i.tier === 'on-hand' ? '—' : (i.price ?? '—')) : i.qty === 0 ? 'out' : String(i.qty))
const qtyClass = (i: ShopItem) => (isOut(i) ? ' q-out' : i.qty === undefined && i.tier !== 'on-hand' ? ' q-price' : '')

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) ?? fallback
  } catch {
    return fallback
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private windows: the preference just doesn't stick.
  }
}

export function ShopPage() {
  const shop = useShop()
  const [tab, setTab] = useState<'hardware' | 'tools'>(location.hash.includes('tools') ? 'tools' : 'hardware')
  const [mode, setModeState] = useState(() => readPref<'drawer' | 'restock'>('merrivile:shop-mode', 'drawer'))
  const [pictures, setPicturesState] = useState(() => readPref('merrivile:shop-pictures', 'on') === 'on')
  const [open, setOpen] = useState<string | null>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const setMode = (m: 'drawer' | 'restock') => (setModeState(m), writePref('merrivile:shop-mode', m))
  const setPictures = (p: boolean) => (setPicturesState(p), writePref('merrivile:shop-pictures', p ? 'on' : 'off'))
  const ask = (prefill?: string) => {
    setChatOpen(true)
    window.setTimeout(() => {
      const el = input.current
      if (!el) return
      if (prefill && !el.value) {
        // Set through the native setter so React sees the change.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, prefill)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      el.focus()
    }, 50)
  }
  const item = shop.items.find((i) => i.id === open) ?? null

  return (
    <div className="projects shop">
      <TopBar active="shop" />
      <section className="shop-body">
        <div className="shop-head">
          <h1>Shop</h1>
          <div className="seg" role="tablist">
            <button role="tab" aria-checked={tab === 'hardware'} onClick={() => setTab('hardware')}>
              Hardware
            </button>
            <button role="tab" aria-checked={tab === 'tools'} onClick={() => setTab('tools')}>
              Tools
            </button>
          </div>
          {tab === 'hardware' && shop.items.length > 0 && (
            <div className="shop-opts">
              <button className="link" onClick={() => setPictures(!pictures)}>
                pictures {pictures ? 'on' : 'off'}
              </button>
              <div className="seg seg--small" role="radiogroup" aria-label="Layout">
                <button role="radio" aria-checked={mode === 'drawer'} onClick={() => setMode('drawer')}>
                  Drawer
                </button>
                <button role="radio" aria-checked={mode === 'restock'} onClick={() => setMode('restock')}>
                  Restock
                </button>
              </div>
            </div>
          )}
        </div>
        {tab === 'hardware' ? (
          <>
            {shop.items.length > 0 && <Glance items={shop.items} onReorder={(i) => (i.link ? window.open(i.link, '_blank') : ask(`Reorder ${i.name} ${i.kind.toLowerCase()}: `))} />}
            {shop.ready && shop.items.length === 0 && (
              <p className="shop-empty">
                Nothing here yet. Send a photo of your bins or kits, a screenshot of an Amazon order, or a product link, and the AI fills this in.
              </p>
            )}
            {mode === 'drawer' || !shop.items.length ? (
              <Drawer shop={shop} pictures={pictures} onAdd={() => ask()} onOpen={setOpen} />
            ) : (
              <Restock shop={shop} pictures={pictures} onAdd={() => ask()} onOpen={setOpen} />
            )}
          </>
        ) : (
          <ToolGrid shop={shop} onAdd={() => ask('I have a ')} />
        )}
      </section>
      {item && <ItemSheet key={item.id} item={item} shop={shop} onClose={() => setOpen(null)} />}
      <ShopDock shop={shop} open={chatOpen} setOpen={setChatOpen} inputRef={input} />
    </div>
  )
}

/** One glance: where things come from, and what needs a reorder. */
function Glance({ items, onReorder }: { items: ShopItem[]; onReorder: (i: ShopItem) => void }) {
  const n = (t: Tier) => items.filter((i) => i.tier === t).length
  const attention = items.filter((i) => isOut(i) || isLow(i))
  return (
    <div className="glance">
      <div className="glance-bar" aria-hidden>
        {(['on-hand', 'prime', 'order'] as const).map((t) => n(t) > 0 && <span key={t} className={`tier-fill--${t}`} style={{ flex: n(t) }} />)}
      </div>
      <div className="glance-legend">
        {(['on-hand', 'prime', 'order'] as const).map((t) => (
          <span key={t}>
            <TierMark tier={t} />
            <strong>{n(t)}</strong> {TIER_LABEL[t]}
          </span>
        ))}
        <span className="glance-alerts">
          {attention.map((i) => (
            <span key={i.id} className={isOut(i) ? 'q-out' : 'q-low'}>
              {i.name} {i.kind.toLowerCase()} {isOut(i) ? 'out' : 'low'}
              <button className="link" onClick={() => onReorder(i)}>
                reorder
              </button>
            </span>
          ))}
        </span>
      </div>
    </div>
  )
}

function AddTile({ row, onClick }: { row?: boolean; onClick: () => void }) {
  return (
    <button className={`add-tile${row ? ' add-tile--row' : ''}`} onClick={onClick}>
      <span className="add-plus">+</span>
      <span>Add</span>
      <span className="faint">paste a link, a screenshot or a photo</span>
    </button>
  )
}

function Level({ item }: { item: ShopItem }) {
  const l = level(item)
  if (l === null) return <div className="level level--none" />
  return (
    <div className="level">
      <span style={{ width: `${l * 100}%` }} />
    </div>
  )
}

/** The item's picture, or its size set in type. */
function Visual({ item, pictures, small }: { item: ShopItem; pictures: boolean; small?: boolean }) {
  return pictures && item.image ? <img className="hw-img" src={item.image} alt="" /> : <span className={`hw-type${small ? ' hw-type--small' : ''}`}>{item.name}</span>
}

// A parts organiser seen from above: each bin is a tile.
function Drawer({ shop, pictures, onAdd, onOpen }: { shop: Shop; pictures: boolean; onAdd: () => void; onOpen: (id: string) => void }) {
  return (
    <div className="drawer">
      <AddTile onClick={onAdd} />
      {shop.items.map((i) => {
        const pic = pictures && !!i.image
        return (
          <div key={i.id} className={`bin${isOut(i) ? ' is-out' : ''}`} title={[i.kind, i.detail].filter(Boolean).join(' · ')} onClick={() => onOpen(i.id)}>
            <div className="bin-top">
              <span>{i.tier === 'on-hand' ? (i.bin ?? '') : TIER_LABEL[i.tier]}</span>
              <TierMark tier={i.tier} />
            </div>
            <div className="bin-visual">
              <Visual item={i} pictures={pictures} />
            </div>
            <div className="bin-name">
              {pic && <strong>{i.name}</strong>}
              <span>{i.kind}</span>
            </div>
            <div className="bin-foot">
              <span className={`bin-qty${qtyClass(i)}${isLow(i) ? ' q-low' : ''}`}>{qtyText(i)}</span>
            </div>
            <Level item={i} />
            {i.qty !== undefined && i.unit !== 'kit' && (
              <div className="bin-step" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => shop.patchItem(i.id, { qtyDelta: -1 })} aria-label={`One less ${i.name}`}>
                  −
                </button>
                <button onClick={() => shop.patchItem(i.id, { qtyDelta: 1 })} aria-label={`One more ${i.name}`}>
                  +
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// For updating a lot of counts after a build session.
function Restock({ shop, pictures, onAdd, onOpen }: { shop: Shop; pictures: boolean; onAdd: () => void; onOpen: (id: string) => void }) {
  return (
    <div className="counter">
      <AddTile row onClick={onAdd} />
      {shop.items.map((i) => (
        <div key={i.id} className={`count-row${isOut(i) ? ' is-out' : ''}${pictures ? '' : ' count-row--bare'}`}>
          {pictures && (
            <span className="count-visual" onClick={() => onOpen(i.id)}>
              <Visual item={i} pictures small />
            </span>
          )}
          <button className="count-name" onClick={() => onOpen(i.id)}>
            {i.name} <span>{i.kind.toLowerCase()}</span>
          </button>
          <TierMark tier={i.tier} />
          <Level item={i} />
          {i.unit === 'kit' || i.qty === undefined ? (
            <span className="count-static">
              {i.qty === undefined && i.unit !== 'kit' && i.tier === 'on-hand' ? (
                <button className="link" onClick={() => onOpen(i.id)}>
                  set count
                </button>
              ) : (
                qtyText(i)
              )}
            </span>
          ) : (
            <div className="stepper">
              <button onClick={() => shop.patchItem(i.id, { qtyDelta: -10 })}>−10</button>
              <button onClick={() => shop.patchItem(i.id, { qtyDelta: -1 })}>−</button>
              <span className={qtyClass(i)}>{qtyText(i)}</span>
              <button onClick={() => shop.patchItem(i.id, { qtyDelta: 1 })}>+</button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Everything about one item, editable in place. */
function ItemSheet({ item, shop, onClose }: { item: ShopItem; shop: Shop; onClose: () => void }) {
  const [qty, setQty] = useState(item.qty === undefined ? '' : String(item.qty))
  const [bin, setBin] = useState(item.bin ?? '')
  useEffect(() => {
    setQty(item.qty === undefined ? '' : String(item.qty))
  }, [item.qty])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const saveQty = () => {
    const n = qty.trim() === '' ? undefined : Number(qty)
    if (n !== undefined && Number.isFinite(n) && n >= 0 && n !== item.qty) shop.patchItem(item.id, { qty: Math.round(n) })
  }
  return (
    <aside className="paper-card item-sheet" aria-label={`${item.name} ${item.kind}`}>
      <button className="item-close" onClick={onClose} aria-label="Close">
        <Icon name="close" size={14} />
      </button>
      <div className="item-visual">{item.image ? <img className="hw-img" src={item.image} alt="" /> : <span className="hw-type">{item.name}</span>}</div>
      <div className="eyebrow">{item.category}</div>
      <h2>
        {item.name} <span>{item.kind.toLowerCase()}</span>
      </h2>
      {item.detail && <p className="muted small">{item.detail}</p>}
      <div className="item-tiers" role="radiogroup" aria-label="Where it comes from">
        {(['on-hand', 'prime', 'order'] as const).map((t) => (
          <button key={t} role="radio" aria-checked={item.tier === t} className={item.tier === t ? 'is-on' : ''} onClick={() => shop.patchItem(item.id, { tier: t })}>
            <TierMark tier={t} /> {TIER_LABEL[t]}
          </button>
        ))}
      </div>
      <dl className="props">
        <div>
          <dt>Count</dt>
          <dd>
            <input className="inline-input" value={qty} placeholder="unknown" inputMode="numeric" onChange={(e) => setQty(e.target.value)} onBlur={saveQty} onKeyDown={(e) => e.key === 'Enter' && saveQty()} />
          </dd>
        </div>
        <div>
          <dt>Bin</dt>
          <dd>
            <input
              className="inline-input"
              value={bin}
              placeholder="—"
              onChange={(e) => setBin(e.target.value)}
              onBlur={() => bin !== (item.bin ?? '') && shop.patchItem(item.id, { bin })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </dd>
        </div>
        {item.price && (
          <div>
            <dt>Price</dt>
            <dd>{item.price}</dd>
          </div>
        )}
        {item.notes && (
          <div>
            <dt>Notes</dt>
            <dd>{item.notes}</dd>
          </div>
        )}
      </dl>
      <div className="item-actions">
        {item.link && (
          <a className="link" href={item.link} target="_blank" rel="noreferrer">
            Open link ↗
          </a>
        )}
        <button
          className="link item-delete"
          onClick={() => {
            if (confirm(`Remove ${item.name} ${item.kind.toLowerCase()} from the shop?`)) {
              shop.removeItem(item.id)
              onClose()
            }
          }}
        >
          Remove
        </button>
      </div>
    </aside>
  )
}

// Line drawings in the Paper style, 32 × 32, picked by name.
const TOOL_ICONS: [RegExp, string][] = [
  [/printer|bambu|prusa|ender|voron|3d/i, 'M6 5h20v22H6zM6 10h20M11 10v6h10v-6M13 16v3h6v-3M9 24h14'],
  [/drill press/i, 'M8 27h16M16 27V5M10 5h12v7H10zM16 12v6M14 18h4v3h-4M6 24h20'],
  [/drill|driver/i, 'M4 11h15v6H4zM19 12h4v4h-4M23 14h6M9 17l-2 9h6l1-9'],
  [/tap|die/i, 'M16 3v10M12 13h8v4h-8zM14 17v12h4V17M14 20h4M14 23h4M14 26h4'],
  [/jigsaw|scroll/i, 'M6 8h18v8H6zM10 16v4h6v-4M13 20v8M20 8V5'],
  [/saw/i, 'M4 10h20l4 4-4 4H4zM6 18l2 3 2-3 2 3 2-3 2 3 2-3 2 3 2-3'],
  [/hex|allen|key|wrench|spanner/i, 'M8 6l6 3v17M8 6v4l6 3M20 26V9l6-3v4l-6 3'],
  [/solder|iron|insert/i, 'M4 26l10-10M14 16l8-8 4 4-8 8zM22 8l3-3M20 14l-4 4'],
  [/laser|sendcutsend|cut|oshcut/i, 'M16 3v9M12 12h8l-4 6zM16 18v4M6 26h20M10 22l-2 4M22 22l2 4'],
  [/lathe/i, 'M4 22h24M6 10h6v12H6zM12 14h10v4H12zM22 13l4 3-4 3'],
  [/mill|cnc|router/i, 'M10 4h12v8H10zM16 12v8M13 20h6M6 26h20M8 26v-3h16v3'],
  [/weld/i, 'M6 26l10-10M16 16l6-6M22 10l2-6 2 2-4 4M18 22h8M20 18l2 4 2-4'],
  [/caliper|measure|gauge/i, 'M4 8h24v5H4zM8 13v12l3-3V13M22 13v6'],
]
const DEFAULT_TOOL = 'M7 25 19 13M17 7a5 5 0 0 0 6 6l3 3-4 4-3-3a5 5 0 0 0-6-6zM5 27l4-4'

function ToolGrid({ shop, onAdd }: { shop: Shop; onAdd: () => void }) {
  return (
    <>
      <p className="tool-hint muted">Tap a tool to say whether you have it. The AI only plans work your shop can do.</p>
      <div className="tools">
        {shop.tools.map((t) => (
          <button key={t.id} className={`tool${t.have ? '' : ' is-missing'}`} onClick={() => shop.setHave(t.id, !t.have)} title={t.have ? "Tap if you don't have it" : 'Tap if you have it'}>
            <svg viewBox="0 0 32 32" width="38" height="38" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d={TOOL_ICONS.find(([re]) => re.test(t.name))?.[1] ?? DEFAULT_TOOL} />
            </svg>
            <strong>{t.name}</strong>
            <span>{t.have ? t.can || t.kind : "don't have"}</span>
          </button>
        ))}
        <button className="tool tool--add" onClick={onAdd}>
          <span className="add-plus">+</span>
          <strong>Add a tool</strong>
          <span>or say what you don't have</span>
        </button>
      </div>
    </>
  )
}

function ShopDock({ shop, open, setOpen, inputRef }: { shop: Shop; open: boolean; setOpen: (o: boolean) => void; inputRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const [model, setModel] = useState<ModelInfo | null>(null)
  useEffect(() => {
    api.models().then((m) => setModel(m.find((x) => x.isDefault) ?? m[0] ?? null), () => {})
  }, [])
  const last = [...shop.chat].reverse().find((m) => m.role === 'ai')
  const running = last?.role === 'ai' ? last.calls.find((c) => c.state === 'running') : undefined
  return (
    <div className={`dock shop-dock${open ? ' is-expanded' : ''}`}>
      {open ? (
        <div className="dock-thread">
          <Thread messages={shop.chat} busy={shop.busy} compact onToggleNote={shop.toggleNote} />
        </div>
      ) : (
        last && (
          <div className="last-reply" onClick={() => setOpen(true)}>
            {shop.busy && !last.text ? <span className="muted">{running ? `${running.tool} · ${running.detail}` : 'thinking…'}</span> : plainFirst(last.text)}
            {last.role === 'ai' && last.notes && last.notes.length > 0 && (
              <span className="last-calls">
                {last.notes.length} {last.notes.length === 1 ? 'change' : 'changes'}
              </span>
            )}
          </div>
        )
      )}
      <div className="dock-bar">
        <button className="dock-toggle" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse chat' : 'Expand chat'}>
          <Icon name="chevron" size={14} />
        </button>
        <ChatInput
          textRef={inputRef}
          placeholder="Paste an Amazon link, a screenshot or a photo of your bins, or say what you used up…"
          footer={
            model ? (
              <span className="composer-model">{model.label}</span>
            ) : (
              <a className="composer-model link" href="#/settings">
                Add a model to start →
              </a>
            )
          }
          busy={shop.busy}
          canStop={shop.busy}
          onStop={shop.stop}
          onSend={(text, images) => {
            setOpen(true)
            shop.send(text, images)
          }}
        />
      </div>
    </div>
  )
}

