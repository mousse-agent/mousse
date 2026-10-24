import { describe, expect, it, vi } from 'vitest'
import type { DictationSelection } from '../src/shared/dictation'
import type { LocalModelStatus } from '../src/shared/localModels'
import type { ReadAloudSelection } from '../src/shared/readAloud'
import type { LlmProviderOption } from '../src/shared/settings'
import { PROVIDER_TTS_MAX_CHARS } from '../src/shared/readAloud'
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
  let profile = 'profile-a'
  const states = overrides.states ?? {}
  const statusListeners = new Set<(status: LocalModelStatus) => void>()
  const deps: PhoneSpeechDeps = {
    profileId: () => profile,
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
    listening: () => statusListeners.size > 0,
    switchProfile: (id: string) => void (profile = id),
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
      await options.onClip(new Float32Array(PHONE_SPEECH_AUDIO_PART_BYTES), 24_000)
      await options.onClip(new Float32Array([0.5, -0.5]), 24_000)
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

  describe('when the phone cancels or the window changes profile', () => {
    const deferred = <T,>() => {
      let resolve: (value: T) => void = () => undefined
      const promise = new Promise<T>((done) => (resolve = done))
      return { promise, resolve }
    }

    it('drops a provider choice that finishes after the window switched profiles', async () => {
      const pending = deferred<readonly LlmProviderOption[]>()
      const fake = fakeDeps({ providers: () => pending.promise })
      const choice = { selection: { source: 'provider', providerId: 'openai', modelId: 'tts-1' } }
      const running = runPhoneSpeechJob(job('choose', 'readAloud', choice), fake.deps, io().io)
      fake.switchProfile('profile-b')
      pending.resolve(providers)
      expect(await running).toMatchObject({ ok: false, code: 'failed' })
      expect(fake.current().readAloud).toBeNull()
    })

    it('drops a local choice that finishes after the window switched profiles', async () => {
      const pending = deferred<LocalModelStatus[]>()
      const fake = fakeDeps({ localModels: () => pending.promise })
      const running = runPhoneSpeechJob(job('choose', 'dictation', { selection: { source: 'local', modelId: 'moonshine-base' } }), fake.deps, io().io)
      fake.switchProfile('profile-b')
      pending.resolve([{ modelId: 'moonshine-base', state: { status: 'downloaded' } }])
      expect(await running).toMatchObject({ ok: false, code: 'failed' })
      expect(fake.current().dictation).toBeNull()
    })

    it('drops a choice whose job was cancelled while it waited', async () => {
      const pending = deferred<readonly LlmProviderOption[]>()
      const fake = fakeDeps({ providers: () => pending.promise })
      const abort = new AbortController()
      const choice = { selection: { source: 'provider', providerId: 'openai', modelId: 'tts-1' } }
      const running = runPhoneSpeechJob(job('choose', 'readAloud', choice), fake.deps, io(abort.signal).io)
      abort.abort()
      pending.resolve(providers)
      await running
      expect(fake.current().readAloud).toBeNull()
    })

    it('starts nothing for a job that was cancelled before it began', async () => {
      const abort = new AbortController()
      abort.abort()
      const download = vi.fn(async () => ({ modelId: 'kokoro-82m', state: { status: 'downloaded' as const } }))
      const synthesizeProvider = vi.fn(async () => ({ audio: new Uint8Array([1]), mimeType: 'audio/mpeg' }))
      const fake = fakeDeps({ download, synthesizeProvider })
      fake.deps.setReadAloudSelection({ source: 'provider', providerId: 'openai', modelId: 'tts-1', label: 'OpenAI · TTS 1' })
      await runPhoneSpeechJob(job('download', 'readAloud', { modelId: 'kokoro-82m' }), fake.deps, io(abort.signal).io)
      await runPhoneSpeechJob(job('speak', 'readAloud', { text: 'Hello.' }), fake.deps, io(abort.signal).io)
      expect(download).not.toHaveBeenCalled()
      expect(synthesizeProvider).not.toHaveBeenCalled()
    })

    it('does not start a download the phone cancelled while the model status was looked up', async () => {
      const pending = deferred<LocalModelStatus[]>()
      const download = vi.fn(async () => ({ modelId: 'kokoro-82m', state: { status: 'downloaded' as const } }))
      const fake = fakeDeps({ download, localModels: () => pending.promise })
      const abort = new AbortController()
      const running = runPhoneSpeechJob(job('download', 'readAloud', { modelId: 'kokoro-82m' }), fake.deps, io(abort.signal).io)
      abort.abort()
      pending.resolve([])
      expect(await running).toMatchObject({ ok: false, code: 'failed' })
      expect(download).not.toHaveBeenCalled()
    })

    it('does not start reading when the phone cancelled while the voice was checked', async () => {
      const pending = deferred<LocalModelStatus[]>()
      const synthesizeLocal = vi.fn(async () => undefined)
      const fake = fakeDeps({ synthesizeLocal, localModels: () => pending.promise })
      fake.deps.setReadAloudSelection({ source: 'local', modelId: 'kokoro-82m', label: 'Kokoro 82M' })
      const abort = new AbortController()
      const running = runPhoneSpeechJob(job('speak', 'readAloud', { text: 'Hello.' }), fake.deps, io(abort.signal).io)
      abort.abort()
      pending.resolve([{ modelId: 'kokoro-82m', state: { status: 'downloaded' } }])
      await running
      expect(synthesizeLocal).not.toHaveBeenCalled()
    })

    it('hands the cancellation to dictation and does not start it when already cancelled', async () => {
      const pending = deferred<LocalModelStatus[]>()
      const transcribe = vi.fn(async () => 'hello')
      const fake = fakeDeps({ transcribe, localModels: () => pending.promise })
      fake.deps.setDictationSelection({ source: 'local', modelId: 'moonshine-base', label: 'Moonshine Base' })
      const abort = new AbortController()
      const request = job('transcribe', 'dictation', { mimeType: 'audio/webm' }, bytesToBase64(new Uint8Array([1])))
      const running = runPhoneSpeechJob(request, fake.deps, io(abort.signal).io)
      abort.abort()
      pending.resolve([{ modelId: 'moonshine-base', state: { status: 'downloaded' } }])
      await running
      expect(transcribe).not.toHaveBeenCalled()

      const live = new AbortController()
      const ready = fakeDeps({ transcribe, states: { 'moonshine-base': { status: 'downloaded' } } })
      ready.deps.setDictationSelection({ source: 'local', modelId: 'moonshine-base', label: 'Moonshine Base' })
      await runPhoneSpeechJob(request, ready.deps, io(live.signal).io)
      expect(transcribe).toHaveBeenCalledWith(expect.any(Blob), expect.anything(), expect.any(Function), live.signal)
    })
  })

  describe('pacing', () => {
    it('sends no clip until the phone link took the one before, and keeps synthesis behind it', async () => {
      const releases: Array<(active: boolean) => void> = []
      const sent: PhoneSpeechAudioPart[] = []
      const channel = {
        signal: new AbortController().signal,
        progress: (data: unknown) => new Promise<boolean>((resolve) => (sent.push(data as PhoneSpeechAudioPart), releases.push(resolve)))
      }
      let handedOver = 0
      const synthesizeLocal = vi.fn<PhoneSpeechDeps['synthesizeLocal']>(async (_text, options) => {
        for (let clip = 0; clip < 3; clip += 1) {
          await options.onClip(new Float32Array(4), 24_000)
          handedOver += 1
        }
      })
      const fake = fakeDeps({ synthesizeLocal, states: { 'kokoro-82m': { status: 'downloaded' } } })
      fake.deps.setReadAloudSelection({ source: 'local', modelId: 'kokoro-82m', label: 'Kokoro 82M' })
      const running = runPhoneSpeechJob(job('speak', 'readAloud', { text: 'Hello.' }), fake.deps, channel)
      for (let clip = 0; clip < 3; clip += 1) {
        await vi.waitFor(() => expect(sent).toHaveLength(clip + 1))
        // The engine is still waiting on this clip, so it has not handed over the next.
        expect(handedOver).toBe(clip)
        releases[clip](true)
      }
      expect(await running).toEqual({ ok: true, clips: 3 })
      expect(sent.map((part) => part.clip)).toEqual([0, 1, 2])
    })

    it('requests the next provider chunk while one is sent, but no further', async () => {
      const releases: Array<(active: boolean) => void> = []
      const abort = new AbortController()
      const channel = { signal: abort.signal, progress: () => new Promise<boolean>((resolve) => releases.push(resolve)) }
      const synthesizeProvider = vi.fn(async () => ({ audio: new Uint8Array([1]), mimeType: 'audio/mpeg' }))
      const fake = fakeDeps({ synthesizeProvider })
      fake.deps.setReadAloudSelection({ source: 'provider', providerId: 'openai', modelId: 'tts-1', label: 'OpenAI · TTS 1' })
      const sentence = 'This sentence fills the chunk. '
      const text = sentence.repeat(Math.ceil((PROVIDER_TTS_MAX_CHARS * 4) / sentence.length))
      const running = runPhoneSpeechJob(job('speak', 'readAloud', { text }), fake.deps, channel)
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      await new Promise((resolve) => setTimeout(resolve, 0))
      // The first chunk is being sent and the second is on its way, not the rest.
      expect(synthesizeProvider).toHaveBeenCalledTimes(2)
      releases[0](true)
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(synthesizeProvider).toHaveBeenCalledTimes(3)
      abort.abort()
      releases[1](false)
      await running
      expect(synthesizeProvider).toHaveBeenCalledTimes(3)
    })

    it('reports download states and partial text one at a time, newest last', async () => {
      const releases: Array<(active: boolean) => void> = []
      const sent: unknown[] = []
      const channel = {
        signal: new AbortController().signal,
        progress: (data: unknown) => new Promise<boolean>((resolve) => (sent.push(data), releases.push(resolve)))
      }
      let finish: (status: LocalModelStatus) => void = () => undefined
      const fake = fakeDeps({ download: () => new Promise((resolve) => (finish = resolve)) })
      // Download states are throttled by the clock; step it so every one passes.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const running = runPhoneSpeechJob(job('download', 'readAloud', { modelId: 'kokoro-82m' }), fake.deps, channel)
        await vi.waitFor(() => expect(fake.listening()).toBe(true))
        for (const receivedBytes of [1, 2, 3]) {
          fake.emitStatus({ modelId: 'kokoro-82m', state: { status: 'downloading', receivedBytes, totalBytes: 10 } })
          vi.setSystemTime(Date.now() + 1_000)
        }
        expect(sent).toHaveLength(1)
        releases[0](true)
        await vi.waitFor(() => expect(sent).toHaveLength(2))
        expect(sent[1]).toMatchObject({ state: { receivedBytes: 3 } })
        releases[1](true)
        finish({ modelId: 'kokoro-82m', state: { status: 'downloaded' } })
        await running
      } finally {
        vi.useRealTimers()
      }
    })
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
  it('claims announced jobs, runs them and sends the answer', async () => {
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
  describe('when the window stops or the phone cancels', () => {
    function hostRequest(overrides: { take?: () => Promise<unknown>; progress?: () => Promise<unknown> } = {}) {
      const calls: Array<[string, any]> = []
      const waits: Array<(value: unknown) => void> = []
      const request: SpeechHostRequest = async <T,>(method: string, params?: Record<string, unknown>) => {
        calls.push([method, params])
        if (method === 'speech.host.wait') return new Promise<T>((resolve) => waits.push(resolve as (value: unknown) => void))
        if (method === 'speech.host.take') return (overrides.take ? await overrides.take() : { job: job('download', 'readAloud', { modelId: 'kokoro-82m' }) }) as T
        if (method === 'speech.host.progress') return (overrides.progress ? await overrides.progress() : { active: true }) as T
        return { ok: true } as T
      }
      const finishes = () => calls.filter(([method]) => method === 'speech.host.finish').map(([, params]) => params)
      return { request, calls, waits, finishes }
    }
    const notice = { id: 'sj_test_job_1', op: 'download' as const, kind: 'readAloud' as const }

    it('tells the daemon the jobs it took will not be answered when it stops', async () => {
      const host = hostRequest()
      const fake = fakeDeps({ download: () => new Promise<LocalModelStatus>(() => undefined) })
      const stop = startPhoneSpeechHost(host.request, fake.deps)
      await vi.waitFor(() => expect(host.waits).toHaveLength(1))
      host.waits[0]({ jobs: [notice], cancelled: [] })
      await vi.waitFor(() => expect(host.calls.some(([method]) => method === 'speech.host.take')).toBe(true))
      await new Promise((resolve) => setTimeout(resolve, 0))
      stop()
      await vi.waitFor(() => expect(host.finishes()).toHaveLength(1))
      expect(host.finishes()[0]).toMatchObject({ id: 'sj_test_job_1', result: { ok: false, code: 'failed' } })
    })

    it('does the same for a job whose claim was still on its way when it stopped', async () => {
      let answerTake: (value: unknown) => void = () => undefined
      const host = hostRequest({ take: () => new Promise((resolve) => (answerTake = resolve)) })
      const download = vi.fn(async () => ({ modelId: 'kokoro-82m', state: { status: 'downloaded' as const } }))
      const stop = startPhoneSpeechHost(host.request, fakeDeps({ download }).deps)
      await vi.waitFor(() => expect(host.waits).toHaveLength(1))
      host.waits[0]({ jobs: [notice], cancelled: [] })
      await vi.waitFor(() => expect(host.calls.some(([method]) => method === 'speech.host.take')).toBe(true))
      stop()
      answerTake({ job: job('download', 'readAloud', { modelId: 'kokoro-82m' }) })
      await vi.waitFor(() => expect(host.finishes()).toHaveLength(1))
      expect(host.finishes()[0]).toMatchObject({ id: 'sj_test_job_1', result: { ok: false, code: 'failed' } })
      expect(download).not.toHaveBeenCalled()
    })

    it('does not run a job the phone cancelled while the claim was on its way', async () => {
      let answerTake: (value: unknown) => void = () => undefined
      const host = hostRequest({ take: () => new Promise((resolve) => (answerTake = resolve)) })
      const synthesizeProvider = vi.fn(async () => ({ audio: new Uint8Array([1]), mimeType: 'audio/mpeg' }))
      const fake = fakeDeps({ synthesizeProvider })
      fake.deps.setReadAloudSelection({ source: 'provider', providerId: 'openai', modelId: 'tts-1', label: 'OpenAI · TTS 1' })
      const stop = startPhoneSpeechHost(host.request, fake.deps)
      await vi.waitFor(() => expect(host.waits).toHaveLength(1))
      host.waits[0]({ jobs: [{ ...notice, op: 'speak' }], cancelled: [] })
      await vi.waitFor(() => expect(host.waits).toHaveLength(1))
      await vi.waitFor(() => expect(host.calls.some(([method]) => method === 'speech.host.take')).toBe(true))
      // The next wait delivers the cancellation while the claim is still pending.
      await vi.waitFor(() => expect(host.waits).toHaveLength(2))
      host.waits[1]({ jobs: [], cancelled: ['sj_test_job_1'] })
      await new Promise((resolve) => setTimeout(resolve, 0))
      answerTake({ job: job('speak', 'readAloud', { text: 'Hello.' }) })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(synthesizeProvider).not.toHaveBeenCalled()
      stop()
    })

    it('aborts the running job when the phone cancels it', async () => {
      const host = hostRequest()
      const cancelDownload = vi.fn(async () => undefined)
      const fake = fakeDeps({ download: () => new Promise<LocalModelStatus>(() => undefined), cancelDownload })
      const stop = startPhoneSpeechHost(host.request, fake.deps)
      await vi.waitFor(() => expect(host.waits).toHaveLength(1))
      host.waits[0]({ jobs: [notice], cancelled: [] })
      await vi.waitFor(() => expect(host.waits).toHaveLength(2))
      await new Promise((resolve) => setTimeout(resolve, 0))
      host.waits[1]({ jobs: [], cancelled: ['sj_test_job_1'] })
      await vi.waitFor(() => expect(cancelDownload).toHaveBeenCalledWith('readAloud', 'kokoro-82m'))
      stop()
    })
  })
})
