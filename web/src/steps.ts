import type { ToolCall } from './data'

// What each tool call looks like to the person: a short verb phrase, not the tool's name.
const VERBS: Record<string, (what: string) => string> = {
  search_shop: () => 'Checked the shop',
  add_shop_items: (w) => `Added ${w}`,
  update_shop_items: (w) => `Updated ${w}`,
  remove_shop_items: (w) => `Removed ${w.replace(/ removed$/, '').replace(/^(\d+)$/, '$1 items')}`,
  set_item_picture: (w) => `Pictured ${w.replace(/ · picture$/, '')}`,
  upsert_tools: (w) => `Saved ${/^\d+ tools$/.test(w) ? w : `tool ${w}`}`,
  remove_tool: (w) => `Removed ${w.replace(/ removed$/, '')}`,
  read_link: () => 'Read a product page',
  run_python: (w) => (w.startsWith('failed') ? 'Python hit an error' : `Ran Python${/file/.test(w) ? `, made ${w.split(' · ')[1]}` : ''}`),
  search_library: () => 'Searched the Library',
  open_library_item: (w) => `Opened ${w}`,
  save_to_library: (w) => `Saved ${w} to the Library`,
  remember: () => 'Saved a preference',
  forget: () => 'Forgot a preference',
  read_part: (w) => `Read ${w}`,
  write_part: (w) => `Built ${w}`,
  edit_part: (w) => `Edited ${w}`,
  set_part_hardware: (w) => `Listed hardware for ${w}`,
  import_step: (w) => `Imported ${w.split(' → ')[0]}`,
  import: (w) => `Imported ${w}`,
  restore: (w) => `Restored ${w}`,
}
// Chats from before the shop tools took batches.
VERBS.add_shop_item = VERBS.add_shop_items
VERBS.update_shop_item = VERBS.update_shop_items
VERBS.remove_shop_item = VERBS.remove_shop_items
VERBS.upsert_tool = VERBS.upsert_tools

/** "Built motor-plate v3", from write_part with "motor-plate v3 · 120 faces · 12.3 cm³". */
export function stepLabel(c: ToolCall) {
  const what = c.detail.split(' · ')[0].trim()
  const verb = VERBS[c.tool]
  if (c.state === 'error' && !verb) return `${c.tool} failed`
  return verb ? verb(c.tool === 'run_python' || c.tool === 'upsert_tools' ? c.detail : what).trim() : c.tool.replace(/_/g, ' ')
}

/** "Checked the shop, added 66 items, saved 18 tools" — the first few distinct steps. */
export function stepSummary(calls: ToolCall[]) {
  const labels = [...new Set(calls.map(stepLabel))]
  const shown = labels.slice(0, 3).map((l, i) => (i ? l.charAt(0).toLowerCase() + l.slice(1) : l))
  return `${shown.join(', ')}${labels.length > 3 ? ` +${labels.length - 3}` : ''}`
}

/** The parts of a step's detail its label doesn't already say: "66 items" under "Added 66 items" is dropped. */
export function stepDetail(c: ToolCall, label = stepLabel(c)) {
  const said = label.toLowerCase()
  return c.detail
    .split(' · ')
    .filter((part) => part && part !== 'ran' && !said.includes(part.toLowerCase()))
    .join(' · ')
}

export function seconds(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} m ${s % 60} s`
}
