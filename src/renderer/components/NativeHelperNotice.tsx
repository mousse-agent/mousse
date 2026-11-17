import { useState } from 'react'
import type { Thread, ThreadNativeHelper } from '../../shared/types'
import { openThread } from '../lib/openThread'
import { stopThreadNow } from '../lib/stopThread'
import { useAppStore } from '../stores/appStore'

const RUNTIME_NAMES: Record<ThreadNativeHelper['runtime'], string> = { codex: 'Codex', claude: 'Claude Code' }

const STATE_LABELS: Record<ThreadNativeHelper['state'], string> = {
  running: 'running',
  done: 'finished',
  failed: 'failed',
  stopped: 'stopped',
  unknown: 'ended (how is not known)'
}

/** Whether the thread is a native helper's mirror: watched here, never written to. */
export function isWatchOnlyThread(thread: Pick<Thread, 'native'> | undefined): boolean {
  return Boolean(thread?.native)
}

interface NativeHelperNoticeViewProps {
  native: ThreadNativeHelper
  hostName: string | undefined
  onOpenHost?: () => void
  /** Present when this helper can be stopped on its own (a running Codex helper). */
  onStop?: () => void
  stopping?: boolean
}

/**
 * Top of the composer of a native helper's mirror thread (docs/plans/tool-api.md §2.7). The runtime runs the helper
 * inside another thread's run, so this thread is watch-only: the line names the runtime and the hosting thread, opens
 * the hosting thread (where the helper's approvals are asked) and, for a running Codex helper, stops it alone.
 */
export function NativeHelperNoticeView({ native, hostName, onOpenHost, onStop, stopping }: NativeHelperNoticeViewProps) {
  const runtime = RUNTIME_NAMES[native.runtime]
  const host = hostName ?? 'its thread'
  const write = native.sendTo ? ` To write to it, ask ${host} to use SendMessage with ${native.sendTo}.` : ''
  return (
    <div className="composer-banner" role="status">
      <div className="composer-banner-row" title={`${runtime} runs this helper inside ${host}. Its approvals are asked there.${write}`}>
        <span className="composer-banner-text">{runtime} helper of {host} · {STATE_LABELS[native.state]} · watch only</span>
        {onOpenHost && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenHost}>
            Open {host}
          </button>
        )}
        {onStop && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={stopping} onClick={onStop}>
            Stop
          </button>
        )}
      </div>
    </div>
  )
}

/** The watch-only line of the active thread when it is a native helper's mirror; nothing otherwise. */
export function NativeHelperNotice({ thread }: { thread: Thread | undefined }) {
  const hostThreadId = thread?.native ? thread.lineage?.parentThreadId : undefined
  const hostName = useAppStore((s) => (hostThreadId ? s.threads.find((candidate) => candidate.id === hostThreadId)?.name : undefined))
  const [stopping, setStopping] = useState(false)
  if (!thread?.native) return null
  const canStop = thread.native.stoppable === true && thread.native.state === 'running'
  return (
    <NativeHelperNoticeView
      native={thread.native}
      hostName={hostName}
      {...(hostThreadId ? { onOpenHost: () => void openThread(hostThreadId) } : {})}
      {...(canStop
        ? {
            stopping,
            onStop: () => {
              setStopping(true)
              void stopThreadNow(thread.id).finally(() => setStopping(false))
            }
          }
        : {})}
    />
  )
}
