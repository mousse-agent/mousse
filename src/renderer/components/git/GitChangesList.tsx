import { Fragment } from 'react'
import { Minus, Plus } from '../../lib/icons'
import type { GitFileChange, GitScope } from '../../../shared/types'
import { RowMenu } from '../integrations/RowMenu'
import {
  discardMenuLabel,
  groupChanges,
  keyedSectionRatio,
  rowActionLabel,
  rowActions,
  SECTION_RATIO_MAX,
  SECTION_RATIO_MIN,
  sectionAction,
  sectionPairRatio,
  STATUS_NAMES,
  type ChangeSectionId,
  type GitSectionId,
  type RowAction,
  type SectionAction,
  type SelectedFile
} from './gitPanelLogic'

const STATUS_LABELS: Record<GitFileChange['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  ignored: 'I',
  conflicted: '!'
}

export const SECTION_TITLES: Record<GitSectionId, string> = {
  conflicts: 'Conflicts',
  staged: 'Staged',
  changes: 'Changes',
  untracked: 'Untracked',
  commits: 'Commits'
}

const ROW_ACTION_TITLES: Record<Exclude<RowAction, 'discard'>, string> = { stage: 'Stage', unstage: 'Unstage' }
const SECTION_ACTION_TITLES: Record<SectionAction, string> = { 'stage-all': 'Stage all', 'unstage-all': 'Unstage all' }

export type { SelectedFile }

type ScopeRules = Pick<GitScope, 'workspaceThreadId'>

function RowActionIcon({ action }: { action: Exclude<RowAction, 'discard'> }) {
  if (action === 'stage') return <Plus size={13} strokeWidth={2} aria-hidden="true" />
  return <Minus size={13} strokeWidth={2} aria-hidden="true" />
}

interface ChangeSectionProps {
  id: ChangeSectionId
  items: GitFileChange[]
  selected: SelectedFile | null
  onSelect: (path: string, staged: boolean) => void
  scope: ScopeRules
  /** A Git action is running, so no row or section button may start another. */
  busy: boolean
  onRowAction: (action: RowAction, file: GitFileChange) => void
  onSectionAction: (action: SectionAction, files: GitFileChange[]) => void
  flex: number
  sectionRef?: (el: HTMLDivElement | null) => void
}

/**
 * One list of files. A selected row has a background highlight only. Stage or Unstage sits on the row; Discard, which
 * throws work away, waits in the row's More menu so the keyboard never lands on it next to Stage.
 */
