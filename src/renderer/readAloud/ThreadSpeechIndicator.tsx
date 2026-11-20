import { Pause, Play, Stop } from '../lib/icons'
import { SpeechWave } from '../speech/SpeechWave'
import { useAppStore } from '../stores/appStore'
import { useReadAloudStore } from './readAloudStore'

/** The thread whose message is loading, playing or paused, or null. */
export function useSpeakingThreadId(): string | null {
  return useReadAloudStore((state) => (state.status !== 'idle' ? state.threadId : null))
}

/**
 * Beside the speaking thread in the sidebar: Pause or Resume and the optional sound wave while it plays, and Stop
 * throughout, so a reading whose own button has gone (selected text, once its bar closes) can still be ended.
 */
export function ThreadSpeechIndicator() {
  const showWave = useAppStore((state) => state.sidebarAnimations)
  const loading = useReadAloudStore((state) => state.status === 'loading')
  const paused = useReadAloudStore((state) => state.status === 'paused')
  const stop = useReadAloudStore((state) => state.stop)
  const levels = useReadAloudStore((state) => showWave ? state.levels : null)
  const togglePause = useReadAloudStore((state) => state.togglePause)
  const label = paused ? 'Resume reading aloud' : 'Pause reading aloud'
  return (
    <span className="threads-sidebar-speech">
      {!loading && <button
        type="button"
        className="threads-sidebar-speech-toggle"
        aria-label={label}
        title={label}
        onClick={(event) => {
          event.stopPropagation()
          togglePause()
        }}
      >
        {paused ? <Play size={11} strokeWidth={2.2} aria-hidden="true" /> : <Pause size={11} strokeWidth={2.2} aria-hidden="true" />}
      </button>}
      <button
        type="button"
        className="threads-sidebar-speech-toggle"
        aria-label="Stop reading aloud"
        title="Stop reading aloud"
        onClick={(event) => {
          event.stopPropagation()
          stop()
        }}
      >
        <Stop size={11} strokeWidth={2.2} aria-hidden="true" />
      </button>
      {showWave && !loading && <SpeechWave levels={levels} paused={paused} />}
    </span>
  )
}
