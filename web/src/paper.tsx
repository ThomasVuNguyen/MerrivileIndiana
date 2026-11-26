// Small pieces of the Paper look shared by the Shop, Settings and the part sheet.

import type { ChangeNote, Tier } from '../shared/protocol'
import { Avatar } from './session'

export const TIER_LABEL: Record<Tier, string> = { 'on-hand': 'on hand', prime: 'prime', order: 'order' }

export function TopBar({ active }: { active: 'projects' | 'shop' | 'library' | 'components' | 'settings' }) {
  return (
    <header className="projects-top">
      <a className="wordmark" href="#/projects">
        merrivile
      </a>
      <nav className="top-nav">
        <a href="#/projects" className={active === 'projects' ? 'is-on' : ''}>
          Projects
        </a>
        <a href="#/shop" className={active === 'shop' ? 'is-on' : ''}>
          Shop
        </a>
        <a href="#/library" className={active === 'library' ? 'is-on' : ''}>
          Library
        </a>
        <a href="#/components" className={active === 'components' ? 'is-on' : ''}>
          Components
        </a>
        <Avatar />
      </nav>
    </header>
  )
}

export function SettingsTabs({ active }: { active: 'models' | 'memory' }) {
  return (
    <nav className="settings-tabs">
      <a href="#/settings" className={active === 'models' ? 'is-on' : ''}>
        Models
      </a>
      <a href="#/settings/memory" className={active === 'memory' ? 'is-on' : ''}>
        Memory
      </a>
    </nav>
  )
}

/** Solid, hatched or open square: on hand, Prime, order. Reads in black and white. */
export function TierMark({ tier }: { tier: Tier }) {
  return <i className={`tier-mark tier-mark--${tier}`} aria-hidden />
}

export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className="tier">
      <TierMark tier={tier} />
      {TIER_LABEL[tier]}
    </span>
  )
}

/** A change the AI made to memory or the shop, with undo right there. */
export function NoteChip({ note, onToggle }: { note: ChangeNote; onToggle?: () => void }) {
  return (
    <div className={`note note--${note.kind}${note.undone ? ' is-undone' : ''}`}>
      <span className="note-kind">{note.kind === 'memory' ? 'Saved to memory' : note.kind === 'library' ? 'Saved to library' : 'Shop updated'}</span>
      <span className="note-text">{note.text}</span>
      {onToggle && (
        <button className="link" onClick={onToggle}>
          {note.undone ? 'Redo' : 'Undo'}
        </button>
      )}
    </div>
  )
}
