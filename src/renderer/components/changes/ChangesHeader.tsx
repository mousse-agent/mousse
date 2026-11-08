import { ArrowDown, Download, MoreHorizontal, Server } from '../../lib/icons'
import type { GitPullStrategy, GitScope } from '../../../shared/types'
import type { GitStatusView } from '../../stores/gitStatusStore'
import { BranchPicker } from '../sideCard/BranchPicker'
import { GIT_BUSY_REASON, gitActionLock, THREAD_BRANCH_SWITCH_REASON, type GitAction } from '../sideCard/gitSectionLogic'
import { abortLabel, syncActivityLine, syncControls, syncLabel, syncState, type SyncActivity } from '../git/gitSyncLogic'
import { Select } from '../ui/Select'
import { MenuButton, type MenuItem } from './MenuButton'
import { headerFit, SCOPE_FILTER_AFTER, type HeaderContent, type ScopeMenuOption } from './changesModel'

export interface SyncChipModel {
  /** Icon and number that always stay: ↑2 ↓1. */
  core: string | null
  /** Words beside them: the remote computer, "offline", "detached", "conflict". */
  text: string | null
  /** The text is a remote computer's name, which never disappears. */
  computer: boolean
  tone: 'neutral' | 'warning' | 'danger'
  title: string
}

interface ChangesHeaderProps {
  width: number
  scopeValue: string
  scopeTitle: string
  scopeOptions: readonly ScopeMenuOption[]
  scopeDisabled: boolean
  onScope: (value: string) => void
  /** A turn is running on the shown scope. */
  live: boolean
  content: HeaderContent
  chip: SyncChipModel | null
  onCounts: () => void
  menu: readonly MenuItem[]
  /** Branch picker and sync actions behind the chip. */
  git: { path: string; scope: GitScope; view: GitStatusView; fileCount: number }
  running: GitAction | null
  begin: (action: GitAction) => boolean
  end: () => void
  activity: SyncActivity
  onSync: (request: { action: 'fetch' } | { action: 'pull'; strategy: GitPullStrategy } | { action: 'abort'; kind: 'merge' | 'rebase' }) => void
  onError: (message: string | null) => void
  onNotice: (message: string | null) => void
}

/** Fetch, Pull (merge or rebase once diverged) and Abort, at the bottom of the branch picker. */
function SyncActions({ view, scope, activity, running, onSync }: { view: GitStatusView; scope: GitScope; activity: SyncActivity; running: GitAction | null; onSync: ChangesHeaderProps['onSync'] }) {
  const state = syncState(view.status)
  if (!state) return null
  const controls = syncControls(view.status, scope)
  const line = syncActivityLine(activity)
  const active = activity.phase === 'running' ? activity.action : null
  const locked = running !== null || active !== null
  const idle = locked ? GIT_BUSY_REASON : undefined
  return (
    <div className="changes-sync">
      <p className="changes-sync-label">{syncLabel(state)}</p>
      <div className="changes-sync-actions">
        <button type="button" className="changes-secondary" title={controls.fetch.reason ?? idle ?? 'Fetch from the remote'} disabled={locked || !controls.fetch.enabled} onClick={() => onSync({ action: 'fetch' })}>
          <Download size={13} strokeWidth={2} aria-hidden="true" />
          {active === 'fetch' ? 'Fetching…' : 'Fetch'}
        </button>
        {controls.pull.choices.map((strategy) => (
          <button
            key={strategy}
            type="button"
            className="changes-secondary"
            title={controls.pull.reason ?? idle ?? (strategy === 'ff-only' ? 'Pull, fast-forward only' : `Pull and ${strategy}`)}
            disabled={locked || !controls.pull.enabled}
            onClick={() => onSync({ action: 'pull', strategy })}
          >
            <ArrowDown size={13} strokeWidth={2} aria-hidden="true" />
            {active === 'pull' ? 'Pulling…' : strategy === 'ff-only' ? 'Pull' : strategy === 'merge' ? 'Pull: Merge' : 'Pull: Rebase'}
          </button>
        ))}
        {controls.abort && (
          <button type="button" className="changes-secondary" title={idle} disabled={locked} onClick={() => onSync({ action: 'abort', kind: controls.abort as 'merge' | 'rebase' })}>
            {active === 'abort' ? 'Aborting…' : abortLabel(controls.abort)}
          </button>
        )}
      </div>
      {line && <p className="changes-sync-line" data-tone={line.role === 'alert' ? 'error' : undefined} role={line.role}>{line.text}</p>}
    </div>
  )
}

/**
 * One line: the scope menu, the file count (and how many are left once something is viewed), the sync chip when
 * it has something to say, and "…". Narrow panes drop line totals, then `N left`, then the chip's words, then
 * shorten the scope label.
 */
export function ChangesHeader(props: ChangesHeaderProps) {
  const { width, content, chip, git } = props
  const fit = headerFit(width, content, chip?.computer ?? false)
  const chipContent = chip ? (
    <>
      {chip.computer && <Server size={12} strokeWidth={2} aria-hidden="true" />}
      {chip.core && <span className="changes-chip-core">{chip.core}</span>}
      {chip.text && fit.showChipText && <span className="changes-chip-text">{chip.text}</span>}
    </>
  ) : null
  return (
    <div className="changes-header">
      <div className="changes-scope" data-live={props.live || undefined}>
        <Select
          size="small"
          ariaLabel="Show changes from"
          title={props.scopeTitle}
          value={props.scopeValue}
          options={props.scopeOptions}
          disabled={props.scopeDisabled}
          filterAfter={SCOPE_FILTER_AFTER}
          renderValue={() => (
            <span className="changes-scope-label">
              {props.live && <span className="changes-live-dot" aria-label="Turn running" />}
              {fit.scope}
            </span>
          )}
          onChange={props.onScope}
        />
      </div>
      <button type="button" className="changes-counts" title="Jump to a file (F)" onClick={props.onCounts}>
        <span>{content.count}</span>
        {fit.showLeft && content.left && <span className="changes-faint"> · {content.left}</span>}
        {fit.showTotals && content.totals && <span className="changes-stat changes-totals">{content.totals}</span>}
      </button>
      <span className="changes-header-gap" />
      {chip && (
        <BranchPicker
          path={git.path}
          scope={git.scope}
          status={git.view.status}
          branches={git.view.branches}
          fileCount={git.fileCount}
          busyLabel={props.running === 'checkout' ? 'Switching…' : props.running === 'branch' ? 'Updating branches…' : null}
          lock={gitActionLock(props.running, props.running === 'branch' ? 'branch' : 'checkout')}
          disabledReason={git.scope.workspaceThreadId !== null ? THREAD_BRANCH_SWITCH_REASON : null}
          onBegin={props.begin}
          onEnd={props.end}
          onActionError={props.onError}
          onNotice={props.onNotice}
          trigger={{ className: `changes-sync-chip${chip.tone === 'neutral' ? '' : ` is-${chip.tone}`}`, content: chipContent, title: chip.title }}
          footer={<SyncActions view={git.view} scope={git.scope} activity={props.activity} running={props.running} onSync={props.onSync} />}
        />
      )}
      <MenuButton label="More" items={props.menu}>
        <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
      </MenuButton>
    </div>
  )
}
