import { Lock } from '../lib/icons'
import { useAppStore } from '../stores/appStore'
import '../styles/private-threads.css'

/** Top of a private thread (`Thread.localOnly`): says the thread stays on this computer. */
export function ThreadModeBarView({ localOnly }: { localOnly: boolean }) {
  if (!localOnly) return null
  return (
    <div className="thread-mode-bar" role="status" data-mode="private">
      <Lock size={12} strokeWidth={2} aria-hidden="true" />
      <span className="thread-mode-bar-text">
        Private thread <span className="thread-mode-bar-detail">· stays on this computer, hidden from your other devices</span>
      </span>
    </div>
  )
}

/** Shown above the selected thread when it is private. */
export function ThreadModeBar() {
  const localOnly = useAppStore((state) => {
    const thread = state.threads.find((entry) => entry.id === state.activeThreadId)
    if (thread?.localOnly) return true
    // A new chat with Private switched on is private before its thread exists.
    return !thread?.startedAt && state.composerWorkspaceDrafts[state.activeThreadId ?? '__blank__']?.localOnly === true
  })
  return <ThreadModeBarView localOnly={localOnly} />
}
