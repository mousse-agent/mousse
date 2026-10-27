import { Fragment } from 'react'
import { Minus, Plus, RotateCcw } from '../../lib/icons'
import type { GitFileChange, GitScope } from '../../../shared/types'
import {
  groupChanges,
  rowActionLabel,
  rowActions,
  sectionAction,
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

const ROW_ACTION_TITLES: Record<RowAction, string> = { stage: 'Stage', unstage: 'Unstage', discard: 'Discard' }
const SECTION_ACTION_TITLES: Record<SectionAction, string> = { 'stage-all': 'Stage all', 'unstage-all': 'Unstage all' }

export type { SelectedFile }

type ScopeRules = Pick<GitScope, 'workspaceThreadId'>

function RowActionIcon({ action }: { action: RowAction }) {
  if (action === 'stage') return <Plus size={13} strokeWidth={2} aria-hidden="true" />
  if (action === 'unstage') return <Minus size={13} strokeWidth={2} aria-hidden="true" />
  return <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
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

/** One list of files. A selected row has a background highlight only. */
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
          const isSelected = selected?.path === item.path && selected.staged === item.staged
          return (
            <div key={`${item.staged}-${item.path}`} className={`git-file-row${isSelected ? ' selected' : ''}`}>
              <button
                type="button"
                className="git-file-select"
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => onSelect(item.path, item.staged)}
              >
                <span className={`git-status-badge status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
                <span className="git-file-path">{item.path}</span>
              </button>
              {actions.length > 0 && (
                <span className="git-row-actions">
                  {actions.map((action) => (
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
 * both Staged and Changes, each with the actions of its own side.
 */
export function GitChangesList({ changes, selected, onSelect, scope, busy, onRowAction, onSectionAction, flex, bindSectionRef, onDividerMouseDown }: GitChangesListProps) {
  const groups = groupChanges(changes)
  const shown = CHANGE_SECTIONS.filter(({ group }) => groups[group].length > 0)
  if (shown.length === 0) {
    return <div className="git-empty git-empty-nested">Working tree clean</div>
  }
  const divider = (upper: GitSectionId, lower: GitSectionId) => (
    <div
      key={`divider-${upper}-${lower}`}
      className="git-section-divider"
      onMouseDown={() => onDividerMouseDown?.(upper, lower)}
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${SECTION_TITLES[upper]} and ${SECTION_TITLES[lower]} sections`}
    />
  )
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
