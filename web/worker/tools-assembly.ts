// Tool specs and input checks for components (account-wide vendor models) and assemblies (per
// project): the in-app AI gets them through prompt.ts TOOLS, outside agents through mcp.ts.

import { z } from 'zod'
import { ComponentId } from './components'
import type { ToolSpec } from './llm'

const ID = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$' }
const VEC3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }
const DIR = { ...VEC3, description: 'A direction [x, y, z]; normalised for you.' }

const DATUM = {
  type: 'object',
  description:
    'plane {kind, origin, normal (out of the material), x (in-plane x direction)}; axis {kind, origin, direction}; point {kind, at}; pattern {kind, points: [[x, y, z], …], normal, diameter?}. In the component\'s own frame, mm.',
  properties: {
    kind: { type: 'string', enum: ['plane', 'axis', 'point', 'pattern'] },
    origin: VEC3,
    normal: DIR,
    x: DIR,
    direction: DIR,
    at: VEC3,
    points: { type: 'array', items: VEC3, minItems: 2 },
    diameter: { type: 'number' },
  },
  required: ['kind'],
  additionalProperties: false,
}
const KEEPOUT = {
  type: 'object',
  description:
    'A volume other instances must stay out of, in the component\'s frame: box {min, max}; cylinder {origin, direction, radius, length} (starts at origin, runs along direction); cone {origin (its tip end), direction, angle (half-angle °), length, radius? at the tip end}, e.g. a lens\'s field of view.',
  properties: {
    kind: { type: 'string', enum: ['box', 'cylinder', 'cone'] },
    label: { type: 'string', description: '"USB plug clearance", "lens field of view".' },
    min: VEC3,
    max: VEC3,
    origin: VEC3,
    direction: DIR,
    radius: { type: 'number' },
    length: { type: 'number' },
    angle: { type: 'number' },
  },
  required: ['kind', 'label'],
  additionalProperties: false,
}
const DETAILS = {
  name: { type: 'string', description: 'Human name, e.g. "Raspberry Pi Zero 2 W".' },
  vendor: { type: 'string' },
  part_number: { type: 'string' },
  link: { type: 'string', description: 'Product or datasheet page.' },
  notes: { type: 'string' },
}

