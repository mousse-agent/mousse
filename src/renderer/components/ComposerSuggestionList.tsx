import type { ComponentType, ReactNode } from 'react'
import { File, Folder, Link2, Settings, User } from '../lib/icons'
import type { MentionItem } from '../../shared/composerCommands'
import type { SkillDescriptor } from '../../shared/integrations'
import { isManagedSource, sourceLabel } from './integrations/integrationUi'

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
  emptyText?: ReactNode
  /** A status line under the rows ("Indexing files…"). */
  footer?: ReactNode
  /** Keeps the scroll-into-view refs the composer owns. */
  registerRow?: (index: number, element: HTMLButtonElement | null) => void
}

/** The listbox every composer picker (`/` commands and skills, `/skills`, `@` mentions, a bot's own commands) renders. */
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

/** Marks the first case-insensitive occurrence of `query` in `text`. */
export function markQuery(text: string, query: string): PathSegment[] {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (at < 0) return text ? [{ text, match: false }] : []
  const parts: PathSegment[] = [
    { text: text.slice(0, at), match: false },
    { text: text.slice(at, at + query.length), match: true },
    { text: text.slice(at + query.length), match: false }
  ]
  return parts.filter((part) => part.text.length > 0)
}

type SuggestionTone = 'command' | 'project' | 'personal' | 'other-app' | 'file'

interface SuggestionSource {
  tone: SuggestionTone
  /** Names the source in the icon's tooltip and accessible name ("Claude Code · project"). */
  label: string
}

/** Where a skill comes from: Mousse's own project or personal skills, or a copy from another app. */
export function skillSource(skill: Pick<SkillDescriptor, 'scope' | 'source' | 'managed'>): SuggestionSource {
  const scope = skill.scope === 'project' ? 'project' : 'personal'
  if (!skill.source || isManagedSource(skill.source, skill.managed)) {
    return scope === 'project' ? { tone: 'project', label: 'Project' } : { tone: 'personal', label: 'Personal' }
  }
  return { tone: 'other-app', label: `${sourceLabel(skill.source)} · ${scope}` }
}

const TONE_ICONS: Record<SuggestionTone, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  command: Settings,
  project: Folder,
  personal: User,
  'other-app': Link2,
  file: File
}

/**
 * One compact picker row: a 14px source icon, the name with its matched characters marked,
 * and an optional one-line description under it.
 */
export function SuggestionRowContent({
  source,
  icon,
  name,
  description
}: {
  source: SuggestionSource
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>
  name: ReactNode
  description?: ReactNode
}) {
  const Icon = icon ?? TONE_ICONS[source.tone]
  return (
    <span className="composer-suggestion-row">
      <span
        className={`composer-suggestion-icon composer-suggestion-icon-${source.tone}`}
        role="img"
        aria-label={source.label}
        title={source.label}
      >
        <Icon size={14} strokeWidth={1.8} />
      </span>
      <span className="composer-suggestion-text">
        <span className="composer-command-suggestion-name">{name}</span>
        {description ? <span className="composer-command-suggestion-description">{description}</span> : null}
      </span>
    </span>
  )
}

/** A skill row in any picker, its source shown by the icon. */
export function SkillRowContent({ skill, query = '' }: { skill: SkillDescriptor; query?: string }) {
  return (
    <SuggestionRowContent
      source={skillSource(skill)}
      name={<MarkedText segments={markQuery(skill.name, query)} />}
      description={skill.description || skill.id}
    />
  )
}

/** A command row (`/clear`, a bot's own command): the gear icon. */
export function CommandRowContent({ label, description, query = '' }: { label: string; description?: string; query?: string }) {
  return (
    <SuggestionRowContent
      source={{ tone: 'command', label: 'Command' }}
      name={<MarkedText segments={markQuery(label, query)} />}
      description={description}
    />
  )
}

/** One `@` picker row: a skill, or a file or folder with its parent folder on the second line. */
export function MentionRowContent({ item, query = '' }: { item: MentionItem<SkillDescriptor>; query?: string }) {
  if (item.kind === 'skill') return <SkillRowContent skill={item.skill} query={query} />
  const { name, dir } = splitMentionPath(item.path, item.positions)
  const isFolder = item.kind === 'directory'
  return (
    <SuggestionRowContent
      source={{ tone: 'file', label: isFolder ? 'Folder' : 'File' }}
      icon={isFolder ? Folder : File}
      name={<MarkedText segments={name} />}
      description={dir.length > 0 ? <MarkedText segments={dir} /> : null}
    />
  )
}
