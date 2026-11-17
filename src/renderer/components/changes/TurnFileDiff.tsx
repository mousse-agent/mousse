import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type { DocumentTab } from '../../../shared/types'
import type { ReviewFileResult } from '../../../shared/review'
import { FileCode, RefreshCw } from '../../lib/icons'
import { useAppStore } from '../../stores/appStore'
import { openFileInPanel } from '../../utils/chatLinks'
import { scopeKey } from '../review/reviewComments'
import { ChangesDiff, type HunkActions, type LineRange } from './ChangesDiff'
import './changes.css'

type TurnFileTab = DocumentTab & { turnFile: NonNullable<DocumentTab['turnFile']> }

const WORKTREE = { kind: 'worktree' } as const
const REVIEW_SCOPE = scopeKey(WORKTREE)
/** Read-only: no Include, no Revert. */
const NO_ACTIONS: HunkActions = {
  canRevert: false,
  revertOff: null,
  canInclude: false,
  includeOff: null,
  includedOf: () => null,
  onRevert: () => undefined,
  onInclude: () => undefined
}

/**
 * A file a thread's agent wrote that the Changes tab does not list (it is in another repository), shown in the
 * Documents tab as its uncommitted change: the Changes tab's diff, compared with the last commit of the file's own
 * repository, without Include or Revert.
 */
export function TurnFileDiff({ tab, tabs }: { tab: TurnFileTab; tabs: ReactNode }) {
  const { threadId, profileId, path } = tab.turnFile
  const available = useAppStore((s) => s.profileId) === profileId
  const [version, setVersion] = useState(0)
  const [focusedHunk, setFocusedHunk] = useState<number | null>(null)
  const selectionRef = useRef<LineRange | null>(null)
  const target = useMemo(() => ({ threadId, scope: WORKTREE }), [threadId])

  const read = useCallback(async (): Promise<ReviewFileResult> => {
    const result = await window.mousse.review.turnFile({ threadId, path })
    if (result.kind === 'diff') return result.version
    throw new Error(result.kind === 'missing' ? 'This file no longer exists' : 'This file has no uncommitted change')
  }, [threadId, path])

  return (
    <div className="document-panel">
      <div className="document-toolbar">
        {tabs}
        <button type="button" className="document-copy" aria-label="Reload" title="Reload" disabled={!available} onClick={() => setVersion((value) => value + 1)}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        <button type="button" className="document-copy" aria-label="Open file" title="Open file" disabled={!available} onClick={() => openFileInPanel({ path, threadId })}>
          <FileCode size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="turn-file-diff-head">
        <span className="turn-file-diff-path" title={path}>{path}</span>
        <span className="turn-file-diff-note">Uncommitted change, compared with its repository’s last commit</span>
      </div>
      <div className="document-preview turn-file-diff-body scrollbar-ultra-thin">
        {available ? (
          <ChangesDiff
            target={target}
            path={path}
            version={version}
            ignoreWhitespace={false}
            split={false}
            scopeLabel="Uncommitted"
            reviewScope={REVIEW_SCOPE}
            focusedHunk={focusedHunk}
            onFocusHunk={setFocusedHunk}
            onHunks={() => undefined}
            onContent={() => undefined}
            commentRequest={0}
            selectionRef={selectionRef}
            actions={NO_ACTIONS}
            read={read}
          />
        ) : (
          <p className="changes-card-note" role="status">Open this file from its thread.</p>
        )}
      </div>
    </div>
  )
}
