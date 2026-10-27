import { useEffect, useState } from 'react'
import type { PullRequestPushTarget, ThreadPullRequestLink } from '../../../shared/pullRequests'

/**
 * Where Push goes for a thread that works in its own worktree and is linked to a pull request: the pull
 * request's branch when the daemon can prove it is the same repository, else the reason it is not.
 * Null while unknown and for a thread without a link.
 */
export function usePullRequestPushTarget(workspaceThreadId: string | null, link: ThreadPullRequestLink | null): PullRequestPushTarget | null {
  const [answer, setAnswer] = useState<{ key: string; target: PullRequestPushTarget } | null>(null)
  const key = workspaceThreadId && link ? `${workspaceThreadId}\u0000${link.host}\u0000${link.nameWithOwner}\u0000${link.number}\u0000${link.linkedAt}` : null
  useEffect(() => {
    if (!key || !workspaceThreadId) return
    let current = true
    window.mousse.pullRequests.pushTarget(workspaceThreadId).then(
      (target) => {
        if (current) setAnswer({ key, target })
      },
      () => {
        if (current) setAnswer(null)
      }
    )
    return () => {
      current = false
    }
  }, [key, workspaceThreadId])
  return key !== null && answer?.key === key ? answer.target : null
}
