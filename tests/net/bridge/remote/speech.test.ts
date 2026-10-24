import { describe, expect, it } from 'vitest'
import {
  PHONE_SPEECH_CAPABILITIES,
  phoneSpeechMethods,
  validatePhoneSpeechParams
} from '../../../../src/mms/bridge/remote/speech'
import { SpeechRelay, type SpeechRelayClock } from '../../../../src/mms/speech/SpeechRelay'
import {
  registerSpeechHostMethods,
  validateSpeechHostParams
} from '../../../../src/mms/speech/registerSpeechHostMethods'
import { DomainHandlerRegistry } from '../../../../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../../../../src/mms/protocol/handlers'
import type { RpcContext } from '../../../../src/mms/net/contracts'
import { NET_LOCAL_CAPABILITY } from '../../../../src/shared/net/local'
import { newId, type NodeId, type UserId } from '../../../../src/shared/net'
import {
  PHONE_SPEECH_MAX_JOBS,
  PHONE_SPEECH_MAX_RECORDING_BYTES,
  PHONE_SPEECH_MAX_TEXT_BYTES,
  PHONE_SPEECH_UPLOAD_CHUNK_CHARS,
  SPEECH_HOST_FRESH_MS,
  SPEECH_HOST_WAIT_MS,
  SPEECH_JOB_TAKE_TIMEOUT_MS
} from '../../../../src/shared/speechRelay'

/** A clock whose timers run only when the test advances it. */
class ManualClock implements SpeechRelayClock {
  time = 1_000_000
  private timers: Array<{ at: number; callback: () => void; live: boolean }> = []
  now(): number {
    return this.time
  }
  setTimeout(callback: () => void, ms: number) {
    const timer = { at: this.time + ms, callback, live: true }
    this.timers.push(timer)
    return { cancel: () => void (timer.live = false) }
  }
  advance(ms: number): void {
    this.time += ms
    for (const timer of this.timers.filter((entry) => entry.live && entry.at <= this.time)) {
      timer.live = false
      timer.callback()
    }
  }
}

const phone = { node: newId('node') as NodeId, user: newId('user') as UserId }
const otherPhone = { node: newId('node') as NodeId, user: phone.user }

function context(
  options: {
    caller?: typeof phone
    signal?: AbortSignal
    progress?: (data: unknown) => void | Promise<void>
  } = {}
): RpcContext {
  return {
    id: newId('rpc'),
    caller: (options.caller ?? phone) as RpcContext['caller'],
    signal: options.signal ?? new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    progress: options.progress ?? (() => undefined)
  }
}