export const COMPONENT_TOOLS: ToolSpec[] = [
  {
    name: 'import_component',
    description:
      "Bring a vendor STEP (a board, camera, connector, lens) into the account's component library, available in every project: from a URL (fetched by the server), STEP text, base64, a Library item id, or an attachment. Up to 95 MB (start_upload for big files from outside agents). Returns its size, the datums found on import (hole patterns in the board plane, the largest flat face, bores) and a render. Components never change; a new revision is a new import. Place them in assemblies and use component(\"id\") in part scripts and inspect.",
    schema: {
      type: 'object',
      properties: {
        id: { ...ID, description: 'Optional stable id, e.g. "pi-zero-2w"; made from the name otherwise.' },
        ...DETAILS,
        url: { type: 'string' },
        step: { type: 'string', description: 'The STEP file as text.' },
        base64: { type: 'string' },
        library: { type: 'string', description: 'A Library item id (a STEP file the person keeps there).' },
        attachment: { type: 'integer', minimum: 1, description: 'In a chat: which attachment, 1-based, on the newest message that had attachments.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_components',
    description: "The account's components: id, name, vendor, size and datum names.",
    schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_component',
    description: "A component's details: every datum (and the suggestions from import), keep-outs, outline, the holes found, and its render. Read one before placing it.",
    schema: { type: 'object', properties: { component: ID }, required: ['component'], additionalProperties: false },
  },
  {
    name: 'set_component_datums',
    description:
      "Edit a component's datums, keep-outs, outline and details. datums merges by name (null removes one; replace_datums: true replaces them all). keepouts replaces the list. Every assembly using the component picks the change up on its next save. Coordinates are in the component's own frame (read_component shows it). Plane normals point out of the material.",
    schema: {
      type: 'object',
      properties: {
        component: ID,
        datums: { type: 'object', additionalProperties: { anyOf: [DATUM, { type: 'null' }] }, description: 'name → datum (or null to remove).' },
        replace_datums: { type: 'boolean' },
        keepouts: { type: 'array', items: KEEPOUT },
        outline: { type: 'object', properties: { min: VEC3, max: VEC3 }, required: ['min', 'max'], additionalProperties: false },
        ...DETAILS,
      },
      required: ['component'],
      additionalProperties: false,
    },
  },
]

const SNAP = {
  type: 'object',
  properties: {
    own: { type: 'string', description: 'A datum of this instance (for a sub-assembly: "<child>.<datum>").' },
    to: { type: 'string', description: '"<instance>.<datum>" of an instance placed before this one; inside a sub-assembly "<sub>/<child>.<datum>".' },
    offset: { type: 'number', description: 'mm along the target normal or axis (a gap between planes, a slide along an axis).' },
    flip: { type: 'boolean', description: 'Planes and patterns: normals the same way instead of face to face. Axes: opposed instead of aligned.' },
    spin: { type: 'number', description: 'Degrees about the target normal or axis.' },
  },
  required: ['own', 'to'],
  additionalProperties: false,
}
const INSTANCE = {
  type: 'object',
  properties: {
    id: { ...ID, description: 'Stable kebab-case id, unique in the assembly: "pi", "boss-1".' },
    name: { type: 'string' },
    ref: {
      type: 'object',
      description: 'What it is: {part: "id"} (follows the latest good version; version pins one), {component: "id"}, or {assembly: "id"} (a sub-assembly).',
      properties: { part: { type: 'string' }, version: { type: 'integer', minimum: 1 }, component: { type: 'string' }, assembly: { type: 'string' } },
      additionalProperties: false,
    },
    color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    ground: { type: 'boolean', description: 'The instance that stays put; default the first one.' },
    pos: { ...VEC3, description: 'mm; with rot, build123d Pos(x, y, z) * Rot(rx, ry, rz).' },
    rot: { ...VEC3, description: 'Degrees, Rot(rx, ry, rz): about X, then Y, then Z (intrinsic). With an axis or point snap it sets the starting orientation.' },
    snap: { type: 'array', items: SNAP, minItems: 1, maxItems: 2, description: 'One snap, or two (e.g. axis → axis, then seat plane → seat plane).' },
  },
  required: ['id'],
  additionalProperties: false,
}
const REQUIREMENT = {
  type: 'object',
  description:
    'coaxial {a, b: axes, tol_mm?, tol_deg?}; parallel {a, b: planes or axes, tol_deg?}; distance {a, b, value mm, tol?}. a and b are "<instance>.<datum>". Defaults 0.02 mm and 0.05°. Checked on every save.',
  properties: {
    kind: { type: 'string', enum: ['coaxial', 'parallel', 'distance'] },
    a: { type: 'string' },
    b: { type: 'string' },
    value: { type: 'number' },
    tol: { type: 'number' },
    tol_mm: { type: 'number' },
    tol_deg: { type: 'number' },
    name: { type: 'string' },
  },
  required: ['kind', 'a', 'b'],
  additionalProperties: false,
}
const ASM = { ...ID, description: 'Assembly id, e.g. "camera-mount".' }
const RENDER_OPTS = {
  views: {
    type: 'array',
    maxItems: 6,
    items: { type: 'string', enum: ['iso', 'front', 'top', 'right', 'back', 'left', 'bottom', 'iso-back', 'iso-below'] },
    description: 'Views for the picture; default iso, front, top, right.',
  },
  section: {
    type: 'object',
    description: 'Cut the picture: {normal: "x" | "y" | "z" | [x, y, z], offset? mm, keep? "below" | "above"}.',
    properties: { normal: {}, offset: { type: 'number' }, keep: { type: 'string', enum: ['below', 'above'] } },
    required: ['normal'],
    additionalProperties: false,
  },
}

export const ASSEMBLY_TOOLS: ToolSpec[] = [
  {
    name: 'write_assembly',
    description:
      "Create or replace an assembly: its instances (parts, components, sub-assemblies), how each is placed (pos/rot or snaps between datums), alignment requirements and the tight-gap clearance. Every save places the instances in order and checks the result: clashes, tight gaps, contacts, floating parts, keep-outs, pattern fits, unresolved snaps and requirements. Findings are warnings and never block the save. Returns the report and a render (one colour per instance, clashes red). Instances follow their part's latest good version unless pinned.",
    schema: {
      type: 'object',
      properties: {
        id: ASM,
        name: { type: 'string' },
        instances: { type: 'array', items: INSTANCE, description: 'In order; each snaps only to instances placed before it (any order works, cycles are an error).' },
        requirements: { type: 'array', items: REQUIREMENT },
        clearance: { type: 'number', minimum: 0, description: 'Tight-gap threshold, mm (default 0.2).' },
        note: { type: 'string', description: 'One line for the version list.' },
        ...RENDER_OPTS,
      },
      required: ['id', 'name', 'instances'],
      additionalProperties: false,
    },
  },
  {
    name: 'place',
    description:
      'Add or move instances in an assembly, then save and check it like write_assembly. Each entry is merged into the instance with that id (give ref and name for a new one); pos, rot, snap and ground replace what it had. Returns the report and a render.',
    schema: {
      type: 'object',
      properties: { assembly: ASM, instances: { type: 'array', items: INSTANCE, description: 'Instances to add or change; [] re-places and re-checks the assembly as it is (after its parts changed).' }, note: { type: 'string' }, ...RENDER_OPTS },
      required: ['assembly', 'instances'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_instances',
    description: 'Remove instances from an assembly and save it. Instances that snapped to them keep their placement and are reported unresolved.',
    schema: { type: 'object', properties: { assembly: ASM, ids: { type: 'array', items: { type: 'string' }, minItems: 1 }, note: { type: 'string' } }, required: ['assembly', 'ids'], additionalProperties: false },
  },
  {
    name: 'read_assembly',
    description: "An assembly's instances (with how each is placed and where it ended up), requirements, the last check and the versions. With version, that version's instances as written.",
    schema: { type: 'object', properties: { assembly: ASM, version: { type: 'integer', minimum: 1 } }, required: ['assembly'], additionalProperties: false },
  },
  {
    name: 'list_assemblies',
    description: "The project's assemblies: id, name, version, instance count and the last check's warnings.",
    schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'check_assembly',
    description:
      'Check an assembly again without saving: other clearance, extra requirements, a longer time limit. It is placed from its parts\' latest versions, so it also shows what a re-save would change. Returns the report and a render.',
    schema: {
      type: 'object',
      properties: {
        assembly: ASM,
        clearance: { type: 'number', minimum: 0 },
        requirements: { type: 'array', items: REQUIREMENT, description: 'Checked with the saved ones.' },
        time_limit: { type: 'number', minimum: 1, maximum: 240, description: 'Seconds (default 30); partial results when it runs out.' },
        ...RENDER_OPTS,
      },
      required: ['assembly'],
      additionalProperties: false,
    },
  },
  {
    name: 'render_assembly',
    description: 'Look at an assembly as last saved: views, a section cut, one colour per instance and its last clashes in red. The picture is shown to the person with your caption.',
    schema: {
      type: 'object',
      properties: { assembly: ASM, ...RENDER_OPTS, size: { type: 'integer', minimum: 200, maximum: 1000 }, caption: { type: 'string', maxLength: 500 } },
      required: ['assembly'],
      additionalProperties: false,
    },
  },
  {
    name: 'duplicate_assembly',
    description: 'Copy an assembly under a new id and name (to try a variant), and check the copy.',
    schema: { type: 'object', properties: { assembly: ASM, id: ID, name: { type: 'string' } }, required: ['assembly', 'id', 'name'], additionalProperties: false },
  },
  {
    name: 'swap_component',
    description:
      "Replace a placed component with another (a different camera, a newer board revision). Snaps carry over through datums with the same names; the save reports what no longer fits (missing datums, hole patterns that don't match, new clashes).",
    schema: { type: 'object', properties: { assembly: ASM, instance: { type: 'string' }, component: ID, name: { type: 'string', description: 'New instance name (default: the component\'s).' }, note: { type: 'string' } }, required: ['assembly', 'instance', 'component'], additionalProperties: false },
  },
]

export const COMPONENT_TOOL_NAMES = new Set(COMPONENT_TOOLS.map((t) => t.name))
export const ASSEMBLY_TOOL_NAMES = new Set([...ASSEMBLY_TOOLS.map((t) => t.name), 'export_assembly'])

// ---------------------------------------------------------------- input checks

const V3 = z.tuple([z.number(), z.number(), z.number()])
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
const Address = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}(\/[a-z0-9][a-z0-9-]{0,40})*\.[A-Za-z0-9_.-]+$/, 'an address is "<instance>.<datum>" or "<sub>/<child>.<datum>"')
export const SnapSchema = z.object({ own: z.string().min(1).max(200), to: Address, offset: z.number().optional(), flip: z.boolean().optional(), spin: z.number().optional() }).strict()
export const RefSchema = z.union([
  z.object({ part: Id, version: z.number().int().min(1).optional() }).strict(),
  z.object({ component: ComponentId }).strict(),
  z.object({ assembly: Id }).strict(),
])
const Snaps = z.preprocess((v) => (v && !Array.isArray(v) ? [v] : v), z.array(SnapSchema).min(1).max(2))
export const InstanceSchema = z
  .object({
    id: Id,
    name: z.string().min(1).max(80),
    ref: RefSchema,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    ground: z.boolean().optional(),
    pos: V3.optional(),
    rot: V3.optional(),
    snap: Snaps.optional(),
  })
  .strict()
/** For place: an id, and whatever changes. */
export const InstancePatch = InstanceSchema.partial().extend({ id: Id }).extend({ snap: Snaps.nullable().optional(), pos: V3.nullable().optional(), rot: V3.nullable().optional() })

const RequirementObject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('coaxial'), a: Address, b: Address, tol_mm: z.number().positive().optional(), tol_deg: z.number().positive().optional(), name: z.string().max(80).optional() }).strict(),
  z.object({ kind: z.literal('parallel'), a: Address, b: Address, tol_deg: z.number().positive().optional(), name: z.string().max(80).optional() }).strict(),
  z.object({ kind: z.literal('distance'), a: Address, b: Address, value: z.number(), tol: z.number().positive().optional(), name: z.string().max(80).optional() }).strict(),
])
/** Also takes "coaxial(lens.axis, cell.axis, 0.01, 0.05)", "parallel(a.p, b.p, 0.1)", "distance(a.p, b.p, 12.5, 0.02)". */
export const RequirementSchema = z.preprocess((v) => {
  if (typeof v !== 'string') return v
  const m = v.trim().match(/^(coaxial|parallel|distance)\s*\((.*)\)$/)
  if (!m) return v
  const [a, b, ...rest] = m[2].split(',').map((x) => x.trim())
  const n = rest.map(Number)
  if (m[1] === 'coaxial') return { kind: 'coaxial', a, b, ...(rest[0] && { tol_mm: n[0] }), ...(rest[1] && { tol_deg: n[1] }) }
  if (m[1] === 'parallel') return { kind: 'parallel', a, b, ...(rest[0] && { tol_deg: n[0] }) }
  return { kind: 'distance', a, b, value: n[0], ...(rest[1] && { tol: n[1] }) }
}, RequirementObject)

