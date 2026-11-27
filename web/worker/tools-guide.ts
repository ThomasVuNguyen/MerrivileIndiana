// Tool specs and input checks for assembly guides (animated build guides, exploded views,
// explanations): the in-app AI gets them through prompt.ts TOOLS, outside agents through mcp.ts.
// Step numbers the AI sees are 1-based; GuideFinding.step (for the viewer) is 0-based.

import { z } from 'zod'
import type { ToolSpec } from './llm'

const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$' }
const VEC3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }
const VIEW_NAMES = ['iso', 'front', 'top', 'right', 'back', 'left', 'bottom', 'iso-back', 'iso-below']
const PATH = { type: 'string', description: 'An instance path: "lid", or "camera/lens" inside a sub-assembly (a sub-assembly path brings everything in it).' }
const ADDRESS = { type: 'string', description: '"<instance>.<datum>", e.g. "base.hinge_axis" or "camera/lens.optical_axis".' }
const EASE = { type: 'string', enum: ['linear', 'in', 'out', 'in-out', 'back'], description: 'Default in-out; back overshoots a little and settles (not for parts landing on another: the overshoot goes into it).' }

const POSE_OBJECT = {
  type: 'object',
  properties: {
    offset: { ...VEC3, description: 'mm in the assembly frame.' },
    along: { ...ADDRESS, description: 'Move along a datum: a plane\'s normal, an axis\'s direction or a pattern\'s normal ("lid.top", "base.bore_axis"); distance × that direction is added to offset.' },
    distance: { type: 'number', description: 'mm along `along` (negative goes the other way).' },
    turn: {
      type: 'object',
      description: 'Turned deg degrees (right hand) about an axis datum or a plane\'s normal (about), or about axis [x, y, z] through pivot (default the instance\'s assembled origin).',
      properties: { about: ADDRESS, axis: VEC3, pivot: VEC3, deg: { type: 'number' } },
      required: ['deg'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}
const POSE = {
  anyOf: [POSE_OBJECT, VEC3],
  description: 'Where the instance is relative to where it sits assembled (assembly frame): {} is assembled; [x, y, z] is just an offset.',
}
const MOTION = {
  type: 'object',
  properties: {
    instance: PATH,
    from: { ...POSE, description: 'Default: where earlier steps left it (assembled if none moved it).' },
    to: { ...POSE, description: 'Default: assembled.' },
    via: { type: 'array', items: POSE, maxItems: 8, description: 'Poses passed on the way, equal time per leg: lift, then insert.' },
    delay: { type: 'number', minimum: 0, description: 'Seconds after the step starts (default 0); stagger motions with it.' },
    duration: { type: 'number', minimum: 0, description: 'Seconds (default 1).' },
    ease: EASE,
  },
  required: ['instance'],
  additionalProperties: false,
}
const EXPLODE = {
  type: 'object',
  description: 'Shorthand that adds motions: each instance moves out from the assembly\'s centre (further out goes further), outermost first; back: true brings them home, innermost first.',
  properties: {
    instances: { type: 'array', items: PATH, description: 'Default: every top-level instance shown, except the ground.' },
    distance: { type: 'number', minimum: 0, description: 'mm for the outermost one (default 40% of the assembly\'s largest size).' },
    axis: { ...VEC3, description: 'Everything moves this way, further along it going further: [0, 0, 1] lifts a stack apart off its ground.' },
    stagger: { type: 'number', minimum: 0, description: 'Seconds between starts (default 0.15).' },
    duration: { type: 'number', minimum: 0, description: 'Seconds per motion (default 1).' },
    ease: EASE,
    back: { type: 'boolean' },
  },
  additionalProperties: false,
}
const STEP = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short imperative: "Seat the board on the standoffs".' },
    text: { type: 'string', description: 'What to do and why, a few short sentences; **bold** and lists work.' },
    add: { type: 'array', items: PATH, description: 'Instances that appear in this step and stay.' },
    remove: { type: 'array', items: PATH, description: 'Instances that fade out over this step and stay gone.' },
    motions: { type: 'array', items: MOTION },
    explode: EXPLODE,
    camera: {
      type: 'object',
      properties: {
        view: { anyOf: [{ type: 'string', enum: VIEW_NAMES }, { type: 'object', properties: { dir: VEC3, up: VEC3 }, required: ['dir'], additionalProperties: false }], description: 'The side it looks from (default iso): a named view or {dir (it looks along -dir), up?}.' },
        frame: { type: 'array', items: PATH, description: 'Instances to frame; default what the step adds and moves, else everything shown.' },
        zoom: { type: 'number', minimum: 0.2, maximum: 8, description: '> 1 closer.' },
        orbit: { type: 'number', description: 'Degrees the camera turns about its up axis over the step.' },
      },
      additionalProperties: false,
    },
    focus: { type: 'array', items: PATH, description: 'Drawn normally; everything else shown fades. Default: all normal.' },
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, at: { anyOf: [{ type: 'string' }, VEC3], description: '"<instance>" (its centre), "<instance>.<datum>" or [x, y, z]; follows the instance as it moves.' } },
        required: ['text', 'at'],
        additionalProperties: false,
      },
      description: 'Callouts for what to notice: "tab goes in this slot", "this side up".',
    },
    hardware: {
      type: 'array',
      items: {
        type: 'object',
        properties: { qty: { type: 'integer', minimum: 1 }, name: { type: 'string', description: 'Default: the shop item\'s name.' }, item_id: { type: 'string', description: 'Shop item id (search_shop).' }, note: { type: 'string', description: '"finger tight", "0.5 N·m".' } },
        required: ['qty'],
        additionalProperties: false,
      },
      description: 'Screws, nuts and other hardware this step uses.',
    },
    tools: { type: 'array', items: { type: 'string' }, description: '"2.5 mm hex key", "soldering iron".' },
    warning: { type: 'string', description: 'A caution shown with the step: fragile ribbon, ESD, don\'t overtighten.' },
  },
  required: ['title'],
  additionalProperties: false,
}
const GUIDE_FIELDS = {
  name: { type: 'string', description: '"How to build the camera mount".' },
  kind: { type: 'string', enum: ['build', 'exploded', 'explain'], description: 'build: starts empty, each step adds and places instances. exploded: starts assembled and pulls it apart. explain: starts assembled and shows how it works (moves, turns, focus, labels).' },
  summary: { type: 'string', description: 'One or two sentences shown above the steps.' },
  upcoming: { type: 'string', enum: ['hidden', 'ghost'], description: 'Build guides: instances not added yet show faint (ghost, default) or not at all.' },
}
const CHECK_OPTS = {
  note: { type: 'string', description: 'One line for the version list.' },
  time_limit: { type: 'number', minimum: 1, maximum: 240, description: 'Seconds for the path check (default 30); partial when it runs out.' },
}
const GUIDE = { ...ID, description: 'Guide id, unique in the project.' }

