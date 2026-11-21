import type { ReactNode } from 'react'

const BULLET = /^\s*(?:[-*]|\d+\.)\s+/

/** The few bits of Markdown models use in replies: paragraphs, bullets, **bold**, `code`, [links](url). */
export function Prose({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/)
  return (
    <>
      {blocks.map((block, i) => {
        const lines = block.split('\n')
        // A lead-in line ("My choices:") followed by bullets renders as text plus a list.
        const first = lines.findIndex((l) => BULLET.test(l))
        if (first >= 0 && lines.slice(first).every((l) => BULLET.test(l)))
          return (
            <div key={i}>
              {first > 0 && <p>{inline(lines.slice(0, first).join(' '))}</p>}
              <ul>
                {lines.slice(first).map((l, j) => (
                  <li key={j}>{inline(l.replace(BULLET, ''))}</li>
                ))}
              </ul>
            </div>
          )
        const heading = lines[0].match(/^#{1,4}\s+(.*)$/)
        if (heading && lines.length === 1) return <p key={i} className="prose-head">{inline(heading[1])}</p>
        return <p key={i}>{lines.map((l, j) => (j ? [<br key={j} />, inline(l)] : inline(l)))}</p>
      })}
    </>
  )
}

const LINK = /^!?\[([^\]]*)\]\(([^)\s]+)\)$/

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|!?\[[^\]]*\]\([^)\s]+\))/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>
    const link = part.match(LINK)
    if (link) return <Link key={i} label={link[1]} href={link[2]} />
    return part
  })
}

// Files the AI made (charts, cleaned CSVs) and web pages. A chart shows inline.
function Link({ label, href }: { label: string; href: string }) {
  const own = href.startsWith('/api/files/')
  if (!own && !/^https?:\/\//.test(href)) return <>{label}</>
  if (own && /\.(png|jpe?g|gif|webp)$/i.test(href))
    return (
      <a className="prose-figure" href={href} target="_blank" rel="noreferrer">
        <img src={href} alt={label} />
        <span>{label}</span>
      </a>
    )
  return (
    <a className="prose-link" href={href} target={own ? undefined : '_blank'} rel="noreferrer" download={own ? label || true : undefined}>
      {label || href}
    </a>
  )
}

/** One line for the dock: the reply's first paragraph, without Markdown. */
export function plainFirst(text: string) {
  const first = text.trim().split(/\n{2,}/)[0] ?? ''
  return first.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s+/, '')
}
