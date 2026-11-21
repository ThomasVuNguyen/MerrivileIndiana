import type { Account } from './account'
import type { Directory } from './auth'
import type { Geometry, Video } from './geometry'
import type { Project } from './project'

export interface Env {
  DIRECTORY: DurableObjectNamespace<Directory>
  ACCOUNT: DurableObjectNamespace<Account>
  PROJECT: DurableObjectNamespace<Project>
  FILES: R2Bucket
  ASSETS: Fetcher
  GEOMETRY: DurableObjectNamespace<Geometry>
  VIDEO: DurableObjectNamespace<Video>
  /** Local dev only (.dev.vars): the build123d service as a plain process instead of the Container. */
  GEOMETRY_URL?: string
  /** Langfuse tracing; the keys are Worker secrets. Tracing is off when any is missing. */
  LANGFUSE_BASE_URL?: string
  LANGFUSE_PUBLIC_KEY?: string
  LANGFUSE_SECRET_KEY?: string
  /** "true" lets anyone sign up; otherwise only the first account can. */
  OPEN_SIGNUP?: string
}

export const directoryOf = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'))

/** Each user's models and project list live in their own Account object. */
export const accountOf = (env: Env, userId: string) => env.ACCOUNT.get(env.ACCOUNT.idFromName(userId))
