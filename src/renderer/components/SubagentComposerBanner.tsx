import { useMemo } from 'react'
import { ChevronRight } from '../lib/icons'
import { isRunningSubagent } from '../../shared/subagents'
import { useSubagents } from '../hooks/useSubagents'
import { openThread } from '../lib/openThread'
import { useAppStore } from '../stores/appStore'
import { BANNER_MAX_DEPTH, composerBanner, needingInputLabel, type NeedingInput } from './subagentBannerLogic'
import './subagentComposerBanner.css'

interface SubagentComposerBannerViewProps {
  asking: readonly NeedingInput[]
  /** Why the thread is still Waiting; shown only while no subagent asks. */
  waiting: string | null
  onOpen: (childThreadId: string) => void
}

/**
 * Top of the composer. A subagent that needs an answer gets a row that opens the question in the
 * subagent's thread, where it is answered; with none asking, a quiet line says what the thread is
 * still waiting on. Renders nothing when there is neither.
 */
export function SubagentComposerBannerView({ asking, waiting, onOpen }: SubagentComposerBannerViewProps) {
  if (asking.length === 0 && !waiting) return null
  return (
    <div className="composer-banner" role="status">
      {asking.length > 0
        ? asking.map((entry) => {
            const label = needingInputLabel(entry)
            return (
              <button
                key={entry.childThreadId}
                type="button"
                className="composer-banner-row"
                title={`Open ${entry.title}`}
                aria-label={`${label}. Open ${entry.title}`}
                onClick={() => onOpen(entry.childThreadId)}
              >
                <span className="composer-banner-dot" aria-hidden="true" />
                <span className="composer-banner-text">{label}</span>
                <ChevronRight className="composer-banner-chevron" size={14} aria-hidden="true" />
              </button>
            )
          })
        : <div className="composer-banner-row is-quiet"><span className="composer-banner-text">{waiting}</span></div>}
    </div>
  )
}

/** Keeps the lists of the subagents still going below `threadId` fresh, so a question deep in the tree reaches the banner. */
function WatchBelow({ threadId, depth }: { threadId: string; depth: number }) {
  const subagents = useSubagents(threadId)
  if (depth >= BANNER_MAX_DEPTH) return null
  return (
    <>
      {subagents.filter(isRunningSubagent).map((subagent) => (
        <WatchBelow key={subagent.childThreadId} threadId={subagent.childThreadId} depth={depth + 1} />
      ))}
    </>
  )
}

/** The banner for `threadId`, from the subagents the store holds and the thread's own activity. */
export function SubagentComposerBanner({ threadId }: { threadId: string | null }) {
  const subagents = useSubagents(threadId)
  const lists = useAppStore((s) => s.subagentsByParent)
  const activity = useAppStore((s) => (threadId ? s.threadActivity[threadId] : undefined))
  const { asking, waiting } = useMemo(() => composerBanner({ lists, activity, threadId }), [lists, activity, threadId])
  return (
    <>
      {threadId && subagents.filter(isRunningSubagent).map((subagent) => (
        <WatchBelow key={subagent.childThreadId} threadId={subagent.childThreadId} depth={2} />
      ))}
      <SubagentComposerBannerView asking={asking} waiting={waiting} onOpen={(childThreadId) => void openThread(childThreadId)} />
    </>
  )
}
