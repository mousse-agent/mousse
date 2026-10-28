import { UNKNOWN_COMPUTER_NAME, useComputer } from '../lib/computers'
import { useAppStore } from '../stores/appStore'
import '../styles/computers.css'

/** What a surface of the app panel says for a thread of another computer, or undefined when it works as usual. */
export function surfaceNoteFor(view: string, thread: { node?: string; projectId?: string } | undefined, computer: string): { title: string; detail: string } | undefined {
  if (!thread?.node) return undefined
  if (view === 'browser')
    return {
      title: `The browser for this thread runs on ${computer}`,
      detail: `Pages the agent opens appear in ${computer}'s window. Screenshots it takes stay in the transcript.`
    }
  if (view === 'files' && !thread.projectId)
    return {
      title: `This thread has no folder on ${computer}`,
      detail: 'Start a chat in a project to browse its files here.'
    }
  return undefined
}

/**
 * Covers a surface of the app panel with the reason it has nothing to show for the thread in view, which
 * runs on another computer. The surface stays mounted underneath, so what a person left open on this
 * computer's own threads is still there when they come back.
 */
export function ComputerSurfaceNote() {
  const mainView = useAppStore((state) => state.mainView)
  const thread = useAppStore((state) => state.threads.find((entry) => entry.id === state.activeThreadId))
  const computer = useComputer(thread?.node)
  const note = surfaceNoteFor(mainView, thread, computer?.name ?? UNKNOWN_COMPUTER_NAME)
  if (!note) return null
  return (
    <div className="computer-note computer-note-overlay" role="status">
      <strong>{note.title}</strong>
      <span>{note.detail}</span>
    </div>
  )
}