export const GUIDE_TOOLS: ToolSpec[] = [
  {
    name: 'write_guide',
    description:
      "Create or replace an animated guide for an assembly: a build guide (Lego-style steps), an exploded view or an explanation. The person plays it in the 3D viewer. Every save resolves datum references, validates it (unknown instances or datums are refused; instances added twice, moved while not shown, never added, left apart; hardware that doesn't add up), checks every motion's path for clashes along the way (path_clash: where and when), draws a sheet with each step's end from its camera, and saves a version. Returns a summary, the findings and the sheet. Steps are numbered from 1.",
    schema: {
      type: 'object',
      properties: { assembly: { ...ID, description: 'The assembly it explains.' }, id: GUIDE, ...GUIDE_FIELDS, steps: { type: 'array', items: STEP, minItems: 1 }, ...CHECK_OPTS },
      required: ['assembly', 'id', 'name', 'kind', 'steps'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_guide',
    description:
      "Change a guide without resending it: guide fields, and steps by number (from 1). ops run in order, each on the guide as the ops before it left it: insert {step, value} puts a new step at that number (one past the last appends); replace {step, value}; patch {step, value: {field: new value | null to clear}} changes only the fields given; delete {step}; move {step, to}. Saves, checks and draws like write_guide; ops: [] re-checks it against the assembly as it is now (after the assembly changed).",
    schema: {
      type: 'object',
      properties: {
        guide: GUIDE,
        ...GUIDE_FIELDS,
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['insert', 'replace', 'patch', 'delete', 'move'] },
              step: { type: 'integer', minimum: 1 },
              to: { type: 'integer', minimum: 1, description: 'move: the new number.' },
              value: { type: 'object', description: 'insert, replace: a whole step. patch: the fields to change.' },
            },
            required: ['op', 'step'],
            additionalProperties: false,
          },
        },
        ...CHECK_OPTS,
      },
      required: ['guide', 'ops'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_guide',
    description: "A guide: its steps as written (what edit_guide changes), what each resolves to, the last check's findings and the versions. With version, that version as written.",
    schema: { type: 'object', properties: { guide: GUIDE, version: { type: 'integer', minimum: 1 } }, required: ['guide'], additionalProperties: false },
  },
  {
    name: 'list_guides',
    description: "The project's guides (or one assembly's): id, name, kind, steps, length, findings and whether the assembly changed since.",
    schema: { type: 'object', properties: { assembly: ID }, additionalProperties: false },
  },
  {
    name: 'delete_guide',
    description: 'Delete a guide and its versions.',
    schema: { type: 'object', properties: { guide: GUIDE }, required: ['guide'], additionalProperties: false },
  },
  {
    name: 'render_guide',
    description:
      'Look at a guide as saved: a sheet with one picture per step (all, or the steps given) at its end, its start or a moment in seconds, from each step\'s camera or the views given. Moving instances leave a dark arrow (ring where they started); labels show as dots. The picture is shown to the person with your caption.',
    schema: {
      type: 'object',
      properties: {
        guide: GUIDE,
        steps: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 40, description: 'Step numbers (from 1); default all.' },
        moment: { anyOf: [{ type: 'string', enum: ['end', 'start'] }, { type: 'number', minimum: 0 }], description: 'end (default), start, or seconds into each step.' },
        views: { type: 'array', items: { type: 'string', enum: VIEW_NAMES }, maxItems: 4, description: 'Instead of each step\'s camera: these views of every step.' },
        size: { type: 'integer', minimum: 200, maximum: 800, description: 'Pixels per picture (default 360).' },
        caption: { type: 'string', maxLength: 500 },
      },
      required: ['guide'],
      additionalProperties: false,
    },
  },
]

