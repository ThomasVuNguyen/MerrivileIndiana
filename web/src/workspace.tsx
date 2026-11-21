import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BufferAttribute, BufferGeometry, Mesh, MeshStandardMaterial } from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import occtimportjs from 'occt-import-js'
import occtWasm from 'occt-import-js/dist/occt-import-js.wasm?url'
import { useLoader } from '@react-three/fiber'
import type { Attachment, FaceRef, ModelInfo, ServerEvent, ThreadInfo } from '../shared/protocol'
import { api, pendingPrompt, socketUrl } from './api'
import { BrepLoader } from './brep'
import { loadAssembly, partFromDoc, TRANSCRIPT } from './data'
import { lastThread } from './threads'
import type { Threads } from './threads'
import type { Appearance, Assembly, Instance, Message, Part, ToolCall } from './data'

type Workspace = ReturnType<typeof useWorkspaceState>

const Ctx = createContext<Workspace | null>(null)

export function useWorkspace() {
  const ws = useContext(Ctx)
  if (!ws) throw new Error('useWorkspace outside provider')
  return ws
}

/** The built-in concept assembly; every other project id is a live project. */
export const DEMO = 'actuator'

export function WorkspaceProvider({ projectId, children }: { projectId: string; children: ReactNode }) {
  const ws = useWorkspaceState(projectId)
  return <Ctx.Provider value={ws}>{children}</Ctx.Provider>
}

const COLOR_WORDS: Record<string, string> = {
  red: '#c8433a',
  orange: '#e08a55',
  blue: '#2f6fd6',
  green: '#2f8a4c',
  black: '#2a2d31',
  white: '#f2f2ef',
  gold: '#c8a24a',
  grey: '#9ea2a8',
  gray: '#9ea2a8',
  purple: '#7a4fc2',
}

const EMPTY: Assembly = {
  name: '',
  parts: [],
  instances: [],
  groups: [],
  gears: { sun: 1, planet: 1, ring: 0 },
  checks: { pose_deg: 0, interferences: [] },
}

