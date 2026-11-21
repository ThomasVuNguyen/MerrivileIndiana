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
  | { role: 'ai'; text: string; calls: CallState[]; model?: string; error?: boolean; notes?: ChangeNote[] }

/** The tessellation served to the viewer. Arrays are base64 little-endian. */
export type PartMesh = {
  positions: string
  indices: string
  edges: string
  faceRanges: [number, number][]
  edgeRanges: [number, number][]
  faces: { type: string; area: number; center: number[]; normal?: number[]; radius?: number }[]
}

export type ServerEvent =
  | { type: 'snapshot'; project: ProjectInfo; parts: PartDoc[]; chat: ChatEntry[]; running: boolean }
  | { type: 'shop-snapshot'; items: ShopItem[]; tools: ShopTool[]; chat: ChatEntry[]; running: boolean }
  | { type: 'chat'; entry: ChatEntry; index: number }
  | { type: 'text'; index: number; delta: string }
  | { type: 'call'; index: number; call: CallState }
  | { type: 'part'; part: PartDoc }
  | { type: 'part_removed'; id: string }
  | { type: 'running'; running: boolean }
  | { type: 'notes'; index: number; notes: ChangeNote[] }
  | { type: 'shop'; items: ShopItem[]; tools: ShopTool[] }

export type ClientEvent =
  | { type: 'send'; text: string; faces?: FaceRef[]; modelId?: string; images?: Attachment[] }
  | { type: 'stop' }
  | { type: 'undo'; index: number; changeId: string }
  | { type: 'restore'; part: string; version: number }

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
