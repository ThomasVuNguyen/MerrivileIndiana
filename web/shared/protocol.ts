// Types shared by the browser and the Worker.

export type Provider = 'anthropic' | 'workers-ai' | 'openai'

/** A model the user added in Settings. The API key never leaves the server. */
export type ModelInfo = {
  id: string
  label: string
  provider: Provider
  model: string
  baseUrl?: string
  accountId?: string
  vision: boolean
  keyHint: string
  isDefault: boolean
  createdAt: number
}

export type NewModel = {
  label: string
  provider: Provider
  model: string
  apiKey: string
  baseUrl?: string
  accountId?: string
  vision?: boolean
}

export type ProjectInfo = { id: string; name: string; parts: number; updatedAt: number; thumb?: string }

export type PartMetrics = {
  volume_mm3: number
  area_mm2: number
  bbox: { min: number[]; max: number[]; size: [number, number, number] }
  center: number[]
  solids: number
  faces: number
  edges: number
  valid: boolean
}

export type BuildError = { type: string; message: string; line: number | null; trace: { line: number | null; code: string }[] }

/** A part document: build123d source plus the files of its last good build. */
export type PartDoc = {
  id: string
  name: string
  color: string
  material: string
  density: number
  version: number
  source: string
  status: 'ok' | 'error'
  error?: BuildError
  metrics?: PartMetrics
  files?: { mesh: string; step: string; stl: string; render: string; thumb: string }
  /** Files the source reads with asset(name), such as an imported STEP. */
  assets?: string[]
  /** Parts the source uses with part("id"). */
  uses?: string[]
  /** Parts it uses that got a newer version after this one was built; a rebuild clears it. */
  stale?: { part: string; version: number }[]
  /** Separate solids `result` is meant to hold (a print plate); unset means one. */
  bodies?: number
  /** Named datums the source publishes (`datums = {...}` next to `result`), for assemblies to snap to. */
  datums?: Record<string, Datum>
  /** Hardware the part uses and the tools it needs, set by the AI. */
  hardware?: PartHardware[]
  madeWith?: string[]
  /** Newest first. */
  versions?: { version: number; note: string; at: number }[]
  updatedAt: number
}

export type PartHardware = { qty: number; name: string; kind: string; tier: Tier; source: string; itemId?: string }

export type Tier = 'on-hand' | 'prime' | 'order'

/** Something in the shop: a screw size, a bearing, a length of extrusion. */
export type ShopItem = {
  id: string
  /** The size, as it's said out loud: "M3 × 8", "608ZZ", "2020". */
  name: string
  /** What it is: "Socket head cap screw". */
  kind: string
  category: string
  detail?: string
  qty?: number
  /** The count it started at (pack size), for the level bar. */
  full?: number
  unit?: string
  bin?: string
  tier: Tier
  price?: string
  link?: string
  /** URL of its picture: a photo, a crop of a screenshot, or a render. */
  image?: string
  notes?: string
  updatedAt: number
}

export type ShopTool = { id: string; name: string; kind: 'machine' | 'hand' | 'service'; can: string; have: boolean; updatedAt: number }

export type Memory = { id: string; text: string; scope: string; scopeName?: string; source: string; createdAt: number }

/** A change the AI made to the shop, memory or library, shown in chat with an undo. */
export type ChangeNote = { kind: 'memory' | 'shop' | 'library'; text: string; changeId: string; undone?: boolean }

/** A file in the Library: photos of the space, experiment data, anything. The note is yours; the description is the AI's, for search. */
/** `seen`: a video's description was written from its frames. */
export type LibraryItem = Attachment & { id: string; note: string; description?: string; seen?: boolean; createdAt: number }

export type FileKind = 'image' | 'video' | 'pdf' | 'text' | 'sheet' | 'doc' | 'step' | 'file'

/**
 * A file attached to a message, already uploaded. Photos keep their original
 * (any size, HEIC included) plus a JPEG preview the page and the AI use;
 * width/height are the preview's. Older messages only had images.
 *
 * Videos: the preview is a poster frame, `framesKey` a sheet of six frames
 * for the AI, and `playUrl` an MP4 copy when browsers can't play the original.
 */
