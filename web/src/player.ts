// Playing an assembly guide: which guide is open, the step, the time in it, playing or paused, and
// how fast. The time lives in a ref the viewer advances every frame; React only hears about steps.

import { useCallback, useMemo, useRef, useState } from 'react'
import type { GuideDoc } from '../shared/protocol'
import { stepDuration } from '../shared/guide'

/**
 * The clock the viewer reads and writes every frame. `t` is seconds into `step`; `shown` is where
 * the drawing is on the whole guide's timeline (it chases step + t, so jumps glide instead of cut).
 * `shot` counts requests to move the camera to a step's view; `frame` overrides what it frames.
 */
export type GuideClock = {
  step: number
  t: number
  shown: number
  scrubbing: boolean
  shot: number
  frame: { paths: string[]; t: number } | null
}

export type Player = ReturnType<typeof useGuidePlayer>

/** Seconds from the guide's start to each step's start, and the whole length at the end. */
export function stepOffsets(g: Pick<GuideDoc, 'steps'>) {
  const out = [0]
  for (const s of g.steps) out.push(out[out.length - 1] + stepDuration(s))
  return out
}

export function useGuidePlayer(guides: GuideDoc[], assemblyId: string | null) {
  const [id, setId] = useState<string | null>(null)
  const [step, setStepState] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [auto, setAuto] = useState(true)
  // Index into the open guide's report.findings being looked at.
  const [mark, setMarkState] = useState<number | null>(null)
  const clock = useRef<GuideClock>({ step: 0, t: 0, shown: -1, scrubbing: false, shot: 0, frame: null })

  const guide = useMemo(() => guides.find((g) => g.id === id && g.assembly === assemblyId) ?? null, [guides, id, assemblyId])
  const guideRef = useRef(guide)
  guideRef.current = guide

  /** Go to a step (at `t` seconds into it); the camera moves to its view unless told not to. */
  const goStep = useCallback((i: number, opts: { t?: number; camera?: boolean } = {}) => {
    const g = guideRef.current
    const n = g?.steps.length ?? 0
    const at = Math.max(0, Math.min(n - 1, i))
    const c = clock.current
    c.step = at
    c.t = opts.t ?? 0
    c.frame = null
    if (opts.camera !== false) c.shot++
    setStepState(at)
  }, [])

  const open = useCallback((guideId: string, play = true) => {
    const c = clock.current
    c.step = 0
    c.t = 0
    c.shown = -1
    c.frame = null
    c.shot++
    setId(guideId)
    setStepState(0)
    setMarkState(null)
    setPlaying(play)
  }, [])

  const close = useCallback(() => {
    setId(null)
    setPlaying(false)
    setMarkState(null)
  }, [])

  /** Play from where it is; at a step's end that's the next step, at the guide's end the start. */
  const playingRef = useRef(playing)
  playingRef.current = playing
  const togglePlay = useCallback(() => {
    const g = guideRef.current
    if (!g) return
    if (playingRef.current) return setPlaying(false)
    const c = clock.current
    if (c.t >= stepDuration(g.steps[c.step]) - 1e-3) goStep(c.step < g.steps.length - 1 ? c.step + 1 : 0)
    setPlaying(true)
  }, [goStep])

  /** Show a finding: its step at its moment, paused, the camera on what it names. */
  const setMark = useCallback(
    (i: number | null) => {
      setMarkState(i)
      const f = i === null ? null : guideRef.current?.report?.findings[i]
      if (!f || f.step === undefined) return
      setPlaying(false)
      goStep(f.step, { t: f.t ?? 0 })
      if (f.instances.length) clock.current.frame = { paths: f.instances, t: f.t ?? 0 }
    },
    [goStep],
  )

  return { guide, id, open, close, step, goStep, playing, setPlaying, togglePlay, speed, setSpeed, auto, setAuto, mark, setMark, clock }
}
