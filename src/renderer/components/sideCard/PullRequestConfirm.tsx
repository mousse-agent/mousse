import { useEffect, useRef, useState } from 'react'
import { GitMerge } from '../../lib/icons'
import { closePullRequest, mergePullRequest, pullRequestMergeMethod } from '../../stores/pullRequestStore'
import type { PullRequestMergeMethod } from '../../../shared/pullRequests'
import {
  GIT_BUSY_REASON,
  gitErrorMessage,
  mergeConfirmation,
  mergedNotice,
  type GitAction,
  type PullRequestFoundRow
} from './gitSectionLogic'

/**
 * Merge or close one pull request; resolves with the reason it failed, or null once it is done. `method` is the merge
 * method the confirmation named, which the merge must use; absent when it could not be read.
 */
export type PullRequestChange = (action: 'merge' | 'close', row: PullRequestFoundRow, method?: PullRequestMergeMethod) => Promise<string | null>

/** The method Merge will use for a pull request; null when it cannot be read. */
export type PullRequestMergeMethodRead = (row: PullRequestFoundRow) => Promise<PullRequestMergeMethod | null>

/**
 * Merge and Close for the pull requests of one folder and branch, run under a surface's one-action lock. A merge sends
 * the head that was shown, so the host refuses it if more was pushed since, and the method the confirmation named.
 * `threadId` is the thread the folder's reads are made as, so a thread on another computer merges there.
 */
export function pullRequestActions(input: {
  path: string
  branch: string | null
  projectId: string | null
  threadId: string | null
  begin: (action: GitAction) => boolean
  end: () => void
  onNotice: (message: string) => void
}): { change: PullRequestChange; readMergeMethod: PullRequestMergeMethodRead } {
  const { path, branch, projectId, threadId, begin, end, onNotice } = input
  const target = (row: PullRequestFoundRow) => ({ path, branch, number: row.value, ...(threadId ? { threadId } : projectId ? { projectId } : {}) })
  const change: PullRequestChange = async (action, row, method) => {
    if (!begin(action)) return GIT_BUSY_REASON
    try {
      if (action === 'merge') {
        const result = await mergePullRequest(target(row), row.merge?.headSha ?? undefined, method)
        onNotice(mergedNotice(row.value, result.method))
      } else {
        await closePullRequest(target(row))
        onNotice(`Closed ${row.number}.`)
      }
      return null
    } catch (error) {
      return gitErrorMessage(error)
    } finally {
      end()
    }
  }
  return { change, readMergeMethod: (row) => pullRequestMergeMethod(target(row)) }
}

interface PullRequestConfirmProps {
  row: PullRequestFoundRow
  action: 'merge' | 'close'
  /** The Git action running on the surface, if any: one at a time. */
  running: GitAction | null
  onChange?: PullRequestChange
  /** Reads the merge method when the Merge confirmation opens, so it can name it. */
  readMergeMethod?: PullRequestMergeMethodRead
  /** The merge or close went through. */
  onDone: () => void
  /** Cancel or Escape, while nothing runs. */
  onDismiss: () => void
}

/**
 * The confirmation before a pull request is merged or closed. It takes focus on Cancel, so a stray Enter does nothing
 * final; the Merge one names the target branch and the method, read once when it opens, and its button waits for it.
 */
export function PullRequestConfirm({ row, action, running, onChange, readMergeMethod, onDone, onDismiss }: PullRequestConfirmProps) {
  const [error, setError] = useState<string | null>(null)
  // Undefined while it is read, null when it could not be.
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod | null | undefined>(undefined)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const working = running === action
  useEffect(() => {
    cancelRef.current?.focus()
  }, [])
  // The method is read once per confirmation; a refreshed row does not ask again.
  const readRef = useRef({ readMergeMethod, row })
  readRef.current = { readMergeMethod, row }
  useEffect(() => {
    const { readMergeMethod: read, row: asked } = readRef.current
    if (action !== 'merge' || !read) return
    let current = true
    read(asked).then((method) => { if (current) setMergeMethod(method) }, () => { if (current) setMergeMethod(null) })
    return () => { current = false }
  }, [action])
  const mergePrompt = mergeConfirmation(row.number, row.base, readMergeMethod ? mergeMethod : null)
  const dismiss = () => {
    if (!working) onDismiss()
  }
  const run = async () => {
    if (!onChange || running !== null) return
    setError(null)
    // The merge uses the method the prompt named, never one read again later.
    const failure = await onChange(action, row, action === 'merge' ? mergeMethod ?? undefined : undefined)
    if (failure) setError(failure)
    else onDone()
  }
  return (
    <div
      className="side-card-git-pr-confirm"
      role="group"
      aria-label={action === 'close' ? `Close ${row.number}` : `Merge ${row.number}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        dismiss()
      }}
    >
      <p className="side-card-git-pr-confirm-text">
        {action === 'close' ? `Close ${row.number} without merging? Its branch stays.` : mergePrompt.text}
      </p>
      {error && <p className="side-card-git-error" role="alert" title={error}>{error}</p>}
      <div className="side-card-git-pr-confirm-actions">
        <button ref={cancelRef} type="button" className="side-card-git-submit side-card-git-submit-quiet" disabled={working} onClick={dismiss}>
          Cancel
        </button>
        {action === 'merge' ? (
          <button
            type="button"
            className="side-card-git-pr-merge"
            data-ready
            aria-busy={working}
            // Not before the method is known: the button names what it does.
            disabled={running !== null || (readMergeMethod !== undefined && mergeMethod === undefined)}
            onClick={() => void run()}
          >
            <GitMerge size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>{working ? 'Merging…' : mergePrompt.action}</span>
          </button>
        ) : (
          <button type="button" className="side-card-git-submit" aria-busy={working} disabled={running !== null} onClick={() => void run()}>
            {working ? 'Closing…' : 'Close pull request'}
          </button>
        )}
      </div>
    </div>
  )
}
