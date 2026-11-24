import { Pause, Play, Stop, VolumeHigh } from '../lib/icons'
import { SpeechWave } from '../speech/SpeechWave'
import { useAppStore } from '../stores/appStore'
import { useReadAloudStore } from './readAloudStore'

/** The thread whose message is loading, playing or paused, or null. */
export function useSpeakingThreadId(): string | null {
  return useReadAloudStore((state) => (state.status !== 'idle' ? state.threadId : null))
}

/**
 * That a thread is being read aloud, where its status goes: the sound wave while it plays (still while paused), or a
 * speaker when sidebar animations are off.
 */
export function ThreadSpeechMark() {
  const showWave = useAppStore((state) => state.sidebarAnimations)
  const paused = useReadAloudStore((state) => state.status === 'paused')
  const levels = useReadAloudStore((state) => (showWave ? state.levels : null))
  return (
    <span className="threads-sidebar-speech-mark" role="img" aria-label="Reading aloud" title="Reading aloud">
      {showWave ? <SpeechWave levels={levels} paused={paused} /> : <VolumeHigh size={13} strokeWidth={2} aria-hidden="true" />}
    </span>
  )
}

/**
 * Beside the speaking thread in the sidebar, in place of its time and logo: Pause or Resume, and Stop throughout, so a
 * reading whose own button has gone (selected text, once its bar closes) can still be ended. `wave` adds the sound
 * wave (a card, which has no gap before its title for it).
 */
export function ThreadSpeechIndicator({ wave = false }: { wave?: boolean }) {
  const loading = useReadAloudStore((state) => state.status === 'loading')
  const paused = useReadAloudStore((state) => state.status === 'paused')
  const stop = useReadAloudStore((state) => state.stop)
  const togglePause = useReadAloudStore((state) => state.togglePause)
  const label = paused ? 'Resume reading aloud' : 'Pause reading aloud'
  return (
    <span className="threads-sidebar-speech">
      {wave && !loading && <ThreadSpeechMark />}
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
    </span>
  )
}
