import { Container, getContainer } from '@cloudflare/containers'
import type { Env } from './env'

/** The build123d service (geometry/Dockerfile). AI-written code runs here, so no internet. */
export class Geometry extends Container<Env> {
  defaultPort = 8790
  sleepAfter = '15m'
  enableInternet = false
}

/** The same image, for videos: more CPU and disk, and ffmpeg never holds up a CAD build. */
export class Video extends Container<Env> {
  defaultPort = 8790
  sleepAfter = '5m'
  enableInternet = false
}

// Must match VERSION in geometry/server.py. Change both when geometry/ changes:
// a warm container keeps its old image, so the instance name carries the
// version and a deploy starts fresh containers (see deploy.sh).
export const GEOMETRY_VERSION = '2026-11-26.renders'
const INSTANCE = `geo-${GEOMETRY_VERSION}`

/** POST to the geometry service: the local process in dev, the Container when deployed. */
export function geometryFetch(env: Env, path: string, init: { method: string; body: string; signal?: AbortSignal }) {
  const body = init.method === 'GET' ? undefined : init.body
  if (env.GEOMETRY_URL) return fetch(`${env.GEOMETRY_URL}${path}`, { ...init, body })
  // A shared instance; its server handles concurrent builds in separate processes.
  return getContainer(env.GEOMETRY, INSTANCE).fetch(new Request(`http://geometry${path}`, { method: init.method, body }))
}

/**
 * POST a stored file's bytes as the raw body: to the video container (ffmpeg), or the geometry
 * one (spreadsheets, documents). A fixed length, because the server reads Content-Length.
 */
export function fileFetch(env: Env, to: 'video' | 'geometry', path: string, obj: R2ObjectBody, ext: string) {
  const { readable, writable } = new FixedLengthStream(obj.size)
  obj.body.pipeTo(writable).catch(() => {})
  const init = { method: 'POST', body: readable, headers: { 'x-ext': ext } }
  if (env.GEOMETRY_URL) return fetch(`${env.GEOMETRY_URL}${path}`, init)
  const stub = to === 'video' ? getContainer(env.VIDEO, `video-${GEOMETRY_VERSION}`) : getContainer(env.GEOMETRY, INSTANCE)
  return stub.fetch(new Request(`http://${to}${path}`, init))
}
