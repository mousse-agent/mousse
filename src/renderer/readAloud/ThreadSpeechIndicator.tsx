import { Pause, Play } from '../lib/icons'
import { SpeechWave } from '../speech/SpeechWave'
import { useReadAloudStore } from './readAloudStore'

/** The thread whose message is playing or paused, or null. */
export function useSpeakingThreadId(): string | null {
  return useReadAloudStore((state) => (state.status === 'playing' || state.status === 'paused' ? state.threadId : null))
}

/** Pause or resume button and sound wave shown in the threads sidebar beside the speaking thread. */
export function ThreadSpeechIndicator() {
  const paused = useReadAloudStore((state) => state.status === 'paused')
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
      <SpeechWave paused={paused} />
    </span>
  )
}
