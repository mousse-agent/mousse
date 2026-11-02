// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  microphone: { stream: { id: 'mic' }, levels: {}, stop: vi.fn() },
  startLiveTranscription: vi.fn(),
  transcribeRecording: vi.fn(),
  warmLocalEngine: vi.fn()
}))
vi.mock('../src/renderer/dictation/microphone', () => ({ openMicrophone: async () => mocks.microphone }))
vi.mock('../src/renderer/dictation/liveTranscription', () => ({ startLiveTranscription: mocks.startLiveTranscription }))
vi.mock('../src/renderer/dictation/transcribe', () => ({ transcribeRecording: mocks.transcribeRecording }))
vi.mock('../src/renderer/dictation/localEngine', () => ({ warmLocalEngine: mocks.warmLocalEngine, disposeLocalEngine: vi.fn() }))
vi.mock('../src/renderer/speech/speechPreferences', () => ({ currentSpeechPreferences: () => ({ reduceNoise: true }) }))
vi.mock('../src/renderer/stores/appStore', () => ({ useAppStore: { getState: () => ({ profileId: 'profile' }) } }))

const { useDictation } = await import('../src/renderer/dictation/useDictation')
const { useDictationStore } = await import('../src/renderer/dictation/dictationStore')

/** Stands in for the browser recorder used by provider models. */
class FakeRecorder {
  static all: FakeRecorder[] = []
  state = 'inactive'
  mimeType = 'audio/webm'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(readonly stream: unknown) {
    FakeRecorder.all.push(this)
  }
  start(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1])]) })
    this.onstop?.()
  }
}

type Dictation = ReturnType<typeof useDictation>
let dictation: Dictation
const transcripts: string[] = []
function Probe(): null {
  dictation = useDictation({ disabled: false, loading: false, onTranscript: (text) => transcripts.push(text) })
  return null
}

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  FakeRecorder.all = []
  transcripts.length = 0
  mocks.microphone.stop.mockReset()
  mocks.startLiveTranscription.mockReset()
  mocks.transcribeRecording.mockReset()
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: vi.fn() }, configurable: true })
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  host = document.createElement('div')
  root = createRoot(host)
  await act(async () => root.render(createElement(Probe)))
})

afterEach(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const select = (selection: Parameters<ReturnType<typeof useDictationStore.getState>['setSelection']>[0]) =>
  useDictationStore.setState({ selection, selectionProfileId: 'profile' })

describe('the composer microphone', () => {
  it('transcribes a local model recording while it runs, without the recorder', async () => {
    select({ source: 'local', modelId: 'parakeet-tdt-110m', label: 'Parakeet' })
    let captured!: () => void
    const finish = vi.fn(() => ({ captured: new Promise<void>((resolve) => (captured = resolve)), text: Promise.resolve(' Hello there. ') }))
    mocks.startLiveTranscription.mockResolvedValue({ finish, cancel: vi.fn() })

    await act(async () => dictation.start())
    expect(mocks.warmLocalEngine).toHaveBeenCalledWith('parakeet-tdt-110m')
    expect(mocks.startLiveTranscription).toHaveBeenCalledWith('parakeet-tdt-110m', mocks.microphone.stream)
    expect(dictation.isRecording).toBe(true)
    expect(FakeRecorder.all).toHaveLength(0)

    await act(async () => dictation.stop())
    expect(finish).toHaveBeenCalledTimes(1)
    expect(transcripts).toEqual(['Hello there.'])
    // The microphone stays open until the audio up to the stop is in.
    expect(mocks.microphone.stop).not.toHaveBeenCalled()
    await act(async () => captured())
    expect(mocks.microphone.stop).toHaveBeenCalledTimes(1)
  })

  it('records and transcribes after the stop when live transcription cannot start', async () => {
    select({ source: 'local', modelId: 'parakeet-tdt-110m', label: 'Parakeet' })
    mocks.startLiveTranscription.mockRejectedValue(new Error('AudioWorklet is unavailable'))
    mocks.transcribeRecording.mockResolvedValue('From the file.')

    await act(async () => dictation.start())
    expect(FakeRecorder.all).toHaveLength(1)
    await act(async () => dictation.stop())
    await vi.waitFor(() => expect(transcripts).toEqual(['From the file.']))
  })

  it('records provider models with the recorder', async () => {
    select({ source: 'provider', providerId: 'openai', modelId: 'whisper-1', label: 'Whisper' })
    mocks.transcribeRecording.mockResolvedValue('From the provider.')

    await act(async () => dictation.start())
    expect(mocks.startLiveTranscription).not.toHaveBeenCalled()
    await act(async () => dictation.stop())
    await vi.waitFor(() => expect(transcripts).toEqual(['From the provider.']))
  })

  it('drops a live recording when the composer goes away', async () => {
    select({ source: 'local', modelId: 'parakeet-tdt-110m', label: 'Parakeet' })
    const cancel = vi.fn()
    mocks.startLiveTranscription.mockResolvedValue({ finish: vi.fn(), cancel })
    await act(async () => dictation.start())
    await act(async () => root.unmount())
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(mocks.microphone.stop).toHaveBeenCalled()
    root = createRoot(host)
  })
})