function useWorkspaceState(projectId: string) {
  const live = projectId !== DEMO
  const [projectName, setProjectName] = useState(live ? '' : 'QDD Actuator 110')
  const [asm, setAsm] = useState<Assembly>(EMPTY)
  const [look, setLook] = useState<Record<string, Appearance>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [view, setView] = useState<'assembly' | 'part'>('assembly')
  const [group, setGroup] = useState<string>('All')
  const [exploded, setExploded] = useState(false)
  const [section, setSection] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [fitOpen, setFitOpen] = useState(false)
  const [clash, setClash] = useState<number | null>(null)
  const [messages, setMessages] = useState<Message[]>(live ? [] : TRANSCRIPT)
  const [faces, setFaces] = useState<FaceRef[]>([])
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [modelId, setModelIdState] = useState<string | null>(() => localStorage.getItem('merrivile:model'))
  const [connected, setConnected] = useState(!live)
  const socket = useRef<WebSocket | null>(null)
  const [busy, setBusy] = useState(false)
  const [threadList, setThreadList] = useState<ThreadInfo[]>([])
  const [thread, setThread] = useState('')
  const [runningIn, setRunningIn] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [fitNonce, setFitNonce] = useState(0)
  // Rotor angle in degrees. Lives in a ref so the viewer can animate it
  // every frame without re-rendering the page.
  const drive = useRef(0)
  const toastTimer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (live) return
    loadAssembly().then((a) => {
      setAsm(a)
      setLook(Object.fromEntries(a.parts.map((p) => [p.id, { color: p.color, opacity: 1, visible: true }])))
    })
  }, [live])

  // Live projects: the project's Durable Object streams parts and chat over a socket.
  useEffect(() => {
    if (!live) return
    let closed = false
    let retry = 0
    let timer: number | undefined
    const connect = () => {
      const sock = new WebSocket(`${socketUrl(projectId)}?thread=${lastThread.get(projectId)}`)
      socket.current = sock
      sock.onopen = () => {
        retry = 0
        setConnected(true)
      }
      sock.onclose = () => {
        setConnected(false)
        if (!closed) timer = window.setTimeout(connect, Math.min(8000, 500 * 2 ** retry++))
      }
      sock.onmessage = (e) => onEvent(JSON.parse(e.data) as ServerEvent)
    }
    const onEvent = (ev: ServerEvent) => {
      if (ev.type === 'snapshot') {
        setProjectName(ev.project.name)
        const parts = ev.parts.map(partFromDoc)
        setAsm({ ...EMPTY, name: ev.project.name, parts })
        setLook(Object.fromEntries(parts.map((p) => [p.id, { color: p.color, opacity: 1, visible: true }])))
        setMessages(ev.chat)
        setBusy(ev.running)
        setThreadList(ev.threads)
        setThread(ev.thread)
        const newest = [...ev.parts].sort((a, b) => b.updatedAt - a.updatedAt)[0]
        setSelected((s) => s ?? newest?.id ?? null)
        setView('part')
        const prompt = pendingPrompt.take(projectId)
        if (prompt) socket.current?.send(JSON.stringify({ type: 'send', text: prompt.text, images: prompt.images, modelId: localStorage.getItem('merrivile:model') ?? undefined }))
      } else if (ev.type === 'thread') {
        setThread(ev.thread)
        setMessages(ev.chat)
        lastThread.set(projectId, ev.thread)
      } else if (ev.type === 'threads') {
        setThreadList(ev.threads)
      } else if (ev.type === 'chat') {
        setMessages((m) => {
          const next = [...m]
          next[ev.index] = ev.entry
          return next
        })
      } else if (ev.type === 'text') {
        setMessages((m) => m.map((x, i) => (i === ev.index ? { ...x, text: x.text + ev.delta } : x)))
      } else if (ev.type === 'call') {
        setMessages((m) =>
          m.map((x, i) => {
            if (i !== ev.index || x.role !== 'ai') return x
            const calls = x.calls ?? []
            const at = calls.findIndex((c) => c.id === ev.call.id)
            return { ...x, calls: at < 0 ? [...calls, ev.call] : calls.map((c, j) => (j === at ? ev.call : c)) }
          }),
        )
      } else if (ev.type === 'part') {
        const part = partFromDoc(ev.part)
        if (ev.part.files) useLoader.preload(BrepLoader, ev.part.files.mesh)
        setAsm((a) => {
          const prev = a.parts.find((p) => p.id === part.id)
          return { ...a, parts: prev ? a.parts.map((p) => (p.id === part.id ? part : p)) : [...a.parts, part] }
        })
        setLook((l) => ({ ...l, [part.id]: l[part.id] && l[part.id].color === part.color ? l[part.id] : { color: part.color, opacity: l[part.id]?.opacity ?? 1, visible: true } }))
        // Follow the AI to the part it just built.
        if (ev.part.status === 'ok') {
          setSelected(part.id)
          setView('part')
          setFaces((f) => f.filter((x) => x.part !== part.id))
        }
      } else if (ev.type === 'notes') {
        setMessages((m) => m.map((x, i) => (i === ev.index && x.role === 'ai' ? { ...x, notes: ev.notes } : x)))
      } else if (ev.type === 'part_removed') {
        setAsm((a) => ({ ...a, parts: a.parts.filter((p) => p.id !== ev.id) }))
        setSelected((s) => (s === ev.id ? null : s))
      } else if (ev.type === 'running') {
        setBusy(ev.running)
        setRunningIn(ev.running ? (ev.thread ?? null) : null)
      }
    }
    connect()
    return () => {
      closed = true
      window.clearTimeout(timer)
      socket.current?.close()
    }
  }, [live, projectId])

  // A part source chip in the chat selects that part.
  useEffect(() => {
    const show = (e: Event) => {
      setSelected((e as CustomEvent<string>).detail)
      setView('part')
    }
    window.addEventListener('merrivile:part', show)
    return () => window.removeEventListener('merrivile:part', show)
  }, [])

  const refreshModels = useCallback(() => {
    api.models().then(setModels, () => setModels([]))
  }, [])
  useEffect(() => {
    if (live) refreshModels()
  }, [live, refreshModels])

  const model = models?.find((m) => m.id === modelId) ?? models?.find((m) => m.isDefault) ?? null
  const setModelId = useCallback((id: string) => {
    localStorage.setItem('merrivile:model', id)
    setModelIdState(id)
  }, [])

  const parts = asm.parts

  const notify = useCallback((text: string) => {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  const setAppearance = useCallback((id: string, patch: Partial<Appearance>) => {
    setLook((l) => ({ ...l, [id]: { ...l[id], ...patch } }))
  }, [])

  const groups = useMemo(
    () =>
      asm.groups.map((name) => ({
        name,
        parts: parts.filter((p) => p.group === name),
        count: parts.filter((p) => p.group === name).length,
      })),
    [asm.groups, parts],
  )

  const selectedPart = parts.find((p) => p.id === selected) ?? null

  // What the viewer draws: one part on its own, or the (filtered) assembly.
  const visibleInstances = useMemo<Instance[]>(() => {
    if (view === 'part' && selectedPart) {
      return [{ id: `${selectedPart.id}-solo`, part: selectedPart.id, group: selectedPart.group, pos: [0, 0, 0], rot: 0, motion: 'fixed' }]
    }
    return asm.instances.filter((i) => group === 'All' || i.group === group)
  }, [view, selectedPart, asm.instances, group])

  const toggleFace = useCallback((face: FaceRef, add: boolean) => {
    setFaces((f) => {
      const on = f.some((x) => x.part === face.part && x.index === face.index)
      if (on) return f.filter((x) => !(x.part === face.part && x.index === face.index))
      return add ? [...f, face] : [face]
    })
  }, [])

  const visibleParts = useMemo(() => parts.filter((p) => group === 'All' || p.group === group), [parts, group])

  const activeClash = clash !== null ? asm.checks.interferences[clash] ?? null : null

  const fit = useCallback(() => setFitNonce((n) => n + 1), [])

  const openPart = useCallback(
    (id?: string) => {
      const target = id ?? selected ?? parts[0]?.id
      if (!target) return
      setSelected(target)
      setView('part')
      setClash(null)
    },
    [selected, parts],
  )

  const openAssembly = useCallback((name: string) => {
    setGroup(name)
    setView('assembly')
    setClash(null)
  }, [])

  const importStep = useCallback(
    async (file: File) => {
      if (live) {
        // The server keeps the file and makes it a part; progress arrives over the socket.
        await api.importStep(projectId, file, thread).catch((err: Error) => notify(err.message))
        return
      }
      const id = `import-${Date.now()}`
      setMessages((m) => [
        ...m,
        { role: 'user', text: `Imported ${file.name}` },
        { role: 'ai', text: '', calls: [{ tool: 'import', detail: `${file.name} · reading STEP`, state: 'running' }] },
      ])
      try {
        const occt = await occtimportjs({ locateFile: () => occtWasm })
        const result = occt.ReadStepFile(new Uint8Array(await file.arrayBuffer()), null)
        if (!result.success || result.meshes.length === 0) throw new Error('no solids found')
        const geos = result.meshes.map((m: OcctMesh) => {
          const g = new BufferGeometry()
          g.setAttribute('position', new BufferAttribute(new Float32Array(m.attributes.position.array), 3))
          if (m.attributes.normal)
            g.setAttribute('normal', new BufferAttribute(new Float32Array(m.attributes.normal.array), 3))
          g.setIndex(m.index.array)
          return g
        })
        const geometry = geos.length === 1 ? geos[0] : mergeAll(geos)
        geometry.computeBoundingBox()
        const bb = geometry.boundingBox!
        const name = file.name.replace(/\.(step|stp)$/i, '')
        const part: Part = {
          id,
          name,
          group: 'Imported',
          qty: 1,
          color: '#a23b72',
          material: 'Unassigned',
          volume_mm3: 0,
          mass_g: 0,
          bbox: [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z].map((v) => +v.toFixed(1)) as Part['bbox'],
          faces: result.meshes.reduce((n: number, m: OcctMesh) => n + (m.brep_faces?.length ?? 0), 0),
          geometry,
          source: 'step',
        }
        setAsm((a) => ({
          ...a,
          parts: [...a.parts, part],
          instances: [...a.instances, { id: `${id}-1`, part: id, group: 'Imported', pos: [0, 0, 0], rot: 0, motion: 'fixed' }],
          groups: a.groups.includes('Imported') ? a.groups : [...a.groups, 'Imported'],
        }))
        setAppearance(id, { color: part.color, opacity: 1, visible: true })
        setSelected(id)
        setMessages((m) => [
          ...m.slice(0, -1),
          {
            role: 'ai',
            text: `${name} is in the assembly at its file origin. Tell me where it should sit and I'll place it.`,
            calls: [{ tool: 'import', detail: `${file.name} · ${result.meshes.length} solid${result.meshes.length > 1 ? 's' : ''}`, state: 'done', ms: 420 }],
          },
        ])
      } catch (err) {
        setMessages((m) => [
          ...m.slice(0, -1),
          {
            role: 'ai',
            text: `Couldn't read ${file.name}: ${(err as Error).message}. Is it a STEP (AP203/AP214) file?`,
            calls: [{ tool: 'import', detail: `${file.name} · failed`, state: 'done' }],
          },
        ])
      }
    },
    [setAppearance, live, projectId, notify, thread],
  )

  const exportFile = useCallback(
    async (format: 'step' | 'stl', scope: 'part' | 'assembly', partId?: string) => {
      const part = scope === 'part' ? parts.find((p) => p.id === (partId ?? selected)) ?? null : null
      if (scope === 'part' && !part) return
      if (part?.live) {
        const url = part.live.files?.[format]
        if (!url) return notify(`${part.name} hasn't built yet`)
        const res = await fetch(url)
        download(await res.blob(), `${part.id}-v${part.live.version}.${format}`)
        return notify(`Exported ${part.id}-v${part.live.version}.${format}`)
      }
      if (live) return notify('Assemblies come next; export parts one at a time')
      if (part?.geometry) {
        if (format === 'step') return notify('STEP export of imported parts runs on the server')
        const stl = new STLExporter().parse(new Mesh(part.geometry, new MeshStandardMaterial()), { binary: true })
        return download(new Blob([stl as DataView<ArrayBuffer>]), `${part.id}.stl`)
      }
      const base = part ? part.id : 'actuator'
      const res = await fetch(`/models/${base}.${format}`)
      download(await res.blob(), `${base}.${format}`)
      notify(`Exported ${base}.${format}`)
    },
    [parts, selected, notify, live],
  )

  const stop = useCallback(() => socket.current?.send(JSON.stringify({ type: 'stop' })), [])
  const toggleNote = useCallback((index: number, changeId: string) => socket.current?.send(JSON.stringify({ type: 'undo', index, changeId })), [])
  const restore = useCallback((part: string, version: number) => socket.current?.send(JSON.stringify({ type: 'restore', part, version })), [])
  const threads: Threads = useMemo(
    () => ({
      threads: threadList,
      thread,
      runningIn,
      open: (id) => socket.current?.send(JSON.stringify({ type: 'open', thread: id })),
      remove: (id) => socket.current?.send(JSON.stringify({ type: 'delete-thread', thread: id })),
    }),
    [threadList, thread, runningIn],
  )

  // Stand-in for the OpenAI-compatible agent: handles appearance, view,
  // motion and fit commands locally so the concept can be driven from chat.
  const send = useCallback(
    (text: string, images: Attachment[] = []) => {
      const t = text.trim()
      if ((!t && !images.length) || busy) return
      if (live) {
        if (socket.current?.readyState !== WebSocket.OPEN) return notify('Reconnecting to the project…')
        socket.current.send(JSON.stringify({ type: 'send', text: t, faces, modelId: model?.id, images }))
        setFaces([])
        return
      }
      setMessages((m) => [...m, { role: 'user', text: t }])
      setBusy(true)
      const lower = t.toLowerCase()
      const words = (p: Part) => p.name.toLowerCase().split(' ').filter((w) => w.length > 3)
      const target =
        parts.find((p) => lower.includes(p.name.toLowerCase())) ??
        parts.find((p) => words(p).some((w) => lower.includes(w))) ??
        selectedPart
      const calls: ToolCall[] = []
      let reply = ''
      const color = Object.keys(COLOR_WORDS).find((c) => lower.includes(c))
      const n = asm.checks.interferences.length
      if (/fit|interfer|clash|collid/.test(lower)) {
        setView('assembly')
        setFitOpen(true)
        calls.push({ tool: 'check_fit', detail: `${asm.instances.length} instances · ${n} interference${n === 1 ? '' : 's'}`, state: 'done', ms: 1840 })
        reply = n
          ? `${n} interferences, all where gear teeth meet. The teeth are placeholder boxes, not involutes; want me to cut proper involute profiles?`
          : 'No interferences.'
      } else if (/spin|rotate|drive|run|move|animate/.test(lower)) {
        setView('assembly')
        setPlaying(!/stop|pause/.test(lower))
        calls.push({ tool: 'motion', detail: 'rotor revolute · ring fixed', state: 'done', ms: 10 })
        reply = /stop|pause/.test(lower) ? 'Stopped.' : 'Driving the rotor. The output turns once for every 3.57 rotor turns.'
      } else if (/explode/.test(lower)) {
        setView('assembly')
        setExploded(!/collapse|unexplode/.test(lower))
        calls.push({ tool: 'view', detail: 'exploded along motor axis', state: 'done', ms: 12 })
        reply = 'Exploded the assembly along the motor axis.'
      } else if (target && /show|open|review|look at|inspect/.test(lower)) {
        openPart(target.id)
        calls.push({ tool: 'view', detail: `${target.name} · part view`, state: 'done', ms: 8 })
        reply = `Here's the ${target.name.toLowerCase()} on its own. It's used ${target.qty} time${target.qty > 1 ? 's' : ''} in ${target.group}.`
      } else if (target && /transparent|see.?through|ghost/.test(lower)) {
        setAppearance(target.id, { opacity: 0.25 })
        calls.push({ tool: 'appearance', detail: `${target.name} · opacity 25%`, state: 'done', ms: 8 })
        reply = `${target.name} is now 25% opaque.`
      } else if (target && /hide/.test(lower)) {
        setAppearance(target.id, { visible: false })
        calls.push({ tool: 'appearance', detail: `${target.name} · hidden`, state: 'done', ms: 6 })
        reply = `Hid ${target.name}.`
      } else if (target && color) {
        setAppearance(target.id, { color: COLOR_WORDS[color] })
        calls.push({ tool: 'appearance', detail: `${target.name} · ${color}`, state: 'done', ms: 7 })
        reply = `${target.name} is ${color} now.`
      } else {
        calls.push({ tool: 'build123d', detail: target ? `${target.fn ?? 'part'}() · regenerating` : 'planning', state: 'done', ms: 1600 })
        reply =
          'In the full app this goes to the model, which edits the build123d source and rebuilds. Here I handle view commands: try "check fit", "spin it", "show the planet gear" or "make the housing transparent".'
      }
      window.setTimeout(() => {
        setMessages((m) => [...m, { role: 'ai', text: reply, calls }])
        setBusy(false)
      }, 650)
    },
    [busy, parts, selectedPart, setAppearance, asm, openPart, live, faces, model, notify],
  )

  return {
    live,
    threads,
    toggleNote,
    restore,
    projectId,
    projectName,
    connected,
    faces,
    setFaces,
    toggleFace,
    models,
    model,
    setModelId,
    refreshModels,
    stop,
    asm,
    parts,
    groups,
    visibleParts,
    visibleInstances,
    look,
    setAppearance,
    selected,
    selectedPart,
    setSelected,
    hovered,
    setHovered,
    view,
    setView,
    openPart,
    openAssembly,
    group,
    setGroup,
    exploded,
    setExploded,
    section,
    setSection,
    drive,
    playing,
    setPlaying,
    fitOpen,
    setFitOpen,
    clash,
    setClash,
    activeClash,
    messages,
    send,
    busy,
    importStep,
    exportFile,
    toast,
    fit,
    fitNonce,
  }
}

type OcctMesh = {
  attributes: { position: { array: number[] }; normal?: { array: number[] } }
  index: { array: number[] }
  brep_faces?: unknown[]
}

function mergeAll(geos: BufferGeometry[]): BufferGeometry {
  const positions: number[] = []
  const indices: number[] = []
  let offset = 0
  for (const g of geos) {
    const pos = g.getAttribute('position').array
    positions.push(...pos)
    for (const i of g.getIndex()!.array) indices.push(i + offset)
    offset += pos.length / 3
  }
  const out = new BufferGeometry()
  out.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  out.setIndex(indices)
  out.computeVertexNormals()
  return out
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}