export type Attachment = {
  key: string
  url: string
  kind?: FileKind
  name?: string
  size?: number
  width?: number
  height?: number
  previewKey?: string
  previewUrl?: string
  duration?: number
  framesKey?: string
  needsCopy?: boolean
  playKey?: string
  playUrl?: string
  /** The server is still making the poster or the playable copy. */
  processing?: boolean
  /** Why it couldn't, shown on the file. */
  problem?: string
  /** Shown under a render an outside agent put in the chat. */
  caption?: string
}

/** A face the user picked in the viewer, passed to the AI with their message. */
export type FaceRef = {
  part: string
  index: number
  type: string
  area: number
  center: number[]
  normal?: number[]
  radius?: number
}

export type CallState = { id: string; tool: string; detail: string; state: 'running' | 'done' | 'error'; ms?: number }

export type ChatEntry =
  | { role: 'user'; text: string; faces?: FaceRef[]; images?: Attachment[] }
  | { role: 'ai'; text: string; calls: CallState[]; model?: string; error?: boolean; notes?: ChangeNote[]; startedAt?: number; ms?: number; images?: Attachment[] }

/** The tessellation served to the viewer. Arrays are base64 little-endian. */
export type PartMesh = {
  positions: string
  indices: string
  edges: string
  faceRanges: [number, number][]
  edgeRanges: [number, number][]
  faces: { type: string; area: number; center: number[]; normal?: number[]; radius?: number }[]
}

// ---------------------------------------------------------------- datums, components, assemblies
//
// Frames and units: millimetres and degrees everywhere. A part or component has its own frame (the
// one its source or STEP file uses); an assembly places each instance with a 4x4 matrix.
//
// Matrices are 16 numbers, ROW-MAJOR, for column vectors: p_assembly = M · [x, y, z, 1]ᵀ, so the
// translation is M[3], M[7], M[11] and the last row is 0, 0, 0, 1. In three.js:
// `new THREE.Matrix4().set(...matrix)` (set() takes row-major; fromArray() would need a transpose).
//
// Plain placement is pos [x, y, z] then rot [rx, ry, rz], exactly build123d's
// Pos(x, y, z) * Rot(rx, ry, rz): rotate about the instance's own origin, X then Y then Z intrinsic
// (R = Rx · Ry · Rz), then move by pos.

export type Vec3 = [number, number, number]

/**
 * A named reference on a part or component, in its own frame. Plane normals point out of the
 * material (like a face normal), so two planes snap face to face. A plane is a full frame: origin,
 * normal and an in-plane x direction. A pattern is a set of hole centres with one normal.
 */
export type Datum =
  | { kind: 'plane'; origin: Vec3; normal: Vec3; x: Vec3 }
  | { kind: 'axis'; origin: Vec3; direction: Vec3 }
  | { kind: 'point'; at: Vec3 }
  | { kind: 'pattern'; points: Vec3[]; normal: Vec3; diameter?: number }

/** A datum the importer found, with why. */
export type SuggestedDatum = Datum & { note: string }

/**
 * A volume in a component's frame that other instances must stay out of ("USB plug clearance",
 * "lens field of view"). A cylinder or cone starts at origin and runs `length` along direction; a
 * cone opens at `angle` degrees (half-angle) from `radius` (default 0) at its start.
 */
export type KeepOut =
  | { kind: 'box'; label: string; min: Vec3; max: Vec3 }
  | { kind: 'cylinder'; label: string; origin: Vec3; direction: Vec3; radius: number; length: number }
  | { kind: 'cone'; label: string; origin: Vec3; direction: Vec3; angle: number; length: number; radius?: number }

/**
 * A bought part from a vendor STEP (a Raspberry Pi, a camera board, a lens), in the account-wide
 * library. Its geometry never changes; a new revision is a new import. Files are served to the
 * signed-in owner under /api/files/users/<uid>/components/<id>/.
 */
