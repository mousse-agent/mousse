import { describe, expect, it, vi } from 'vitest'
import type { DictationSelection } from '../src/shared/dictation'
import type { LocalModelStatus } from '../src/shared/localModels'
import type { ReadAloudSelection } from '../src/shared/readAloud'
import type { LlmProviderOption } from '../src/shared/settings'
import { PHONE_SPEECH_AUDIO_PART_BYTES, type PhoneSpeechAudioPart, type SpeechJobInput } from '../src/shared/speechRelay'
import { base64ToBytes, bytesToBase64, encodeWav } from '../src/renderer/speechRelay/audioEncoding'
import { runPhoneSpeechJob, type PhoneSpeechDeps } from '../src/renderer/speechRelay/phoneSpeechJobs'
import { startPhoneSpeechHost, type SpeechHostRequest } from '../src/renderer/speechRelay/startPhoneSpeechHost'
import { DEFAULT_SPEECH_PREFERENCES, type SpeechPreferences } from '../src/renderer/speech/speechPreferences'

const providers = [
  {
    id: 'openai',
    label: 'OpenAI',
    models: [
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'whisper-1', label: 'Whisper' },
      { id: 'tts-1', label: 'TTS 1' }
    ]
  }
] as unknown as LlmProviderOption[]

function fakeDeps(overrides: Partial<PhoneSpeechDeps> & { states?: Record<string, LocalModelStatus['state']> } = {}) {
  let dictation: DictationSelection | null = null
  let readAloud: ReadAloudSelection | null = null
  let preferences: SpeechPreferences = { ...DEFAULT_SPEECH_PREFERENCES }
  const states = overrides.states ?? {}
  const statusListeners = new Set<(status: LocalModelStatus) => void>()
  const deps: PhoneSpeechDeps = {
    dictationSelection: () => dictation,
    setDictationSelection: (selection) => void (dictation = selection),
    readAloudSelection: () => readAloud,
    setReadAloudSelection: (selection) => void (readAloud = selection),
    preferences: () => preferences,
    voiceFor: (prefs, selection) => prefs.voices[selection.modelId] ?? (selection.source === 'local' ? 'af_heart' : 'alloy'),
    providers: async () => providers,
    localModels: async () => Object.entries(states).map(([modelId, state]) => ({ modelId, state })),
    download: async (_kind, modelId) => ({ modelId, state: { status: 'downloaded' } }),
    cancelDownload: async () => undefined,
    onLocalStatus: (_kind, listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    transcribe: async () => 'hello',
    synthesizeLocal: async () => undefined,
    synthesizeProvider: async () => ({ audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' }),
    ...overrides
  }
  return {
    deps,
    emitStatus: (status: LocalModelStatus) => statusListeners.forEach((listener) => listener(status)),
    setPreferences: (value: Partial<SpeechPreferences>) => void (preferences = { ...preferences, ...value }),
    current: () => ({ dictation, readAloud })
  }
}

function job(op: SpeechJobInput['op'], kind: SpeechJobInput['kind'], params: Record<string, unknown> = {}, audioBase64?: string): SpeechJobInput {
  return { id: 'sj_test_job_1', op, kind, params, ...(audioBase64 ? { audioBase64 } : {}) }
}

function io(signal = new AbortController().signal, active = () => true) {
  const sent: unknown[] = []
  return { sent, io: { signal, progress: async (data: unknown) => (sent.push(data), active()) } }
}

describe('phone speech jobs', () => {
  it('lists the same choices as the desktop chooser, with download states', async () => {
    const { deps } = fakeDeps({ states: { 'moonshine-base': { status: 'downloaded' } } })
    const answer = (await runPhoneSpeechJob(job('options', 'dictation'), deps, io().io)) as Record<string, any>
    expect(answer.ok).toBe(true)
    expect(answer.selection).toBeNull()
    expect(answer.providers).toEqual([{ providerId: 'openai', providerLabel: 'OpenAI', modelId: 'whisper-1', label: 'Whisper' }])
    expect(answer.local.map((model: { id: string }) => model.id)).toEqual(['moonshine-base', 'parakeet-tdt-110m'])
    expect(answer.local[0]).toMatchObject({ state: { status: 'downloaded' }, bytes: expect.any(Number), homepage: expect.stringMatching(/^https:/) })
    expect(answer.local[1].state).toEqual({ status: 'not-downloaded' })
  })

  it('saves a provider choice with the desktop label and refuses models the computer does not offer', async () => {
    const { deps, current } = fakeDeps()
    expect(await runPhoneSpeechJob(job('choose', 'readAloud', { selection: { source: 'provider', providerId: 'openai', modelId: 'tts-1' } }), deps, io().io)).toMatchObject({
      ok: true,
      selection: { source: 'provider', modelId: 'tts-1', label: 'OpenAI · TTS 1' }
    })
    expect(current().readAloud).toEqual({ source: 'provider', providerId: 'openai', modelId: 'tts-1', label: 'OpenAI · TTS 1' })
    expect(await runPhoneSpeechJob(job('choose', 'dictation', { selection: { source: 'provider', providerId: 'openai', modelId: 'gpt-5' } }), deps, io().io)).toMatchObject({
      ok: false,
      code: 'invalid'
    })
    expect(current().dictation).toBeNull()
  })

  it('only saves a local model once it is downloaded', async () => {
    const missing = fakeDeps()
    expect(await runPhoneSpeechJob(job('choose', 'readAloud', { selection: { source: 'local', modelId: 'kokoro-82m' } }), missing.deps, io().io)).toMatchObject({
      ok: false,
      code: 'unavailable'
    })
    const ready = fakeDeps({ states: { 'kokoro-82m': { status: 'downloaded' } } })
    await runPhoneSpeechJob(job('choose', 'readAloud', { selection: { source: 'local', modelId: 'kokoro-82m' } }), ready.deps, io().io)
    expect(ready.current().readAloud).toEqual({ source: 'local', modelId: 'kokoro-82m', label: 'Kokoro 82M' })
  })

  it('downloads on the computer, reports progress and cancels with the phone', async () => {
    let finish: (status: LocalModelStatus) => void = () => undefined
    const cancelDownload = vi.fn(async () => undefined)
    const fake = fakeDeps({ download: (_kind, modelId) => new Promise((resolve) => (finish = resolve)), cancelDownload })
    const abort = new AbortController()
    const channel = io(abort.signal)
    const running = runPhoneSpeechJob(job('download', 'readAloud', { modelId: 'kokoro-82m' }), fake.deps, channel.io)
    await new Promise((resolve) => setTimeout(resolve, 0))
    fake.emitStatus({ modelId: 'kokoro-82m', state: { status: 'downloading', receivedBytes: 10, totalBytes: 100 } })
    fake.emitStatus({ modelId: 'moonshine-base', state: { status: 'downloading', receivedBytes: 1, totalBytes: 2 } })
    abort.abort()
    expect(cancelDownload).toHaveBeenCalledWith('readAloud', 'kokoro-82m')
    finish({ modelId: 'kokoro-82m', state: { status: 'not-downloaded' } })
    expect(await running).toMatchObject({ ok: false, code: 'failed' })
    expect(channel.sent).toEqual([{ type: 'status', state: { status: 'downloading', receivedBytes: 10, totalBytes: 100 } }])
  })

  it('asks for a model before transcribing, then uses the chosen one with the recording type', async () => {
    const transcribe = vi.fn(async (recording: Blob, _selection: DictationSelection, onPartial: (text: string) => void) => {
      onPartial('hello')
      expect(recording.type).toBe('audio/webm;codecs=opus')
      expect([...new Uint8Array(await recording.arrayBuffer())]).toEqual([1, 2, 3])
      return '  hello world '
    })
    const fake = fakeDeps({ transcribe, states: { 'moonshine-base': { status: 'downloaded' } } })
    const audio = bytesToBase64(new Uint8Array([1, 2, 3]))
    const request = job('transcribe', 'dictation', { mimeType: 'audio/webm;codecs=opus' }, audio)
    expect(await runPhoneSpeechJob(request, fake.deps, io().io)).toMatchObject({ ok: false, code: 'no_model' })
    fake.deps.setDictationSelection({ source: 'local', modelId: 'parakeet-tdt-110m', label: 'Parakeet TDT 110M' })
    expect(await runPhoneSpeechJob(request, fake.deps, io().io)).toMatchObject({ ok: false, code: 'no_model' })
    fake.deps.setDictationSelection({ source: 'local', modelId: 'moonshine-base', label: 'Moonshine Base' })
    const channel = io()
    expect(await runPhoneSpeechJob(request, fake.deps, channel.io)).toEqual({ ok: true, text: 'hello world' })
    expect(channel.sent).toEqual([{ type: 'partial', text: 'hello' }])
  })

  it('reads with the local model at the computer voice and speed, as WAV clips in pieces', async () => {
    const synthesizeLocal = vi.fn<PhoneSpeechDeps['synthesizeLocal']>(async (_text, options) => {
      options.onClip(new Float32Array(PHONE_SPEECH_AUDIO_PART_BYTES), 24_000)
      options.onClip(new Float32Array([0.5, -0.5]), 24_000)
    })
    const fake = fakeDeps({ synthesizeLocal, states: { 'kokoro-82m': { status: 'downloaded' } } })
    fake.deps.setReadAloudSelection({ source: 'local', modelId: 'kokoro-82m', label: 'Kokoro 82M' })
    fake.setPreferences({ speed: 1.25, voices: { 'kokoro-82m': 'bm_george' } })
    const channel = io()
    expect(await runPhoneSpeechJob(job('speak', 'readAloud', { text: '# Title\n\nSome **bold** words.' }), fake.deps, channel.io)).toEqual({ ok: true, clips: 2 })
    expect(synthesizeLocal.mock.calls[0][0]).toBe('Title.\n\nSome bold words.')
    expect(synthesizeLocal.mock.calls[0][1]).toMatchObject({ voice: 'bm_george', speed: 1.25 })
    const parts = channel.sent as PhoneSpeechAudioPart[]
    // The first clip has 2 bytes per sample plus the header, so it needs three pieces.
    expect(parts.map((part) => [part.clip, part.part, part.last])).toEqual([[0, 0, false], [0, 1, false], [0, 2, true], [1, 0, true]])
    expect(parts.every((part) => part.mimeType === 'audio/wav' && part.rate === 1)).toBe(true)
    const wav = base64ToBytes(parts[3].data)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(wav.length).toBe(44 + 4)
  })

  it('reads with a provider model, passing its audio through at the computer speed', async () => {
    const synthesizeProvider = vi.fn(async () => ({ audio: new Uint8Array([7, 7]), mimeType: 'audio/mpeg' }))
    const fake = fakeDeps({ synthesizeProvider })
    fake.deps.setReadAloudSelection({ source: 'provider', providerId: 'openai', modelId: 'tts-1', label: 'OpenAI · TTS 1' })
    fake.setPreferences({ speed: 1.5 })
    const channel = io()
    expect(await runPhoneSpeechJob(job('speak', 'readAloud', { text: 'Hello.' }), fake.deps, channel.io)).toEqual({ ok: true, clips: 1 })
    expect(synthesizeProvider).toHaveBeenCalledWith({ providerId: 'openai', modelId: 'tts-1', text: 'Hello.', voice: 'alloy' })
    expect(channel.sent).toEqual([{ type: 'audio', clip: 0, part: 0, last: true, mimeType: 'audio/mpeg', rate: 1.5, data: bytesToBase64(new Uint8Array([7, 7])) }])
  })

  it('stops reading once the phone stops listening', async () => {
    let signal: AbortSignal | undefined
    const synthesizeLocal = vi.fn<PhoneSpeechDeps['synthesizeLocal']>(async (_text, options) => {
      signal = options.signal
      options.onClip(new Float32Array(4), 24_000)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const fake = fakeDeps({ synthesizeLocal, states: { 'kokoro-82m': { status: 'downloaded' } } })
    fake.deps.setReadAloudSelection({ source: 'local', modelId: 'kokoro-82m', label: 'Kokoro 82M' })
    await runPhoneSpeechJob(job('speak', 'readAloud', { text: 'Hello.' }), fake.deps, io(undefined, () => false).io)
    expect(signal?.aborted).toBe(true)
  })

  it('writes 16-bit mono WAV and round-trips base64', () => {
    const wav = encodeWav(new Float32Array([1, -1, 0]), 16_000)
    const view = new DataView(wav.buffer)
    expect(view.getUint32(24, true)).toBe(16_000)
    expect(view.getInt16(44, true)).toBe(0x7fff)
    expect(view.getInt16(46, true)).toBe(-0x8000)
    expect([...base64ToBytes(bytesToBase64(wav))]).toEqual([...wav])
  })
})

describe('phone speech host loop', () => {
  it('claims announced jobs, runs them and sends the answer; stops a cancelled one', async () => {
    const calls: Array<[string, unknown]> = []
    const waits: Array<(value: unknown) => void> = []
    const request: SpeechHostRequest = async <T,>(method: string, params?: Record<string, unknown>) => {
      calls.push([method, params])
      if (method === 'speech.host.wait') return new Promise<T>((resolve) => waits.push(resolve as (value: unknown) => void))
      if (method === 'speech.host.take') return { job: job('options', 'dictation') } as T
      return { active: true } as T
    }
    const { deps } = fakeDeps()
    const stop = startPhoneSpeechHost(request, deps)
    await vi.waitFor(() => expect(waits).toHaveLength(1))
    waits[0]({ jobs: [{ id: 'sj_test_job_1', op: 'options', kind: 'dictation' }], cancelled: [] })
    await vi.waitFor(() => expect(calls.some(([method]) => method === 'speech.host.finish')).toBe(true))
    const finish = calls.find(([method]) => method === 'speech.host.finish')![1] as { id: string; result: { ok: boolean } }
    expect(finish.id).toBe('sj_test_job_1')
    expect(finish.result.ok).toBe(true)
    stop()
  })
})
