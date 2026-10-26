import { useMemo } from 'react'
import { ChevronRight } from '../lib/icons'
import { isRunningSubagent } from '../../shared/subagents'
import { useSubagents } from '../hooks/useSubagents'
import { openThread } from '../lib/openThread'
import { useAppStore } from '../stores/appStore'
import { BANNER_MAX_DEPTH, collectNeedingInput, needingInputLabel, type NeedingInput } from './subagentBannerLogic'
import './subagentComposerBanner.css'

interface SubagentComposerBannerViewProps {
  asking: readonly NeedingInput[]
  onOpen: (childThreadId: string) => void
}

/**
 * Top of the composer. A subagent that needs an answer gets a row that opens the question in the
 * subagent's thread, where it is answered. Renders nothing while none asks; what the subagents are
 * doing shows in the chat's subagent group and the side card.
 */
export function SubagentComposerBannerView({ asking, onOpen }: SubagentComposerBannerViewProps) {
  if (asking.length === 0) return null
  return (
    <div className="composer-banner" role="status">
      {asking.map((entry) => {
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
      })}
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

/** The banner for `threadId`, from the subagents the store holds. */
export function SubagentComposerBanner({ threadId }: { threadId: string | null }) {
  const subagents = useSubagents(threadId)
  const lists = useAppStore((s) => s.subagentsByParent)
  const asking = useMemo(() => collectNeedingInput(lists, threadId), [lists, threadId])
  return (
    <>
      {threadId && subagents.filter(isRunningSubagent).map((subagent) => (
        <WatchBelow key={subagent.childThreadId} threadId={subagent.childThreadId} depth={2} />
      ))}
      <SubagentComposerBannerView asking={asking} onOpen={(childThreadId) => void openThread(childThreadId)} />
    </>
  )
}
