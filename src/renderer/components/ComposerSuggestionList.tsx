import type { ReactNode } from 'react'
import { File, Folder, Sparkles } from '../lib/icons'
import type { MentionItem } from '../../shared/composerCommands'

export interface SuggestionRow {
  key: string
  content: ReactNode
}

interface ComposerSuggestionListProps {
  rows: SuggestionRow[]
  selected: number
  ariaLabel: string
  onHover: (index: number) => void
  onPick: (index: number) => void
  /** Shown instead of rows when there are none. */
  emptyText?: string
  /** A status line under the rows ("Indexing files…"). */
  footer?: ReactNode
  /** Keeps the scroll-into-view refs the composer owns. */
  registerRow?: (index: number, element: HTMLButtonElement | null) => void
}

/** The listbox every composer picker (slash commands, `/skills`, `@` mentions) renders. */
export function ComposerSuggestionList({
  rows,
  selected,
  ariaLabel,
  onHover,
  onPick,
  emptyText,
  footer,
  registerRow
}: ComposerSuggestionListProps) {
  return (
    <div
      id="composer-command-suggestions"
      className="composer-command-suggestions scrollbar-ultra-thin"
      role="listbox"
      aria-label={ariaLabel}
      // Keep focus (and any input method composition) in the text box while the list is clicked.
      onMouseDown={(event) => event.preventDefault()}
    >
      {rows.length === 0 && emptyText ? <div className="composer-command-suggestion-empty">{emptyText}</div> : null}
      {rows.map((row, index) => (
        <button
          key={row.key}
          ref={(element) => registerRow?.(index, element)}
          id={`composer-command-suggestion-${index}`}
          className={`composer-command-suggestion${index === selected ? ' selected' : ''}`}
          type="button"
          role="option"
          aria-selected={index === selected}
          onMouseEnter={() => onHover(index)}
          onClick={() => onPick(index)}
        >
          {row.content}
        </button>
      ))}
      {footer ? <div className="composer-mention-footer" role="presentation">{footer}</div> : null}
    </div>
  )
}

export interface PathSegment {
  text: string
  match: boolean
}

/** Splits `text` (which starts at `offset` in the full path) into runs of matched and unmatched characters. */
function segmentsFor(text: string, offset: number, positions: ReadonlySet<number>): PathSegment[] {
  const segments: PathSegment[] = []
  for (let i = 0; i < text.length; i++) {
    const match = positions.has(offset + i)
    const last = segments[segments.length - 1]
    if (last && last.match === match) last.text += text[i]
    else segments.push({ text: text[i], match })
  }
  return segments
}

/** The basename and the parent folder of a result path, each with its matched characters marked. */
export function splitMentionPath(path: string, positions: number[]): { name: PathSegment[]; dir: PathSegment[] } {
  const trimmedLength = path.replace(/\/+$/, '').length
  const slash = path.lastIndexOf('/', trimmedLength - 1)
  const set = new Set(positions)
  return {
    dir: segmentsFor(path.slice(0, slash + 1), 0, set),
    name: segmentsFor(path.slice(slash + 1), slash + 1, set)
  }
}

export function MarkedText({ segments }: { segments: PathSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => (segment.match ? <mark key={index}>{segment.text}</mark> : segment.text))}
    </>
  )
}

/** One `@` picker row: a skill (with a badge) or a file or folder with its parent folder dimmed. */
export function MentionRowContent({ item }: { item: MentionItem }) {
  if (item.kind === 'skill') {
    return (
      <span className="composer-mention-row">
        <Sparkles size={14} className="composer-mention-icon" />
        <span className="composer-command-suggestion-name">{item.skill.name}</span>
        <span className="composer-mention-badge">Skill</span>
        <span className="composer-command-suggestion-description composer-mention-description">
          {item.skill.description || item.skill.id}
        </span>
      </span>
    )
  }
  const { name, dir } = splitMentionPath(item.path, item.positions)
  const Icon = item.kind === 'directory' ? Folder : File
  return (
    <span className="composer-mention-row">
      <Icon size={14} className="composer-mention-icon" />
      <span className="composer-command-suggestion-name composer-mention-name">
        <MarkedText segments={name} />
      </span>
      {dir.length > 0 ? (
        <span className="composer-mention-path">
          <MarkedText segments={dir} />
        </span>
      ) : null}
    </span>
  )
}