const View = z.enum(['iso', 'front', 'top', 'right', 'back', 'left', 'bottom', 'iso-back', 'iso-below'])
const Section = z.object({ normal: z.union([z.enum(['x', 'y', 'z']), V3]), offset: z.number().optional(), keep: z.enum(['below', 'above']).optional() }).strict()
const Render = { views: z.array(View).max(6).optional(), section: Section.optional() }
const Note = z.string().max(120).optional()

export const WriteAssembly = z.object({ id: Id, name: z.string().min(1).max(80), instances: z.array(InstanceSchema).max(200), requirements: z.array(RequirementSchema).max(100).optional(), clearance: z.number().min(0).max(50).optional(), note: Note, ...Render }).strict()
export const Place = z.object({ assembly: Id, instances: z.array(InstancePatch).max(200), note: Note, ...Render }).strict()
export const RemoveInstances = z.object({ assembly: Id, ids: z.array(Id).min(1), note: Note }).strict()
export const ReadAssembly = z.object({ assembly: Id, version: z.number().int().min(1).optional() }).strict()
export const CheckAssembly = z.object({ assembly: Id, clearance: z.number().min(0).max(50).optional(), requirements: z.array(RequirementSchema).max(100).optional(), time_limit: z.number().min(1).max(240).optional(), ...Render }).strict()
export const RenderAssembly = z.object({ assembly: Id, ...Render, size: z.number().int().min(200).max(1000).optional(), caption: z.string().max(500).optional() }).strict()
export const DuplicateAssembly = z.object({ assembly: Id, id: Id, name: z.string().min(1).max(80) }).strict()
export const SwapComponent = z.object({ assembly: Id, instance: Id, component: ComponentId, name: z.string().min(1).max(80).optional(), note: Note }).strict()
export const ExportAssembly = z.object({ assembly: Id, version: z.number().int().min(1).optional() }).strict()

export function invalid(input: unknown, error: z.ZodError) {
  return JSON.stringify({ INVALID_INPUT: input, problems: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
}
