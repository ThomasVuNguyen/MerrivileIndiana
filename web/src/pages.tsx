import { Suspense, useEffect, useState } from 'react'
import { Canvas, useLoader } from '@react-three/fiber'
import { Bounds, Edges } from '@react-three/drei'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import type { Attachment, ProjectInfo } from '../shared/protocol'
import { api, pendingPrompt } from './api'
import { Avatar, useSession } from './session'
import { ChatInput, Icon } from './ui'

export function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const session = useSession()
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\S+@\S+\.\S+$/.test(email)) return setError('Enter a valid email address.')
    if (password.length < 8) return setError('Password must be at least 8 characters.')
    setError(null)
    setBusy(true)
    try {
      const user = mode === 'in' ? await api.signIn(email, password) : await api.signUp(email, password)
      session.signedIn(user)
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit} noValidate>
        <div className="auth-mark">
          <span className="logo-mark" />
          merrivile
        </div>
        <h1>{mode === 'in' ? 'Sign in' : 'Create account'}</h1>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === 'up' ? 'At least 8 characters' : ''}
          />
        </label>
        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn--solid btn--block" type="submit" disabled={busy}>
          {busy ? 'One moment…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
        <p className="auth-switch">
          {mode === 'in' ? 'New here? ' : 'Have an account? '}
          <button type="button" className="link" onClick={() => (setMode(mode === 'in' ? 'up' : 'in'), setError(null))}>
            {mode === 'in' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </form>
    </div>
  )
}

export function Projects() {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null)
  const [hasModel, setHasModel] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.projects().then(setProjects, () => setProjects([]))
    api.models().then((m) => setHasModel(m.length > 0), () => setHasModel(false))
  }, [])

  const start = async (text: string, images: Attachment[]) => {
    if ((!text && !images.length) || busy) return
    setBusy(true)
    try {
      const project = await api.createProject(nameFrom(text || 'From a sketch'))
      pendingPrompt.set(project.id, { text, images })
      location.hash = `#/p/${project.id}`
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  const fromStep = async (file: File) => {
    setBusy(true)
    setError(null)
    try {
      const project = await api.createProject(file.name.replace(/\.(step|stp)$/i, ''))
      await api.importStep(project.id, file)
      location.hash = `#/p/${project.id}`
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="projects">
      <header className="projects-top">
        <div className="auth-mark">
          <span className="logo-mark" />
          merrivile
        </div>
        <nav className="top-nav">
          <a href="#/projects" className="is-on">
            Projects
          </a>
          <a href="#/shop">Shop</a>
          <a href="#/library">Library</a>
          <Avatar />
        </nav>
      </header>
      <section className="projects-hero">
        <h1>
          What are we <em>building?</em>
        </h1>
        <div className="hero-prompt">
          <ChatInput
            placeholder="A NEMA 17 mount with a 5 mm slot for belt tension… (paste a sketch or photo too)"
            busy={busy || hasModel === false}
            canStop={false}
            onStop={() => {}}
            onSend={start}
            footer={
              hasModel === false ? (
                <a className="link" href="#/settings">
                  Add a model first →
                </a>
              ) : error ? (
                <span className="auth-error">{error}</span>
              ) : (
                <label className="link hero-step">
                  <Icon name="upload" size={14} /> Start from a STEP file
                  <input type="file" accept=".step,.stp" hidden data-testid="start-step" onChange={(e) => e.target.files?.[0] && fromStep(e.target.files[0])} />
                </label>
              )
            }
          />
        </div>
      </section>
      <section className="project-grid">
        {projects?.map((p) => (
          <a key={p.id} className="project-card" href={`#/p/${p.id}`}>
            <div className="project-thumb project-thumb--sheet">{p.thumb ? <img src={p.thumb} alt="" /> : <span className="faint small">no parts yet</span>}</div>
            <div className="project-meta">
              <strong>{p.name}</strong>
              <span>
                {p.parts} {p.parts === 1 ? 'part' : 'parts'} · {ago(p.updatedAt)}
              </span>
            </div>
          </a>
        ))}
        <a className="project-card" href="#/p/actuator">
          <div className="project-thumb">
            <img src="/thumbs/actuator.png" alt="" />
          </div>
          <div className="project-meta">
            <strong>QDD Actuator 110</strong>
            <span>Concept demo · 13 parts</span>
          </div>
        </a>
      </section>
    </div>
  )
}

// "a NEMA 17 mount with a slot…" → "NEMA 17 mount"
function nameFrom(prompt: string) {
  const words = prompt.split(/[,;:(?]/)[0].replace(/[^\w\s.'’-]/g, ' ').split(/\s+/).filter(Boolean)
  const body = words[0] && /^(a|an|the|make|build|design|create)$/i.test(words[0]) ? words.slice(1) : words
  const cut = body.findIndex((w, i) => i > 0 && /^(with|for|that|which|to|and)$/i.test(w))
  const name = body.slice(0, cut > 0 ? Math.min(cut, 6) : 6).join(' ')
  return name.charAt(0).toUpperCase() + name.slice(1) || 'Untitled'
}

function ago(t: number) {
  const s = (Date.now() - t) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Renders a single STL for capturing project thumbnails. */
export function Thumb({ model }: { model: string }) {
  document.body.style.background = 'transparent'
  return (
    <div style={{ width: 640, height: 420, background: 'transparent' }}>
      <Canvas camera={{ position: [180, 140, 200], fov: 30 }} gl={{ alpha: true, preserveDrawingBuffer: true }}>
        <hemisphereLight args={['#ffffff', '#8a8f99', 1.1]} />
        <directionalLight position={[120, 200, 160]} intensity={1.6} />
        <Suspense fallback={null}>
          <Bounds fit clip margin={1.2}>
            <ThumbMesh model={model} />
          </Bounds>
        </Suspense>
      </Canvas>
    </div>
  )
}

function ThumbMesh({ model }: { model: string }) {
  const geo = useLoader(STLLoader, `/models/${model}.stl`)
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2, 0, 0]}>
      <meshStandardMaterial color="#b9bcc2" metalness={0.18} roughness={0.55} polygonOffset polygonOffsetFactor={1} />
      <Edges threshold={28} color="#1d1f23" />
    </mesh>
  )
}
