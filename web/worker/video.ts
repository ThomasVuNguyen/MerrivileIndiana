// Videos the browser couldn't open itself go through the video container (ffmpeg):
// a poster, a sheet of frames for the AI, and an MP4 copy when browsers can't play the original.

import type { Attachment } from '../shared/protocol'
import type { Env } from './env'
import { videoFetch } from './geometry'

const extOf = (key: string) => key.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? 'bin'

/** Poster and frame sheet, stored next to the original. */
export async function videoFrames(env: Env, key: string): Promise<Partial<Attachment>> {
  const obj = await env.FILES.get(key)
  if (!obj) throw new Error('The video is no longer stored.')
  const res = await videoFetch(env, '/video/frames', obj, extOf(key))
  const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; poster?: string; sheet?: string; width?: number; height?: number; duration?: number; needsCopy?: boolean }
  if (!out.ok || !out.poster || !out.sheet) throw new Error(`Couldn't read this video: ${out.error ?? `error ${res.status}`}`)
  const previewKey = `${key}.preview.jpg`
  const framesKey = `${key}.frames.jpg`
  await Promise.all([
    env.FILES.put(previewKey, fromBase64(out.poster), { httpMetadata: { contentType: 'image/jpeg' } }),
    env.FILES.put(framesKey, fromBase64(out.sheet), { httpMetadata: { contentType: 'image/jpeg' } }),
  ])
  return { previewKey, previewUrl: `/api/files/${previewKey}`, framesKey, width: out.width, height: out.height, duration: out.duration, needsCopy: out.needsCopy }
}

/** An H.264 MP4 that plays in every browser, for AVI, WMV, MKV, MPEG and the like. */
export async function videoCopy(env: Env, key: string): Promise<Partial<Attachment>> {
  const obj = await env.FILES.get(key)
  if (!obj) throw new Error('The video is no longer stored.')
  const res = await videoFetch(env, '/video/copy', obj, extOf(key))
  const length = Number(res.headers.get('content-length'))
  if (!res.ok || !res.body || !length) throw new Error(`Couldn't convert this video: ${((await res.json().catch(() => ({}))) as { error?: string }).error ?? `error ${res.status}`}`)
  const { readable, writable } = new FixedLengthStream(length)
  res.body.pipeTo(writable).catch(() => {})
  const playKey = `${key}.play.mp4`
  await env.FILES.put(playKey, readable, { httpMetadata: { contentType: 'video/mp4' } })
  return { playKey, playUrl: `/api/files/${playKey}` }
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
