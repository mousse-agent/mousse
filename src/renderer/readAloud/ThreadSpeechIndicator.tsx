import { Pause, Play } from '../lib/icons'
import { SpeechWave } from '../speech/SpeechWave'
import { useAppStore } from '../stores/appStore'
import { useReadAloudStore } from './readAloudStore'

/** The thread whose message is playing or paused, or null. */
export function useSpeakingThreadId(): string | null {
  return useReadAloudStore((state) => (state.status === 'playing' || state.status === 'paused' ? state.threadId : null))
}

/** Playback button and optional sound wave beside the speaking thread in the sidebar. */
export function ThreadSpeechIndicator() {
  const showWave = useAppStore((state) => state.sidebarAnimations)
  const paused = useReadAloudStore((state) => state.status === 'paused')
  const levels = useReadAloudStore((state) => showWave ? state.levels : null)
  const togglePause = useReadAloudStore((state) => state.togglePause)
  const label = paused ? 'Resume reading aloud' : 'Pause reading aloud'
  return (
    <span className="threads-sidebar-speech">
      <button
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
      </button>
      {showWave && <SpeechWave levels={levels} paused={paused} />}
    </span>
  )
}