export function ChangeSection({ id, items, selected, onSelect, scope, busy, onRowAction, onSectionAction, flex, sectionRef }: ChangeSectionProps) {
  const sectionButton = sectionAction(id, scope)
  return (
    <div className="git-section" data-section={id} style={{ flex: `${flex} 1 0` }} ref={sectionRef}>
      <div className="git-section-header">
        <div className="git-section-title">{SECTION_TITLES[id]}</div>
        {sectionButton && (
          <button
            type="button"
            className="git-section-action"
            disabled={busy}
            onClick={() => onSectionAction(sectionButton, items)}
          >
            {SECTION_ACTION_TITLES[sectionButton]}
          </button>
        )}
      </div>
      <div className="git-section-list">
        {items.map((item) => {
          const actions = rowActions(item, scope)
          const inline = actions.filter((action): action is Exclude<RowAction, 'discard'> => action !== 'discard')
          const statusName = STATUS_NAMES[item.status]
          const isSelected = selected?.path === item.path && selected.staged === item.staged
          return (
            <div key={`${item.staged}-${item.path}`} className={`git-file-row${isSelected ? ' selected' : ''}`}>
              <button
                type="button"
                className="git-file-select"
                aria-current={isSelected ? 'true' : undefined}
                aria-label={`${item.path}, ${statusName.toLowerCase()}`}
                onClick={() => onSelect(item.path, item.staged)}
              >
                <span className={`git-status-badge status-${item.status}`} title={statusName} aria-hidden="true">{STATUS_LABELS[item.status]}</span>
                <span className="git-file-path">{item.path}</span>
              </button>
              {actions.length > 0 && (
                <span className="git-row-actions">
                  {inline.map((action) => (
                    <button
                      key={action}
                      type="button"
                      className="git-row-action"
                      data-action={action}
                      title={ROW_ACTION_TITLES[action]}
                      aria-label={rowActionLabel(action, item)}
                      disabled={busy}
                      onClick={() => onRowAction(action, item)}
                    >
                      <RowActionIcon action={action} />
                    </button>
                  ))}
                  {actions.includes('discard') && (
                    <RowMenu
                      label={`More actions for ${item.path}`}
                      buttonClassName="git-row-action"
                      iconSize={13}
                      disabled={busy}
                      items={[{ label: discardMenuLabel(item), ariaLabel: rowActionLabel('discard', item), danger: true, onSelect: () => onRowAction('discard', item) }]}
                    />
                  )}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface GitChangesListProps {
  changes: readonly GitFileChange[]
  selected: SelectedFile | null
  onSelect: (path: string, staged: boolean) => void
  scope: ScopeRules
  busy: boolean
  onRowAction: (action: RowAction, file: GitFileChange) => void
  onSectionAction: (action: SectionAction, files: GitFileChange[]) => void
  flex: Record<GitSectionId, number>
  bindSectionRef?: (id: GitSectionId) => (el: HTMLDivElement | null) => void
  onDividerMouseDown?: (upper: GitSectionId, lower: GitSectionId) => void
  /** Moves the divider between two sections to `ratio`, the upper one's share of the pair. */
  onDividerResize?: (upper: GitSectionId, lower: GitSectionId, ratio: number) => void
}

const CHANGE_SECTIONS: readonly { id: ChangeSectionId; group: 'conflicts' | 'staged' | 'unstaged' | 'untracked' }[] = [
  { id: 'conflicts', group: 'conflicts' },
  { id: 'staged', group: 'staged' },
  { id: 'changes', group: 'unstaged' },
  { id: 'untracked', group: 'untracked' }
]

/**
 * The Conflicts, Staged, Changes and Untracked lists with the dividers between them, and one
 * closing divider above the Commits list that follows. A file staged and edited again is in
 * both Staged and Changes, each with the actions of its own side. A divider is dragged, or
 * focused and moved with the arrow keys, Home and End.
 */
export function GitChangesList({ changes, selected, onSelect, scope, busy, onRowAction, onSectionAction, flex, bindSectionRef, onDividerMouseDown, onDividerResize }: GitChangesListProps) {
  const groups = groupChanges(changes)
  const shown = CHANGE_SECTIONS.filter(({ group }) => groups[group].length > 0)
  if (shown.length === 0) {
    return <div className="git-empty git-empty-nested">Working tree clean</div>
  }
  const divider = (upper: GitSectionId, lower: GitSectionId) => {
    const ratio = sectionPairRatio(flex, upper, lower)
    return (
      <div
        key={`divider-${upper}-${lower}`}
        className="git-section-divider"
        onMouseDown={() => onDividerMouseDown?.(upper, lower)}
        onKeyDown={(event) => {
          const next = onDividerResize ? keyedSectionRatio(ratio, event.key) : null
          if (next === null) return
          event.preventDefault()
          onDividerResize?.(upper, lower, next)
        }}
        role="separator"
        tabIndex={onDividerResize ? 0 : undefined}
        aria-orientation="horizontal"
        aria-label={`Resize ${SECTION_TITLES[upper]} and ${SECTION_TITLES[lower]} sections`}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={Math.round(SECTION_RATIO_MIN * 100)}
        aria-valuemax={Math.round(SECTION_RATIO_MAX * 100)}
        aria-valuetext={`${SECTION_TITLES[upper]} ${Math.round(ratio * 100)}%`}
      />
    )
  }
  return (
    <>
      {shown.map(({ id, group }, index) => (
        <Fragment key={id}>
          {index > 0 && divider(shown[index - 1].id, id)}
          <ChangeSection
            id={id}
            items={groups[group]}
            selected={selected}
            onSelect={onSelect}
            scope={scope}
            busy={busy}
            onRowAction={onRowAction}
            onSectionAction={onSectionAction}
            flex={flex[id]}
            sectionRef={bindSectionRef?.(id)}
          />
        </Fragment>
      ))}
      {divider(shown[shown.length - 1].id, 'commits')}
    </>
  )
}
