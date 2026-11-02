import { useEffect, useRef, useState } from 'react'
import type { AppErrorShape } from '../../shared/errors'
import { useAppStore } from '../stores/appStore'
import { normalizeTranscriptionError, normalizeVoiceError } from '../utils/voiceErrors'
import { currentSpeechPreferences } from '../speech/speechPreferences'
import { useDictationStore } from './dictationStore'
import { openMicrophone, type Microphone } from './microphone'
import type { AudioLevels } from '../speech/audioLevels'
import { startLiveTranscription, type LiveTranscription } from './liveTranscription'
import { warmLocalEngine } from './localEngine'
import { transcribeRecording } from './transcribe'

const NOTICE_VISIBLE_MS = 4000
export const NO_SPEECH_MESSAGE = 'No speech was recognized'

export interface UseDictationOptions {
  disabled: boolean
  loading: boolean
  /** Receives the text of a finished recording. */
  onTranscript: (text: string) => void
}

/**
 * The composer's microphone button: records with the microphone and turns the recording into text
 * with the dictation model. The first use asks which model to use, then starts recording.
 */
export function useDictation({ disabled, loading, onTranscript }: UseDictationOptions) {
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  /** A local model's recording, transcribed while the user speaks; providers use the recorder. */
  const liveRef = useRef<LiveTranscription | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingTimerRef = useRef<number | null>(null)
  const recordingStartRef = useRef<number>(0)
  /** When the user asked to stop, for the stop-to-text time in the log. */
  const stopRequestedRef = useRef<number | null>(null)
  const noticeTimerRef = useRef<number | null>(null)
  const captureTicket = useRef(0)
  const capturePending = useRef(false)
  const captureMounted = useRef(true)
  const captureMicrophone = useRef<Microphone | null>(null)
  const onTranscriptRef = useRef(onTranscript)
  const startRef = useRef<() => void>(() => undefined)
  onTranscriptRef.current = onTranscript

  const [isRecording, setIsRecording] = useState(false)
  const [recordingPending, setRecordingPending] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [levels, setLevels] = useState<AudioLevels | null>(null)
  const [error, setError] = useState<AppErrorShape>()
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    captureMounted.current = true
    return () => {
      captureMounted.current = false
      captureTicket.current += 1
      if (recordingTimerRef.current) window.clearInterval(recordingTimerRef.current)
      if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
      const recorder = mediaRecorderRef.current
      if (recorder) {
        recorder.onstop = null
        recorder.onerror = null
        recorder.ondataavailable = null
        if (recorder.state === 'recording') recorder.stop()
      }
      liveRef.current?.cancel()
      liveRef.current = null
      captureMicrophone.current?.stop()
    }
  }, [])

  const stopRecordingTimer = () => {
    if (recordingTimerRef.current) {
      window.clearInterval(recordingTimerRef.current)
      recordingTimerRef.current = null
    }
  }

  const showNotice = (message: string) => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current)
    setNotice(message)
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
    }, NOTICE_VISIBLE_MS)
  }

  /** Shows the text `work` produces for the recording that just stopped. */
  const transcribe = async (work: () => Promise<string>, ticket: number) => {
    const live = () => captureMounted.current && ticket === captureTicket.current
    const stopRequested = stopRequestedRef.current ?? performance.now()
    const recordingReady = performance.now()
    stopRequestedRef.current = null
    setTranscribing(true)
    try {
      const text = (await work()).trim()
      console.info(
        `[dictation] stop to text ${Math.round(performance.now() - stopRequested)} ms ` +
          `(recording ready after ${Math.round(recordingReady - stopRequested)} ms)`
      )
      if (!live()) return
      if (text) onTranscriptRef.current(text)
      else showNotice(NO_SPEECH_MESSAGE)
    } catch (failure) {
      if (live()) setError(normalizeTranscriptionError(failure))
    } finally {
      if (live()) setTranscribing(false)
    }
  }

  /** Turns a finished recorder file into text with the selected model. */
  const transcribeBlob = async (blob: Blob): Promise<string> => {
    const selection = useDictationStore.getState().selection
    if (!selection) throw new Error('No dictation model is selected. Choose one under Settings, Speech.')
    return blob.size > 0 ? transcribeRecording(blob, selection) : ''
  }

  const begin = async () => {
    if (loading || isRecording || transcribing || disabled || capturePending.current || !captureMounted.current) return
    const ticket = ++captureTicket.current
    capturePending.current = true
    setRecordingPending(true)
    setError(undefined)
    setNotice(null)
    // Load the model while the user speaks rather than after they stop.
    const selection = useDictationStore.getState().selection
    if (selection?.source === 'local') warmLocalEngine(selection.modelId)
    let microphone: Microphone | undefined
    const fail = (failure: unknown) => {
      stopRecordingTimer()
      const recorder = mediaRecorderRef.current
      if (recorder) {
        recorder.onstop = null
        recorder.onerror = null
        recorder.ondataavailable = null
        if (recorder.state === 'recording') recorder.stop()
      }
      liveRef.current?.cancel()
      liveRef.current = null
      microphone?.stop()
      captureMicrophone.current = null
      mediaRecorderRef.current = null
      recordingChunksRef.current = []
      if (captureMounted.current && ticket === captureTicket.current) {
        setIsRecording(false)
        setLevels(null)
        setError(normalizeVoiceError(failure))
      }
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new DOMException('Unavailable', 'NotSupportedError')
      microphone = await openMicrophone({ reduceNoise: currentSpeechPreferences().reduceNoise })
      if (!captureMounted.current || ticket !== captureTicket.current) {
        microphone.stop()
        return
      }
      captureMicrophone.current = microphone
      const { levels: recordingLevels } = microphone
      setLevels(() => recordingLevels)
      recordingStartRef.current = Date.now()
      setRecordingDuration(0)
      const startTimer = () => {
        setIsRecording(true)
        recordingTimerRef.current = window.setInterval(() => setRecordingDuration(Math.floor((Date.now() - recordingStartRef.current) / 1000)), 200)
      }
      if (selection?.source === 'local') {
        const live = await startLiveTranscription(selection.modelId, microphone.stream).catch((error: unknown) => {
          console.warn('[dictation] Live transcription is unavailable; transcribing after the stop.', error)
          return null
        })
        if (!captureMounted.current || ticket !== captureTicket.current) {
          live?.cancel()
          microphone.stop()
          return
        }
        if (live) {
          liveRef.current = live
          startTimer()
          return
        }
      }
      const recorder = new MediaRecorder(microphone.stream)
      recordingChunksRef.current = []
      mediaRecorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) recordingChunksRef.current.push(event.data)
      }
      recorder.onerror = (event) => fail(event)
      recorder.onstop = () => {
        stopRecordingTimer()
        microphone?.stop()
        captureMicrophone.current = null
        mediaRecorderRef.current = null
        if (!captureMounted.current || ticket !== captureTicket.current) return
        setIsRecording(false)
        setLevels(null)
        const blob = new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        void transcribe(() => transcribeBlob(blob), ticket)
      }
      recorder.start()
      startTimer()
    } catch (failure) {
      fail(failure)
    } finally {
      if (ticket === captureTicket.current) {
        capturePending.current = false
        if (captureMounted.current) setRecordingPending(false)
      }
    }
  }

  /** Starts recording; with no dictation model chosen yet, asks for one first and then records. */
  const start = () => {
    if (loading || isRecording || transcribing || disabled || capturePending.current) return
    const dictation = useDictationStore.getState()
    dictation.syncProfile(useAppStore.getState().profileId)
    if (!useDictationStore.getState().selection) {
      setError(undefined)
      dictation.openPicker(() => startRef.current())
      return
    }
    void begin()
  }
  startRef.current = start

  const stop = () => {
    const live = liveRef.current
    if (live) {
      liveRef.current = null
      stopRequestedRef.current = performance.now()
      const ticket = captureTicket.current
      const microphone = captureMicrophone.current
      const { captured, text } = live.finish()
      // The microphone stays open until the audio up to the stop has been captured.
      void captured.finally(() => {
        microphone?.stop()
        if (captureMicrophone.current === microphone) captureMicrophone.current = null
      })
      stopRecordingTimer()
      setIsRecording(false)
      setLevels(null)
      void transcribe(() => text, ticket)
      return
    }
    if (mediaRecorderRef.current?.state !== 'recording') return
    stopRequestedRef.current = performance.now()
    mediaRecorderRef.current.stop()
  }

  return {
    isRecording,
    recordingPending,
    transcribing,
    recordingDuration,
    /** Loudness of the recording while it runs, for the sound wave. */
    levels,
    error,
    dismissError: () => setError(undefined),
    notice,
    start,
    stop
  }
}