export type ComponentDoc = {
  id: string
  name: string
  vendor?: string
  partNumber?: string
  link?: string
  notes?: string
  source: { kind: 'url' | 'upload' | 'library' | 'text'; name: string; url?: string; libraryId?: string }
  /** SHA-256 of its BREP; the geometry service caches the shape by it. */
  hash: string
  metrics: PartMetrics
  /** Datums snaps use. Import fills them with the suggestions; set_component_datums edits them. */
  datums: Record<string, Datum>
  /** What the importer found: hole patterns in the board plane, the largest flat face, bores. */
  suggested: Record<string, SuggestedDatum>
  /** Round holes found on import (in the base plane when they're square to it). */
  holes: { diameter: number; at: Vec3; direction: Vec3 }[]
  /** Its extent in its own frame (the bounding box unless set). */
  outline: { min: Vec3; max: Vec3 }
  keepouts: KeepOut[]
  /** `mesh` is a PartMesh (same format as parts); `render` a 4-view sheet; `step` the original file. */
  files: { step: string; brep: string; mesh: string; render: string; thumb: string }
  createdAt: number
  updatedAt: number
}

/**
 * Put datum `own` of the instance being placed onto datum `to` of an instance placed before it.
 * `to` is "<instance>.<datum>", or "<sub>/<child>.<datum>" inside a sub-assembly (instance ids have
 * no dots, so the address splits at its first dot). Like with like: plane → plane (face to face;
 * flip: same way), axis → axis (coaxial, same direction; flip: opposed), point → point,
 * pattern → pattern (best rigid fit; normals opposed, flip: same way). offset moves along the target's
 * normal or axis (mm); spin turns about it (degrees).
 */
export type Snap = { own: string; to: string; offset?: number; flip?: boolean; spin?: number }

export type InstanceRef = { part: string; version?: number } | { component: string } | { assembly: string }

/**
 * One instance as written: a part (following its latest good version unless `version` pins one), a
 * component, or another assembly (a sub-assembly). Placed by pos/rot or by one or two snaps; the
 * ground (`ground: true`, else the first instance) stays at its pos/rot.
 */
export type InstanceSpec = {
  /** Stable kebab-case id, unique in the assembly. */
  id: string
  name: string
  ref: InstanceRef
  /** Overrides the part's colour. */
  color?: string
  ground?: boolean
  pos?: Vec3
  rot?: Vec3
  snap?: Snap | Snap[]
}

/** How well a snap was met after placing: residuals, and per point for patterns. */
export type SnapResult = {
  own: string
  to: string
  kind: Datum['kind']
  residual_mm: number
  residual_deg: number
  rms_mm?: number
  points_mm?: number[]
  note?: string
}

/** An instance after placing. `matrix` is in the assembly's frame. */
export type AssemblyInstance = InstanceSpec & {
  matrix: number[]
  /** unresolved: a snap couldn't be met (missing datum or instance); it kept its last matrix. */
  status: 'ok' | 'unresolved'
  problem?: string
  snaps?: SnapResult[]
  /** The part version it was placed with. */
  version?: number
}

/**
 * What to draw: every part and component instance, sub-assemblies flattened, with its matrix in
 * the assembly's frame. `path` is "<instance>" or "<sub>/<child>". `mesh` is a PartMesh URL in the
 * shape's own frame (a part version's files.mesh or a component's files.mesh): draw it with
 * `matrix`. `color` is one distinct colour per instance.
 */
export type AssemblyLeaf = {
  path: string
  name: string
  ref: { part: string; version: number } | { component: string }
  matrix: number[]
  mesh: string
  color: string
}

/** A declared alignment, checked on every save. a and b are datum addresses like snap `to`. */
export type Requirement =
  | { kind: 'coaxial'; a: string; b: string; tol_mm?: number; tol_deg?: number; name?: string }
  | { kind: 'parallel'; a: string; b: string; tol_deg?: number; name?: string }
  | { kind: 'distance'; a: string; b: string; value: number; tol?: number; name?: string }

export type FindingKind =
  | 'clash' // common volume > 0.001 mm³
  | 'tight_gap' // closer than the clearance, not touching
  | 'contact' // touching (< 0.001 mm), info
  | 'floating' // not connected to the ground through touching instances
  | 'keepout' // inside a component's keep-out
  | 'unresolved' // a snap couldn't be met
  | 'pattern_fit' // hole patterns fit worse than 0.05 mm
  | 'snap_conflict' // two snaps that can't both be met
  | 'requirement' // a declared alignment (info when met, warning when not)
  | 'snap' // a note about a snap (e.g. a symmetric pattern), info
  | 'ground' // the ground's snap is ignored, info
  | 'error' // an instance couldn't be built or a keep-out is malformed

