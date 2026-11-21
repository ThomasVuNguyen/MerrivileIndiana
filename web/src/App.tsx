import { useEffect, useState } from 'react'
import { LibraryPage } from './library'
import { MemoryPage } from './memory'
import { ShopPage } from './shop'
import { Login, Projects, Thumb } from './pages'
import { SessionProvider, useSession } from './session'
import { Settings } from './settings'
import { OptionA, OptionB, OptionC } from './shells'
import { DEMO, WorkspaceProvider } from './workspace'

type Variant = 'a' | 'b' | 'c'

function useRoute() {
  const [hash, setHash] = useState(location.hash || '#/login')
  useEffect(() => {
    const on = () => setHash(location.hash || '#/login')
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash.slice(1)
}

function initialVariant(): Variant {
  const q = new URLSearchParams(location.search).get('v')
  if (q === 'a' || q === 'b' || q === 'c') return q
  return 'b'
}

export default function App() {
  return (
    <SessionProvider>
      <Routes />
    </SessionProvider>
  )
}

function Routes() {
  const route = useRoute()
  const session = useSession()
  const [variant, setVariant] = useState<Variant>(initialVariant)
  const clean = new URLSearchParams(location.search).has('clean')
  const projectId = route.match(/^\/p\/([\w-]+)$/)?.[1]
  // Live projects only exist in the chosen Paper design.
  const shown: Variant = projectId && projectId !== DEMO ? 'b' : variant

  useEffect(() => {
    document.documentElement.dataset.v = shown
    const url = new URL(location.href)
    url.searchParams.set('v', variant)
    history.replaceState(null, '', url)
  }, [variant, shown])

  if (route.startsWith('/thumb/')) return <Thumb model={route.slice(7)} />
  if (!session.ready) return null

  let page
  // Everything but the concept demo needs an account.
  if (route === '/login' || (!session.user && projectId !== DEMO)) page = <Login onDone={() => (location.hash = '#/projects')} />
  else if (route === '/settings') page = <Settings />
  else if (route === '/settings/memory') page = <MemoryPage />
  else if (route.startsWith('/shop')) page = <ShopPage />
  else if (route.startsWith('/library')) page = <LibraryPage />
  else if (projectId)
    page = (
      <WorkspaceProvider key={route} projectId={projectId}>
        {shown === 'a' ? <OptionA /> : shown === 'b' ? <OptionB /> : <OptionC />}
      </WorkspaceProvider>
    )
  else page = <Projects />

  return (
    <>
      {page}
      {!clean && projectId === DEMO && (
        // Review chrome for comparing the concepts; not part of the product.
        <div className="concept-switch" role="radiogroup" aria-label="Concept">
          {(['a', 'b', 'c'] as const).map((v) => (
            <button key={v} role="radio" aria-checked={variant === v} onClick={() => setVariant(v)}>
              {v.toUpperCase()}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
