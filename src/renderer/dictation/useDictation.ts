import { useEffect, useRef, useState } from 'react'
import type { AppErrorShape } from '../../shared/errors'
import { useAppStore } from '../stores/appStore'
import { normalizeTranscriptionError, normalizeVoiceError } from '../utils/voiceErrors'
import { currentSpeechPreferences } from '../speech/speechPreferences'
import { useDictationStore } from './dictationStore'
import { openMicrophone, type Microphone } from './microphone'
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
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingTimerRef = useRef<number | null>(null)
  const recordingStartRef = useRef<number>(0)
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

  const transcribe = async (blob: Blob, ticket: number) => {
    const live = () => captureMounted.current && ticket === captureTicket.current
    setTranscribing(true)
    try {
      const selection = useDictationStore.getState().selection
      if (!selection) throw new Error('No dictation model is selected. Choose one under Settings, Models.')
      const text = blob.size > 0 ? (await transcribeRecording(blob, selection)).trim() : ''
      if (!live()) return
      if (text) onTranscriptRef.current(text)
      else showNotice(NO_SPEECH_MESSAGE)
    } catch (failure) {
      if (live()) setError(normalizeTranscriptionError(failure))
    } finally {
      if (live()) setTranscribing(false)
    }
  }

  const begin = async () => {
    if (loading || isRecording || transcribing || disabled || capturePending.current || !captureMounted.current) return
    const ticket = ++captureTicket.current
    capturePending.current = true
    setRecordingPending(true)
    setError(undefined)
    setNotice(null)
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
      microphone?.stop()
      captureMicrophone.current = null
      mediaRecorderRef.current = null
      recordingChunksRef.current = []
      if (captureMounted.current && ticket === captureTicket.current) {
        setIsRecording(false)
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
        void transcribe(new Blob(recordingChunksRef.current, { type: recorder.mimeType || 'audio/webm' }), ticket)
      }
      recordingStartRef.current = Date.now()
      setRecordingDuration(0)
      recorder.start()
      setIsRecording(true)
      recordingTimerRef.current = window.setInterval(() => setRecordingDuration(Math.floor((Date.now() - recordingStartRef.current) / 1000)), 200)
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
    if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
  }

  return {
    isRecording,
    recordingPending,
    transcribing,
    recordingDuration,
    error,
    dismissError: () => setError(undefined),
    notice,
    start,
    stop
  }
}
