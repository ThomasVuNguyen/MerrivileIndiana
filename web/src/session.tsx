import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from './api'
import type { User } from './api'

type Session = { user: User | null; ready: boolean; signedIn: (u: User) => void; signOut: () => Promise<void> }

const Ctx = createContext<Session>({ user: null, ready: false, signedIn: () => {}, signOut: async () => {} })

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    api
      .me()
      .then(setUser, () => setUser(null))
      .finally(() => setReady(true))
  }, [])
  const signOut = useCallback(async () => {
    await api.signOut().catch(() => {})
    setUser(null)
    location.hash = '#/login'
  }, [])
  return <Ctx.Provider value={{ user, ready, signedIn: setUser, signOut }}>{children}</Ctx.Provider>
}

export const useSession = () => useContext(Ctx)

/** Initials from the email's local part: thomas.nguyen@… → TN. */
export function Avatar() {
  const { user } = useSession()
  const local = user?.email.split('@')[0] ?? ''
  const parts = local.split(/[._-]+/).filter(Boolean)
  const initials = (parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2)).toUpperCase()
  return (
    <a className="avatar avatar--paper" href="#/settings" title={user ? `${user.email} · Settings` : 'Settings'}>
      {initials || '·'}
    </a>
  )
}