function call(
  relay: SpeechRelay,
  method: string,
  params: unknown,
  ctx = context()
): Promise<unknown> {
  const entry = phoneSpeechMethods(relay).find((row) => row.method === method)
  if (!entry) throw new Error('unregistered ' + method)
  entry.validate(params)
  return entry.handle(params, ctx)
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A window that waits once and returns the jobs it hears of. */
async function nextJobs(relay: SpeechRelay, connection = 'window-a') {
  return relay.wait(connection)
}

describe('phone speech methods', () => {
  it('lets read nodes list choices and requires chat for everything that runs or changes a model', () => {
    expect(PHONE_SPEECH_CAPABILITIES['speech.options']).toEqual({
      capability: 'read',
      mutating: false
    })
    for (const method of [
      'speech.choose',
      'speech.download',
      'speech.upload',
      'speech.transcribe',
      'speech.speak'
    ] as const)
      expect(PHONE_SPEECH_CAPABILITIES[method]).toEqual({ capability: 'chat', mutating: true })
    expect(
      phoneSpeechMethods(new SpeechRelay(new ManualClock()))
        .map((row) => row.method)
        .sort()
    ).toEqual(Object.keys(PHONE_SPEECH_CAPABILITIES).sort())
  })

  it('accepts exact requests and rejects anything else before admission', () => {
    const ok = (method: string, params: unknown) =>
      expect(() => validatePhoneSpeechParams(method, params)).not.toThrow()
    const bad = (method: string, params: unknown) =>
      expect(() => validatePhoneSpeechParams(method, params)).toThrow()
    ok('speech.options', { kind: 'dictation' })
    ok('speech.options', { kind: 'readAloud' })
    bad('speech.options', { kind: 'music' })
    bad('speech.options', { kind: 'dictation', extra: 1 })
    ok('speech.choose', {
      kind: 'dictation',
      selection: { source: 'provider', providerId: 'openai', modelId: 'whisper-1' }
    })
    ok('speech.choose', {
      kind: 'readAloud',
      selection: { source: 'local', modelId: 'kokoro-82m' }
    })
    bad('speech.choose', {
      kind: 'readAloud',
      selection: { source: 'local', modelId: 'kokoro-82m', label: 'x' }
    })
    bad('speech.choose', { kind: 'readAloud', selection: { source: 'file', modelId: 'x' } })
    bad('speech.download', { kind: 'dictation', modelId: '../../etc' })
    ok('speech.upload', { upload: 'rec_12345678', index: 0, data: 'AAAA' })
    bad('speech.upload', { upload: 'rec_12345678', index: 0, data: 'AAA' })
    bad('speech.upload', { upload: 'rec_12345678', index: 0, data: '****' })
    bad('speech.upload', { upload: 'rec_12345678', index: -1, data: 'AAAA' })
    bad('speech.upload', { upload: 'short', index: 0, data: 'AAAA' })
    bad('speech.upload', {
      upload: 'rec_12345678',
      index: 0,
      data: 'A'.repeat(PHONE_SPEECH_UPLOAD_CHUNK_CHARS + 4)
    })
    ok('speech.transcribe', {
      upload: 'rec_12345678',
      parts: 1,
      mimeType: 'audio/webm;codecs=opus'
    })
    ok('speech.transcribe', {
      upload: 'rec_12345678',
      parts: 1,
      mimeType: 'audio/ogg; codecs=opus'
    })
    bad('speech.transcribe', { upload: 'rec_12345678', parts: 1, mimeType: 'video/webm' })
    bad('speech.transcribe', { upload: 'rec_12345678', parts: 0, mimeType: 'audio/webm' })
    ok('speech.speak', { text: 'Hello there' })
    bad('speech.speak', { text: '   ' })
    bad('speech.speak', { text: 'é'.repeat(PHONE_SPEECH_MAX_TEXT_BYTES) })
  })

  it('answers no_host when no Mousse window is open', async () => {
    const relay = new SpeechRelay(new ManualClock())
    expect(await call(relay, 'speech.options', { kind: 'dictation' })).toMatchObject({
      ok: false,
      code: 'no_host'
    })
  })

  it('hands a request to a waiting window and carries its progress and answer back', async () => {
    const relay = new SpeechRelay(new ManualClock())
    const waiting = nextJobs(relay)
    const progress: unknown[] = []
    const answer = call(
      relay,
      'speech.speak',
      { text: 'Hello' },
      context({ progress: (data) => void progress.push(data) })
    )
    const { jobs } = await waiting
    expect(jobs).toEqual([{ id: expect.stringMatching(/^sj_/), op: 'speak', kind: 'readAloud' }])
    const job = relay.take('window-a', jobs[0].id)
    expect(job).toMatchObject({ op: 'speak', kind: 'readAloud', params: { text: 'Hello' } })
    expect(relay.take('window-b', jobs[0].id)).toBeNull()
    expect(await relay.progress('window-b', jobs[0].id, { type: 'audio' })).toEqual({
      active: false
    })
    expect(await relay.progress('window-a', jobs[0].id, { type: 'audio', clip: 0 })).toEqual({
      active: true
    })
    relay.finish('window-a', jobs[0].id, { ok: true, clips: 1 })
    expect(await answer).toEqual({ ok: true, clips: 1 })
    expect(progress).toEqual([{ type: 'audio', clip: 0 }])
    expect(await relay.progress('window-a', jobs[0].id, {})).toEqual({ active: false })
  })

  it('answers progress only once the phone link took it, so the window paces to the link', async () => {
    const relay = new SpeechRelay(new ManualClock())
    const waiting = nextJobs(relay)
    let release: () => void = () => undefined
    const answer = call(
      relay,
      'speech.speak',
      { text: 'Hello' },
      context({ progress: () => new Promise<void>((resolve) => (release = resolve)) })
    )
    const { jobs } = await waiting
    relay.take('window-a', jobs[0].id)
    let answered = false
    const sent = relay.progress('window-a', jobs[0].id, { type: 'audio' }).then((value) => {
      answered = true
      return value
    })
    await flush()
    expect(answered).toBe(false)
    release()
    expect(await sent).toEqual({ active: true })
    relay.finish('window-a', jobs[0].id, { ok: true, clips: 1 })
    await answer
  })

  it('ends the request and stops the window when the phone link refuses a piece', async () => {
    const relay = new SpeechRelay(new ManualClock())
    const waiting = nextJobs(relay)
    const answer = call(
      relay,
      'speech.speak',
      { text: 'Hello' },
      context({ progress: () => Promise.reject(new Error('rate_limited')) })
    )
    const { jobs } = await waiting
    relay.take('window-a', jobs[0].id)
    expect(await relay.progress('window-a', jobs[0].id, { type: 'audio' })).toEqual({
      active: false
    })
    expect(await answer).toMatchObject({ ok: false, code: 'failed' })
  })

  it('tells each window about a job once', async () => {
    const relay = new SpeechRelay(new ManualClock())
    void nextJobs(relay)
    void call(relay, 'speech.options', { kind: 'dictation' })
    await flush()
    const again = relay.wait('window-a')
    const other = await relay.wait('window-b')
    expect(other.jobs).toHaveLength(1)
    relay.connectionClosed('window-a')
    expect(await again).toEqual({ jobs: [], cancelled: [] })
  })

  it('fails a job no window picks up in time, and counts a window as gone after it stops waiting', async () => {
    const clock = new ManualClock()
    const relay = new SpeechRelay(clock)
    void nextJobs(relay)
    const answer = call(relay, 'speech.options', { kind: 'readAloud' })
    clock.advance(SPEECH_JOB_TAKE_TIMEOUT_MS)
    expect(await answer).toMatchObject({ ok: false, code: 'no_host' })
    clock.advance(SPEECH_HOST_WAIT_MS + SPEECH_HOST_FRESH_MS)
    expect(relay.hostAttached()).toBe(false)
  })

  it('stops the window when the phone cancels', async () => {
    const relay = new SpeechRelay(new ManualClock())
    const waiting = nextJobs(relay)
    const abort = new AbortController()
    const answer = call(
      relay,
      'speech.speak',
      { text: 'Long text' },
      context({ signal: abort.signal })
    )
    const { jobs } = await waiting
    relay.take('window-a', jobs[0].id)
    const nextWait = relay.wait('window-a')
    abort.abort()
    expect(await answer).toMatchObject({ ok: false, code: 'failed' })
    expect(await nextWait).toEqual({ jobs: [], cancelled: [jobs[0].id] })
    expect(await relay.progress('window-a', jobs[0].id, {})).toEqual({ active: false })
  })

  it('fails the jobs of a window that closes', async () => {
    const relay = new SpeechRelay(new ManualClock())
    const waiting = nextJobs(relay)
    const answer = call(relay, 'speech.options', { kind: 'dictation' })
    const { jobs } = await waiting
    relay.take('window-a', jobs[0].id)
    relay.connectionClosed('window-a')
    expect(await answer).toMatchObject({ ok: false, code: 'failed' })
  })

  it('refuses more work than it can hold', async () => {
    const relay = new SpeechRelay(new ManualClock())
    void nextJobs(relay)
    for (let index = 0; index < PHONE_SPEECH_MAX_JOBS; index += 1)
      void call(relay, 'speech.options', { kind: 'dictation' })
    expect(await call(relay, 'speech.options', { kind: 'dictation' })).toMatchObject({
      ok: false,
      code: 'busy'
    })
  })
})

describe('phone recordings', () => {
  const piece = (bytes: number[]) => Buffer.from(bytes).toString('base64')

  it('assembles pieces in order, accepts a repeated piece and rejects gaps', async () => {
    const relay = new SpeechRelay(new ManualClock())
    expect(
      await call(relay, 'speech.upload', {
        upload: 'rec_12345678',
        index: 0,
        data: piece([1, 2, 3])
      })
    ).toEqual({ ok: true, bytes: 3 })
    expect(
      await call(relay, 'speech.upload', {
        upload: 'rec_12345678',
        index: 0,
        data: piece([1, 2, 3])
      })
    ).toEqual({ ok: true, bytes: 3 })
    expect(
      await call(relay, 'speech.upload', {
        upload: 'rec_12345678',
        index: 2,
        data: piece([9, 9, 9])
      })
    ).toMatchObject({ ok: false, code: 'invalid' })
    expect(
      await call(relay, 'speech.upload', {
        upload: 'rec_12345678',
        index: 1,
        data: piece([4, 5, 6])
      })
    ).toEqual({ ok: true, bytes: 6 })
    expect(relay.recording(phone.node, 'rec_12345678', 2)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]))
    // Another phone cannot read or extend it.
    expect(relay.recording(otherPhone.node, 'rec_12345678', 2)).toMatchObject({ ok: false })
  })

  it('drops a recording that grows past the limit', () => {
    const relay = new SpeechRelay(new ManualClock())
    const chunk = Buffer.alloc(36 * 1024)
    let index = 0
    let answer: unknown
    while (index * chunk.length <= PHONE_SPEECH_MAX_RECORDING_BYTES)
      answer = relay.appendUpload(phone.node, 'rec_12345678', index++, chunk)
    expect(answer).toMatchObject({ ok: false, code: 'invalid' })
    expect(relay.recording(phone.node, 'rec_12345678', index - 1)).toMatchObject({ ok: false })
  })

  it('forgets an abandoned recording', () => {
    const clock = new ManualClock()
    const relay = new SpeechRelay(clock)
    relay.appendUpload(phone.node, 'rec_12345678', 0, Buffer.from([1]))
    clock.advance(10 * 60_000)
    expect(relay.recording(phone.node, 'rec_12345678', 1)).toMatchObject({ ok: false })
  })

  it('transcribes a complete recording and keeps it when no model is chosen yet', async () => {
    const relay = new SpeechRelay(new ManualClock())
    await call(relay, 'speech.upload', { upload: 'rec_12345678', index: 0, data: piece([1, 2, 3]) })
    expect(
      await call(relay, 'speech.transcribe', {
        upload: 'rec_12345678',
        parts: 2,
        mimeType: 'audio/webm'
      })
    ).toMatchObject({ ok: false, code: 'invalid' })

    let waiting = nextJobs(relay)
    let answer = call(relay, 'speech.transcribe', {
      upload: 'rec_12345678',
      parts: 1,
      mimeType: 'audio/webm;codecs=opus'
    })
    let { jobs } = await waiting
    const job = relay.take('window-a', jobs[0].id)
    expect(job).toMatchObject({
      op: 'transcribe',
      kind: 'dictation',
      params: { mimeType: 'audio/webm;codecs=opus' },
      audioBase64: piece([1, 2, 3])
    })
    relay.finish('window-a', jobs[0].id, { ok: false, code: 'no_model', error: 'Choose a model' })
    expect(await answer).toMatchObject({ code: 'no_model' })

    waiting = nextJobs(relay)
    answer = call(relay, 'speech.transcribe', {
      upload: 'rec_12345678',
      parts: 1,
      mimeType: 'audio/webm'
    })
    ;({ jobs } = await waiting)
    relay.take('window-a', jobs[0].id)
    relay.finish('window-a', jobs[0].id, { ok: true, text: 'hello' })
    expect(await answer).toEqual({ ok: true, text: 'hello' })
    expect(relay.recording(phone.node, 'rec_12345678', 1)).toMatchObject({ ok: false })
  })

  it('keeps the recording when no window is open, so the phone can try again', async () => {
    const relay = new SpeechRelay(new ManualClock())
    await call(relay, 'speech.upload', { upload: 'rec_12345678', index: 0, data: piece([1, 2, 3]) })
    const params = { upload: 'rec_12345678', parts: 1, mimeType: 'audio/webm' }
    expect(await call(relay, 'speech.transcribe', params)).toMatchObject({
      ok: false,
      code: 'no_host'
    })
    const waiting = nextJobs(relay)
    const answer = call(relay, 'speech.transcribe', params)
    const { jobs } = await waiting
    relay.take('window-a', jobs[0].id)
    relay.finish('window-a', jobs[0].id, { ok: true, text: 'hello' })
    expect(await answer).toEqual({ ok: true, text: 'hello' })
  })

  it('keeps the recording when the computer is busy', async () => {
    const relay = new SpeechRelay(new ManualClock())
    await call(relay, 'speech.upload', { upload: 'rec_12345678', index: 0, data: piece([1, 2, 3]) })
    void nextJobs(relay)
    for (let index = 0; index < PHONE_SPEECH_MAX_JOBS; index += 1)
      void call(relay, 'speech.options', { kind: 'dictation' })
    expect(
      await call(relay, 'speech.transcribe', {
        upload: 'rec_12345678',
        parts: 1,
        mimeType: 'audio/webm'
      })
    ).toMatchObject({ ok: false, code: 'busy' })
    expect(relay.recording(phone.node, 'rec_12345678', 1)).toEqual(Buffer.from([1, 2, 3]))
  })

  it('drops the recording once the window ran it, even when the run failed', async () => {
    const relay = new SpeechRelay(new ManualClock())
    await call(relay, 'speech.upload', { upload: 'rec_12345678', index: 0, data: piece([1, 2, 3]) })
    const waiting = nextJobs(relay)
    const answer = call(relay, 'speech.transcribe', {
      upload: 'rec_12345678',
      parts: 1,
      mimeType: 'audio/webm'
    })
    const { jobs } = await waiting
    relay.take('window-a', jobs[0].id)
    relay.finish('window-a', jobs[0].id, { ok: false, code: 'failed', error: 'Decoding failed' })
    expect(await answer).toMatchObject({ code: 'failed' })
    expect(relay.recording(phone.node, 'rec_12345678', 1)).toMatchObject({ ok: false })
  })
})