export const GUIDE_TOOL_NAMES = new Set(GUIDE_TOOLS.map((t) => t.name))

/** How to write guides and read the BOM, for both the in-app prompt and the MCP instructions. */
export const GUIDE_NOTES = `# Guides and BOM
- A guide animates an assembly; the person watches it play in the viewer, live as you save. Pick what fits what they need to understand: build (starts empty, each step adds instances, like a Lego booklet: to make it), exploded (starts assembled, pulls it apart: to see every piece), explain (starts assembled: how it works, a hinge opening, what touches what). write_guide, then edit_guide by step number (from 1).
- Order a build the way hands would: the ground first, then inside-out, each subassembly before it goes in; one idea per step. Bring each part in from where it really comes: from {along: "base.top", distance: 40} drops it along the datum it seats on; via [{along: ..., distance: ...}] lifts it clear before it slides or turns in; turn {about: "base.hinge", deg: -90} swings it on a hinge. Stagger repeated parts with delay. Per step: camera (view, frame, zoom) so what changes fills the picture, focus on what matters (the rest fades), labels on what to notice ("this side up", "tab into slot"), hardware with shop item ids (search_shop), tools, and a warning for fragile or risky things (ribbon cables, ESD, overtightening). explode: {} pulls everything out from the centre in one step; explode: {axis: [0, 0, 1]} lifts a stack apart.
- Every save checks each motion's path: path_clash means it passes through another instance on the way (when, where, how much). Fix it with a better approach direction, a via that lifts it clear, another step order, or by adding the blocking part later. Also missing (refused), added_twice, not_present, never_added, ends_apart, and hardware (the steps' hardware against the assembly's joining hardware). Look at the sheet (each step's end from its camera; dark arrows show motion); render_guide shows other moments and views.
- set_assembly_hardware records what joins the instances (screws between parts, nuts, standoffs); parts keep their own (set_part_hardware). bill_of_materials counts parts, components and hardware with sub-assemblies flattened, and shows shop stock (on hand, short, to buy) without taking it off: projects are plans. One assembly per variant.`

// ---------------------------------------------------------------- input checks

const V3 = z.tuple([z.number(), z.number(), z.number()])
const Dir = V3.refine((v) => Math.hypot(...v) > 1e-9, 'a direction must not be zero')
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
const SEG = '[a-z0-9][a-z0-9-]{0,40}'
export const Path = z.string().regex(new RegExp(`^${SEG}(/${SEG})*$`), 'an instance path is "<instance>" or "<sub>/<child>"')
export const Address = z.string().regex(new RegExp(`^${SEG}(/${SEG})*\\.[A-Za-z0-9_.-]+$`), 'a datum address is "<instance>.<datum>" or "<sub>/<child>.<datum>"')
const Ease = z.enum(['linear', 'in', 'out', 'in-out', 'back'])
const View = z.enum(['iso', 'front', 'top', 'right', 'back', 'left', 'bottom', 'iso-back', 'iso-below'])

