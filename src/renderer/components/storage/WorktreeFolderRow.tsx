import type { WorktreeFolderStatus } from '../../../shared/storage'
import { SettingsRow } from '../settings/SettingsRow'

/** What the Worktree folder row says under its title. */
function folderDescription(status: WorktreeFolderStatus | undefined) {
  if (!status) return 'Loading…'
  const earlier = status.previous.length > 0 && <span className="storage-rule-line">
    Worktrees made earlier stay where they are: {status.previous.map((entry, index) => <span key={entry.folder}>{index > 0 && ', '}<code className="storage-folder-path">{entry.folder}</code>{!entry.connected && ' (drive not connected)'}</span>)}.
  </span>
  if (!status.folder) return <>
    <span className="storage-rule-line">New worktrees go in Mousse's own folder, <code className="storage-folder-path">{status.defaultFolder}</code>.</span>
    {earlier}
  </>
  return <>
    <span className="storage-rule-line">New worktrees go in <code className="storage-folder-path">{status.folder}</code>, one folder per project.</span>
    {!status.connected && <span className="storage-rule-line storage-folder-offline" data-testid="storage-worktree-folder-offline">Drive not connected. Threads with worktrees there wait for it, and new worktrees go in Mousse's own folder until it is back.</span>}
    {earlier}
  </>
}

/**
 * Settings → Storage → Worktree folder: where new worktrees go, on another drive for example. Choosing a folder opens the
 * system's folder picker; Use default goes back to Mousse's own folder. Worktrees already made never move.
 */
export function WorktreeFolderRow({ status, busy, onChoose, onReset }: {
  status: WorktreeFolderStatus | undefined
  busy: boolean
  onChoose: () => void
  onReset: () => void
}) {
  return <SettingsRow
    data-testid="storage-worktree-folder"
    title="Worktree folder"
    description={folderDescription(status)}
    control={<>
      {status?.folder && <button type="button" className="settings-btn" data-testid="storage-worktree-folder-reset" disabled={busy} onClick={onReset}>Use default</button>}
      <button type="button" className="settings-btn" data-testid="storage-worktree-folder-choose" disabled={busy || !status} onClick={onChoose}>Choose…</button>
    </>}
  />
}