/**
 * One finding of an assembly check. Warnings never block a save. `instances` are paths; `at` and
 * `bbox` are in the assembly's frame. Clashes and keep-out intrusions carry `mesh`, a PartMesh URL of
 * the overlapping volume (assembly frame, draw it red without a matrix).
 */
export type Finding = {
  kind: FindingKind
  severity: 'warning' | 'info'
  instances: string[]
  message: string
  value?: number
  unit?: 'mm' | 'mm³' | 'deg'
  at?: Vec3
  bbox?: { min: Vec3; max: Vec3 }
  mesh?: string
  keepout?: string
  requirement?: string
  /** Requirements: met or not. */
  ok?: boolean
  /** Requirements with several numbers (coaxial: angle and offset). */
  measures?: { name: string; value: number; unit: string; tol?: number }[]
}

export type CheckReport = {
  at: number
  ms: number
  /** The time limit stopped the check early; some pairs weren't looked at. */
  partial: boolean
  clearance: number
  warnings: number
  counts: Partial<Record<FindingKind, number>>
  findings: Finding[]
  pairsChecked: number
  pairsSkipped: number
}

/** An assembly in a project: instances, placements, requirements and the last check. */
export type AssemblyDoc = {
  id: string
  name: string
  version: number
  instances: AssemblyInstance[]
  leaves: AssemblyLeaf[]
  requirements: Requirement[]
  /** Tight-gap threshold, mm (default 0.2). */
  clearance: number
  /** The instance fixed in place. */
  ground: string
  report?: CheckReport
  /** The coloured 4-view sheet of the last save (clashes red) and its thumbnail. */
  files?: { render: string; thumb: string }
  /** Parts or sub-assemblies it uses that changed since this placement; the next save re-places it. */
  stale?: { ref: string; version?: number }[]
  /** Newest first. */
  versions?: { version: number; note: string; at: number }[]
  updatedAt: number
}

/** One of the chats in the Shop or in a project; they share the shop, memory, Library and parts. */
export type ThreadInfo = { id: string; title: string; updatedAt: number; messages: number }

/**
 * Chat events (chat, text, call, notes) go only to sockets showing that thread; indexes are
 * positions in it. `thread` "" is a new chat that starts with its first message.
 */
export type ServerEvent =
  | { type: 'snapshot'; project: ProjectInfo; parts: PartDoc[]; assemblies: AssemblyDoc[]; chat: ChatEntry[]; running: boolean; threads: ThreadInfo[]; thread: string }
  | { type: 'shop-snapshot'; items: ShopItem[]; tools: ShopTool[]; chat: ChatEntry[]; running: boolean; threads: ThreadInfo[]; thread: string }
  | { type: 'thread'; thread: string; chat: ChatEntry[] }
  | { type: 'threads'; threads: ThreadInfo[] }
  | { type: 'chat'; entry: ChatEntry; index: number }
  | { type: 'text'; index: number; delta: string }
  | { type: 'call'; index: number; call: CallState }
  | { type: 'part'; part: PartDoc }
  | { type: 'part_removed'; id: string }
  | { type: 'assembly'; assembly: AssemblyDoc }
  | { type: 'assembly_removed'; id: string }
  | { type: 'running'; running: boolean; thread?: string }
  | { type: 'notes'; index: number; notes: ChangeNote[] }
  | { type: 'shop'; items: ShopItem[]; tools: ShopTool[] }

export type ClientEvent =
  | { type: 'send'; text: string; faces?: FaceRef[]; modelId?: string; images?: Attachment[] }
  | { type: 'stop' }
  | { type: 'undo'; index: number; changeId: string }
  | { type: 'restore'; part: string; version: number }
  | { type: 'open'; thread: string }
  | { type: 'delete-thread'; thread: string }

export const MATERIALS: Record<string, number> = {
  'Aluminum 6061': 2.7,
  'Steel 1018': 7.87,
  'Stainless 304': 8.0,
  Brass: 8.5,
  'Titanium Ti-6Al-4V': 4.43,
  PLA: 1.24,
  PETG: 1.27,
  ABS: 1.04,
  'Nylon PA12': 1.01,
  Polycarbonate: 1.2,
}