export const PoseIn = z.preprocess(
  (v) => (Array.isArray(v) ? { offset: v } : v),
  z
    .object({
      offset: V3.optional(),
      along: Address.optional(),
      distance: z.number().optional(),
      turn: z.object({ about: Address.optional(), axis: Dir.optional(), pivot: V3.optional(), deg: z.number() }).strict().optional(),
    })
    .strict(),
)
export type PoseInput = z.infer<typeof PoseIn>

const MotionIn = z
  .object({
    instance: Path,
    from: PoseIn.optional(),
    to: PoseIn.optional(),
    via: z.array(PoseIn).max(8).optional(),
    delay: z.number().min(0).max(600).optional(),
    duration: z.number().min(0).max(600).optional(),
    ease: Ease.optional(),
  })
  .strict()
export type MotionInput = z.infer<typeof MotionIn>

const ExplodeIn = z
  .object({
    instances: z.array(Path).max(200).optional(),
    distance: z.number().min(0).optional(),
    axis: Dir.optional(),
    stagger: z.number().min(0).max(60).optional(),
    duration: z.number().min(0).max(600).optional(),
    ease: Ease.optional(),
    back: z.boolean().optional(),
  })
  .strict()

export const StepIn = z
  .object({
    title: z.string().min(1).max(120),
    text: z.string().max(4000).optional(),
    add: z.array(Path).max(200).optional(),
    remove: z.array(Path).max(200).optional(),
    motions: z.array(MotionIn).max(100).optional(),
    explode: ExplodeIn.optional(),
    camera: z
      .object({
        view: z.union([View, z.object({ dir: Dir, up: Dir.optional() }).strict()]).optional(),
        frame: z.array(Path).max(200).optional(),
        zoom: z.number().min(0.2).max(8).optional(),
        orbit: z.number().min(-3600).max(3600).optional(),
      })
      .strict()
      .optional(),
    focus: z.array(Path).max(200).optional(),
    labels: z.array(z.object({ text: z.string().min(1).max(120), at: z.union([z.union([Path, Address]), V3]) }).strict()).max(30).optional(),
    hardware: z.array(z.object({ qty: z.number().int().min(1).max(100000), name: z.string().min(1).max(80).optional(), item_id: z.string().max(80).optional(), note: z.string().max(200).optional() }).strict()).max(40).optional(),
    tools: z.array(z.string().min(1).max(80)).max(20).optional(),
    warning: z.string().max(500).optional(),
  })
  .strict()
export type StepInput = z.infer<typeof StepIn>

const Kind = z.enum(['build', 'exploded', 'explain'])
const Upcoming = z.enum(['hidden', 'ghost'])
const Note = z.string().max(120).optional()
const TimeLimit = z.number().min(1).max(240).optional()

export const WriteGuide = z
  .object({ assembly: Id, id: Id, name: z.string().min(1).max(80), kind: Kind, summary: z.string().max(1000).optional(), upcoming: Upcoming.optional(), steps: z.array(StepIn).min(1).max(100), note: Note, time_limit: TimeLimit })
  .strict()
export const EditGuide = z
  .object({
    guide: Id,
    name: z.string().min(1).max(80).optional(),
    kind: Kind.optional(),
    summary: z.string().max(1000).nullable().optional(),
    upcoming: Upcoming.optional(),
    ops: z.array(z.object({ op: z.enum(['insert', 'replace', 'patch', 'delete', 'move']), step: z.number().int().min(1), to: z.number().int().min(1).optional(), value: z.record(z.string(), z.unknown()).optional() }).strict()).max(100),
    note: Note,
    time_limit: TimeLimit,
  })
  .strict()
export const ReadGuide = z.object({ guide: Id, version: z.number().int().min(1).optional() }).strict()
export const ListGuides = z.object({ assembly: Id.optional() }).strict()
export const DeleteGuide = z.object({ guide: Id }).strict()
export const RenderGuide = z
  .object({
    guide: Id,
    steps: z.array(z.number().int().min(1)).max(40).optional(),
    moment: z.union([z.enum(['end', 'start']), z.number().min(0)]).optional(),
    views: z.array(View).max(4).optional(),
    size: z.number().int().min(200).max(800).optional(),
    caption: z.string().max(500).optional(),
  })
  .strict()

/** What a guide is as written; saved per version and edited by edit_guide. */
export type GuideSource = { name: string; kind: 'build' | 'exploded' | 'explain'; summary?: string; upcoming: 'hidden' | 'ghost'; steps: StepInput[] }