describe('speech host methods', () => {
  function setup() {
    const registry = new DomainHandlerRegistry()
    const relay = new SpeechRelay(new ManualClock())
    registerSpeechHostMethods(registry, () => relay)
    const ctx = (clientType: 'gui' | 'cli', id = 'conn-1'): HandlerContext =>
      ({
        mms: {} as HandlerContext['mms'],
        globalSequence: () => 0,
        connection: {
          id,
          clientType,
          binding: { profileId: 'default', epoch: 1 },
          capabilities: new Set([NET_LOCAL_CAPABILITY])
        }
      }) as HandlerContext
    return { registry, relay, ctx }
  }

  it('serves only Mousse windows', async () => {
    const { registry, ctx } = setup()
    await expect(registry.dispatch(ctx('cli'), 'speech.host.wait', {})).rejects.toThrow(
      /Mousse window/
    )
    await expect(
      registry.dispatch(ctx('gui'), 'speech.host.take', { id: 'sj_unknown_job' })
    ).resolves.toEqual({ job: null })
  })

  it('bounds what a window sends back', () => {
    expect(() => validateSpeechHostParams('speech.host.take', { id: '../x' })).toThrow()
    expect(() =>
      validateSpeechHostParams('speech.host.progress', {
        id: 'sj_abcdefgh',
        data: { blob: 'x'.repeat(70 * 1024) }
      })
    ).toThrow()
    expect(() =>
      validateSpeechHostParams('speech.host.finish', {
        id: 'sj_abcdefgh',
        result: { ok: false, code: 'weird', error: 'x' }
      })
    ).toThrow()
    expect(() =>
      validateSpeechHostParams('speech.host.finish', {
        id: 'sj_abcdefgh',
        result: { ok: false, code: 'no_model', error: 'Choose one' }
      })
    ).not.toThrow()
    expect(() => validateSpeechHostParams('speech.host.wait', { other: 1 })).toThrow()
  })

  it('fails the work of a window whose connection closes', async () => {
    const { registry, relay, ctx } = setup()
    const waiting = registry.dispatch(ctx('gui'), 'speech.host.wait', {}) as Promise<{
      jobs: Array<{ id: string }>
    }>
    await flush()
    const answer = call(relay, 'speech.options', { kind: 'readAloud' })
    const { jobs } = await waiting
    await registry.dispatch(ctx('gui'), 'speech.host.take', { id: jobs[0].id })
    registry.notifyConnectionClosed('conn-1')
    expect(await answer).toMatchObject({ ok: false, code: 'failed' })
  })
})
