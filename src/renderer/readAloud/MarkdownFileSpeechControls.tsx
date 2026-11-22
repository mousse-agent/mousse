import { Loader2, Pause, Play, Stop, VolumeHigh } from '../lib/icons'
import { SpeechWave } from '../speech/SpeechWave'
import './markdownFileSpeech.css'
import { markdownFileSpeechKey, useMarkdownFileSpeech } from './markdownFileSpeech'
import { useReadAloudStore } from './readAloudStore'

/** Sibling controls to the tab's select button, inside the same pill. */
export function MarkdownFileSpeechControls({ scope, path }: { scope: string; path: string }) {
  const speechKey = markdownFileSpeechKey(scope, path)
  const markdown = useMarkdownFileSpeech((s) => s.previews[speechKey])
  const status = useReadAloudStore((s) => s.activeKey === speechKey ? s.status : 'idle')
  const error = useReadAloudStore((s) => s.error?.key === speechKey ? s.error.message : null)
  const levels = useReadAloudStore((s) => s.activeKey === speechKey ? s.levels : null)
  if (markdown === undefined) return null
  const playing = status === 'playing' || status === 'paused'
  const paused = status === 'paused'
  const label = status === 'idle' ? 'Read aloud' : 'Stop reading'
  const pauseLabel = paused ? 'Resume reading aloud' : 'Pause reading aloud'
  return <span className="markdown-file-speech" onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onAuxClick={(e) => e.stopPropagation()}>
    <button type="button" className="markdown-file-speech-button" aria-label={label}
      title={error ?? (status === 'loading' ? 'Preparing audio, click to stop' : label)}
      aria-busy={status === 'loading' || undefined}
      onClick={() => useReadAloudStore.getState().toggle(speechKey, markdown, { inThread: false })}>
      {status === 'loading' ? <Loader2 size={13} className="animate-spin" /> : status === 'idle' ? <VolumeHigh size={13} /> : <Stop size={13} />}
    </button>
    {playing && <>
      <SpeechWave levels={levels} paused={paused} />
      <button type="button" className="markdown-file-speech-button" aria-label={pauseLabel} title={pauseLabel}
        onClick={() => useReadAloudStore.getState().togglePause()}>
        {paused ? <Play size={13} /> : <Pause size={13} />}
      </button>
    </>}
    {error && <span className="sr-only" role="alert">{error}</span>}
  </span>
}
