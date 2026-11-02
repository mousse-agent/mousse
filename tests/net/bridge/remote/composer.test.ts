import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../../../src/mms/MousseMainService'
import {
  BRIDGE_REMOTE_METHODS,
  MmsRemoteBackend,
  RemoteApi,
  validateRemoteParams,
  type RemoteBackendPort
} from '../../../../src/mms/bridge/remote'
import { MmsThreadSource } from '../../../../src/mms/bridge/remote/MmsThreadSource'
import {
  REMOTE_MESSAGE_IMAGES_MAX_CHARS,
  STAGED_UPLOAD_TTL_MS
} from '../../../../src/mms/bridge/remote/RemoteApi'
import type { RpcContext } from '../../../../src/mms/net/contracts'
import { newId, type NodeId, type UserId } from '../../../../src/shared/net'
import type { SkillDescriptor } from '../../../../src/shared/integrations'

const clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  setTimeout: (callback: () => void, ms: number) => {
    const timer = setTimeout(callback, ms)
    return { cancel: () => clearTimeout(timer) }
  }
}
const phone = { node: newId('node') as NodeId, user: newId('user') as UserId }

function context(caller = phone): RpcContext {
  return {
    id: newId('rpc'),
    caller: caller as RpcContext['caller'],
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60_000,
    progress: () => undefined
  }
}

function call(api: RemoteApi, method: string, params: unknown, caller = phone): Promise<unknown> {
  const entry = api.methods().find((row) => row.method === method)
  if (!entry) throw new Error('unregistered ' + method)
  entry.validate(params)
  return Promise.resolve(entry.handle(params, context(caller)))
}

function stage(api: RemoteApi, upload: string, data: string, chunk = 4, caller = phone) {
  const parts: string[] = []
  for (let i = 0; i < data.length; i += chunk) parts.push(data.slice(i, i + chunk))
  return parts.map((part, index) =>
    call(
      api,
      'attachments.stage',
      {
        upload,
        index,
        total: parts.length,
        name: 'shot.png',
        mimeType: 'image/png',
        data: part
      },
      caller
    )
  )
}

/** A clock whose timers fire only when the test advances it. */
function manualClock() {
  let now = 1_000_000
  const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = []
  return {
    now: () => now,
    monotonic: () => now,
    setTimeout: (callback: () => void, ms: number) => {
      const timer = { at: now + ms, callback, cancelled: false }
      timers.push(timer)
      return { cancel: () => void (timer.cancelled = true) }
    },
    advance(ms: number) {
      now += ms
      for (const timer of timers.splice(0))
        if (timer.cancelled) continue
        else if (timer.at <= now) timer.callback()
        else timers.push(timer)
    },
    pending: () => timers.filter((timer) => !timer.cancelled).length
  }
}

const idleBackend: RemoteBackendPort = {
  execute: async () => ({ ok: true }),
  snapshot: () => ({}),
  run: async () => ({ text: 'done', silent: false })
}

const resources: Array<() => unknown> = []
afterEach(async () => {
  for (const dispose of resources.splice(0).reverse()) await dispose()
})

describe('remote composer methods', () => {
  it('exposes composer reads to read nodes and composer writes to chat nodes', () => {
    expect(BRIDGE_REMOTE_METHODS['composer.options'].capability).toBe('read')
    expect(BRIDGE_REMOTE_METHODS['queue.list'].capability).toBe('read')
    for (const method of [
      'threads.setModel',
      'attachments.stage',
      'queue.enqueue',
      'queue.remove',
      'queue.reorder',
      'queue.promoteToSteer'
    ] as const)
      expect(BRIDGE_REMOTE_METHODS[method]).toEqual({ capability: 'chat', mutating: true })
  })

  it('validates modes, attachments, model selections and image chunks', () => {
    const ok = (method: keyof typeof BRIDGE_REMOTE_METHODS, params: unknown) =>
      expect(() => validateRemoteParams(method, params)).not.toThrow()
    const bad = (method: keyof typeof BRIDGE_REMOTE_METHODS, params: unknown) =>
      expect(() => validateRemoteParams(method, params)).toThrow()
    ok('orchestrator.send', { threadId: 't', content: 'hi' })
    ok('orchestrator.send', {
      threadId: 't',
      content: 'hi',
      mode: 'plan',
      attachments: ['upload-0001']
    })
    ok('queue.enqueue', {
      threadId: 't',
      content: 'hi',
      mode: { type: 'skill', skillId: 'review' }
    })
    bad('orchestrator.send', { threadId: 't', content: 'hi', mode: 'yolo' })
    bad('orchestrator.send', { threadId: 't', content: 'hi', mode: { type: 'skill', skillId: '' } })
    bad('orchestrator.send', { threadId: 't', content: 'hi', attachments: [] })
    bad('orchestrator.send', { threadId: 't', content: 'hi', attachments: ['../x'] })
    bad('orchestrator.send', { threadId: 't', content: 'hi', images: [] })
    ok('threads.setModel', {
      threadId: 't',
      model: { instanceId: 'pi:anthropic', model: 'm:high' }
    })
    bad('threads.setModel', { threadId: 't', model: { model: 'm' } })
    bad('threads.setModel', {
      threadId: 't',
      model: { llmProvider: 'x', model: 'm', global: true }
    })
    const chunk = {
      upload: 'upload-0001',
      index: 0,
      total: 1,
      name: 'a.png',
      mimeType: 'image/png',
      data: 'AAAA'
    }
    ok('attachments.stage', chunk)
    bad('attachments.stage', { ...chunk, mimeType: 'text/html' })
    bad('attachments.stage', { ...chunk, index: 1 })
    bad('attachments.stage', { ...chunk, data: 'not base64!' })
    bad('attachments.stage', { ...chunk, data: 'A'.repeat(48 * 1024 + 4) })
  })

  it('assembles staged images for the caller that staged them and consumes them on send', async () => {
    const runs: Array<{ content: string; extras: unknown }> = []
    const backend: RemoteBackendPort = {
      execute: async (method, params) => ({ method, params }),
      snapshot: () => ({}),
      run: async (_threadId, content, control, extras) => {
        control.onAccepted()
        runs.push({ content, extras })
        return { text: 'done', silent: false }
      }
    }
    const api = new RemoteApi(backend, clock)
    resources.push(() => api.close())
    const data = Buffer.from('a small png stand-in').toString('base64')
    const staged = await Promise.all(stage(api, 'upload-0001', data))
    expect(staged.at(-1)).toMatchObject({ ok: true, received: staged.length })

    const other = { node: newId('node') as NodeId, user: phone.user }
    expect(
      await call(
        api,
        'orchestrator.send',
        { threadId: 't', content: 'look', attachments: ['upload-0001'] },
        other
      )
    ).toMatchObject({ error: expect.stringMatching(/did not finish uploading/) })

    await call(api, 'orchestrator.send', {
      threadId: 't',
      content: 'look',
      mode: 'plan',
      attachments: ['upload-0001']
    })
    expect(runs).toEqual([
      {
        content: 'look',
        extras: { mode: 'plan', images: [{ name: 'shot.png', mimeType: 'image/png', data }] }
      }
    ])
    expect(
      await call(api, 'orchestrator.send', {
        threadId: 't',
        content: 'again',
        attachments: ['upload-0001']
      })
    ).toMatchObject({ error: expect.stringMatching(/did not finish uploading/) })

    await Promise.all(stage(api, 'upload-0002', data))
    expect(
      await call(api, 'queue.enqueue', {
        threadId: 't',
        content: 'later',
        attachments: ['upload-0002']
      })
    ).toEqual({
      method: 'queue.enqueue',
      params: {
        threadId: 't',
        content: 'later',
        images: [{ name: 'shot.png', mimeType: 'image/png', data }]
      }
    })
  })

  it('keeps staged images when the backend refuses the send or the enqueue', async () => {
    let refuse = true
    const backend: RemoteBackendPort = {
      execute: async () => (refuse ? { ok: false, error: 'Queue is closed' } : { ok: true }),
      snapshot: () => ({}),
      run: async (_threadId, _content, control) => {
        if (refuse) return { text: '', silent: false, error: 'Thread already has a running turn' }
        control.onAccepted()
        return { text: 'ok', silent: false }
      }
    }
    const api = new RemoteApi(backend, clock)
    resources.push(() => api.close())
    await Promise.all(stage(api, 'upload-0001', 'AAAA'))
    await Promise.all(stage(api, 'upload-0002', 'AAAA'))
    const send = { threadId: 't', content: 'look', attachments: ['upload-0001'] }
    const enqueue = { threadId: 't', content: 'later', attachments: ['upload-0002'] }
    expect(await call(api, 'orchestrator.send', send)).toMatchObject({ error: expect.any(String) })
    expect(await call(api, 'queue.enqueue', enqueue)).toMatchObject({ ok: false })
    refuse = false
    expect(await call(api, 'orchestrator.send', send)).toMatchObject({ text: 'ok' })
    expect(await call(api, 'queue.enqueue', enqueue)).toMatchObject({ ok: true })
    expect(await call(api, 'orchestrator.send', send)).toMatchObject({
      error: expect.stringMatching(/did not finish uploading/)
    })
  })

  it('does not let two concurrent sends use the same staged image', async () => {
    let release: () => void = () => undefined
    const backend: RemoteBackendPort = {
      ...idleBackend,
      run: (_threadId, _content, control) =>
        new Promise((resolve) => {
          release = () => {
            control.onAccepted()
            resolve({ text: 'ok', silent: false })
          }
        })
    }
    const api = new RemoteApi(backend, clock)
    resources.push(() => api.close())
    await Promise.all(stage(api, 'upload-0001', 'AAAA'))
    const first = call(api, 'orchestrator.send', {
      threadId: 't1',
      content: 'a',
      attachments: ['upload-0001']
    })
    expect(
      await call(api, 'orchestrator.send', {
        threadId: 't2',
        content: 'b',
        attachments: ['upload-0001']
      })
    ).toMatchObject({ error: expect.stringMatching(/did not finish uploading/) })
    release()
    expect(await first).toMatchObject({ text: 'ok' })
  })

  it('refuses images that together are too large for a remote display', async () => {
    const runs: unknown[] = []
    const api = new RemoteApi(
      {
        ...idleBackend,
        run: async (threadId, content, control, extras) => {
          control.onAccepted()
          runs.push([threadId, content, extras])
          return { text: 'ok', silent: false }
        }
      },
      clock
    )
    resources.push(() => api.close())
    const big = 'A'.repeat(3 * 1024 * 1024)
    const ids = ['upload-0001', 'upload-0002', 'upload-0003']
    for (const id of ids) await Promise.all(stage(api, id, big, 48 * 1024))
    expect(
      await call(api, 'orchestrator.send', { threadId: 't', content: 'x', attachments: ids })
    ).toMatchObject({ error: expect.stringMatching(/too large to send together/) })
    expect(runs).toEqual([])
    // Each image alone still goes through, and the refused batch kept its uploads.
    expect(
      await call(api, 'orchestrator.send', {
        threadId: 't',
        content: 'x',
        attachments: ids.slice(0, 2)
      })
    ).toMatchObject({ text: 'ok' })
    expect(runs).toHaveLength(1)
  })

  it('bounds staged image memory by bytes for each caller', async () => {
    const api = new RemoteApi(idleBackend, clock)
    resources.push(() => api.close())
    const big = 'A'.repeat(3 * 1024 * 1024)
    for (let i = 1; i <= 8; i++) await Promise.all(stage(api, 'upload-000' + i, big, 48 * 1024))
    const refused = await Promise.all(
      stage(api, 'upload-0009', big, 48 * 1024).map((p) => p.catch((e) => e))
    )
    expect(refused.some((r) => (r as { ok?: boolean }).ok === false)).toBe(true)
    const other = { node: newId('node') as NodeId, user: newId('user') as UserId }
    expect(await Promise.all(stage(api, 'upload-0001', 'AAAA', 4, other))).toEqual([
      expect.objectContaining({ ok: true })
    ])
  })

  it('drops abandoned uploads after the ttl without another request, and stops its timer on close', async () => {
    const time = manualClock()
    const api = new RemoteApi(idleBackend, time)
    await Promise.all(stage(api, 'upload-0001', 'AAAA'))
    expect(time.pending()).toBe(1)
    time.advance(STAGED_UPLOAD_TTL_MS - 1)
    expect(
      await call(api, 'queue.enqueue', {
        threadId: 't',
        content: 'x',
        attachments: ['upload-0001']
      })
    ).toEqual({ ok: true })
    await Promise.all(stage(api, 'upload-0002', 'AAAA'))
    expect((api as unknown as { uploads: Map<string, unknown> }).uploads.size).toBe(1)
    time.advance(STAGED_UPLOAD_TTL_MS + 2)
    expect((api as unknown as { uploads: Map<string, unknown> }).uploads.size).toBe(0)
    expect(time.pending()).toBe(0)
    await Promise.all(stage(api, 'upload-0003', 'AAAA'))
    expect(time.pending()).toBe(1)
    api.close()
    expect(time.pending()).toBe(0)
  })

  it('a remote Stop ends the remote turn and also Stops the thread, so the subagents it started end too', async () => {
    const stopped: string[] = []
    const backend: RemoteBackendPort = {
      ...idleBackend,
      run: (_threadId, _content, control) =>
        new Promise((resolve) => {
          control.signal.addEventListener('abort', () => resolve({ text: '', silent: true, aborted: true }), { once: true })
        }),
      stop: async (threadId) => {
        stopped.push(threadId)
      }
    }
    const api = new RemoteApi(backend, clock)
    resources.push(() => api.close())
    const runContext = context()
    const entry = api.methods().find((row) => row.method === 'orchestrator.send')!
    const pending = Promise.resolve(entry.handle({ threadId: 'thread-2', content: 'work' }, runContext))
    // Another caller cannot stop it.
    const stranger = { node: newId('node') as NodeId, user: newId('user') as UserId }
    await expect(call(api, 'orchestrator.abort', { threadId: 'thread-2', run: runContext.id }, stranger)).rejects.toMatchObject({ code: 'forbidden' })
    expect(stopped).toEqual([])
    expect(await call(api, 'orchestrator.abort', { threadId: 'thread-2', run: runContext.id })).toEqual({ ok: true })
    expect(stopped).toEqual(['thread-2'])
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    // With no remote run left to end it is still a Stop of the thread (its subagents may be working under an idle
    // parent); `ok` says whether it stopped anything.
    expect(await call(api, 'orchestrator.abort', { threadId: 'thread-2', run: runContext.id })).toEqual({ ok: false })
    expect(stopped).toEqual(['thread-2', 'thread-2'])
  })

  it('a remote Stop with no remote run stops the thread\'s subagents and reports whether anything stopped', async () => {
    const results: unknown[] = [{ ok: true }, { ok: false }]
    const stopped: string[] = []
    const backend: RemoteBackendPort = {
      ...idleBackend,
      stop: async (threadId) => {
        stopped.push(threadId)
        return results.shift()
      }
    }
    const api = new RemoteApi(backend, clock)
    resources.push(() => api.close())
    expect(await call(api, 'orchestrator.abort', { threadId: 'idle-parent', run: newId('rpc') })).toEqual({ ok: true })
    expect(await call(api, 'orchestrator.abort', { threadId: 'idle-parent', run: newId('rpc') })).toEqual({ ok: false })
    expect(stopped).toEqual(['idle-parent', 'idle-parent'])
    // Another caller's live remote run on the thread is not this caller's to end, whatever run id it names.
    const owned: string[] = []
    const guarded = new RemoteApi({
      ...idleBackend,
      run: (_threadId, _content, control) => new Promise((resolve) => control.signal.addEventListener('abort', () => resolve({ text: '', silent: true, aborted: true }), { once: true })),
      stop: async (threadId) => {
        owned.push(threadId)
        return { ok: true }
      }
    }, clock)
    resources.push(() => guarded.close())
    const runContext = context()
    const entry = guarded.methods().find((row) => row.method === 'orchestrator.send')!
    const running = Promise.resolve(entry.handle({ threadId: 'busy', content: 'work' }, runContext)).catch((error: unknown) => error)
    const stranger = { node: newId('node') as NodeId, user: newId('user') as UserId }
    await expect(call(guarded, 'orchestrator.abort', { threadId: 'busy', run: newId('rpc') }, stranger)).rejects.toMatchObject({ code: 'forbidden' })
    expect(owned).toEqual([])
    // The owner's own Stop with a fresh id, and anyone's Stop of a thread nobody runs remotely, still work.
    expect(await call(guarded, 'orchestrator.abort', { threadId: 'busy', run: newId('rpc') })).toEqual({ ok: true })
    expect(await call(guarded, 'orchestrator.abort', { threadId: 'idle', run: newId('rpc') }, stranger)).toEqual({ ok: true })
    expect(owned).toEqual(['busy', 'idle'])
    await call(guarded, 'orchestrator.abort', { threadId: 'busy', run: runContext.id })
    await running
    // A backend without the hook answers as before.
    const bare = new RemoteApi(idleBackend, clock)
    resources.push(() => bare.close())
    expect(await call(bare, 'orchestrator.abort', { threadId: 'idle-parent', run: newId('rpc') })).toEqual({ ok: false })
  })

  it('gives staged images back when a send is cancelled before the message is stored', async () => {
    let accept = false
    const backend: RemoteBackendPort = {
      ...idleBackend,
      run: (_threadId, _content, control) =>
        new Promise((resolve) => {
          const finish = (): void => {
            if (accept) control.onAccepted()
            resolve({ text: '', silent: true, aborted: true })
          }
          control.signal.addEventListener('abort', finish, { once: true })
        })
    }
    const api = new RemoteApi(backend, clock)
    resources.push(() => api.close())
    const send = { threadId: 't', content: 'look', attachments: ['upload-0001'] }
    const cancelledSend = async (): Promise<unknown> => {
      const abort = new AbortController()
      const entry = api.methods().find((row) => row.method === 'orchestrator.send')!
      const pending = Promise.resolve(entry.handle(send, { ...context(), signal: abort.signal }))
      abort.abort()
      return pending.catch((error: unknown) => error)
    }
    await Promise.all(stage(api, 'upload-0001', 'AAAA'))
    expect(await cancelledSend()).toMatchObject({ code: 'cancelled' })
    // Nothing was stored, so the same upload can be sent again.
    const uploads = (api as unknown as { uploads: Map<string, { claimed: boolean }> }).uploads
    expect([...uploads.values()].map((upload) => upload.claimed)).toEqual([false])
    // Once the message is stored, a cancelled turn still uses the image up.
    accept = true
    expect(await cancelledSend()).toMatchObject({ code: 'cancelled' })
    expect(uploads.size).toBe(0)
  })

  it('does not keep re-arming the sweep timer for an upload held by a long send', async () => {
    const time = manualClock()
    let finish: (accepted: boolean) => void = () => undefined
    const backend: RemoteBackendPort = {
      ...idleBackend,
      run: (_threadId, _content, control) =>
        new Promise((resolve) => {
          finish = (accepted) => {
            if (accepted) control.onAccepted()
            resolve({ text: 'ok', silent: false })
          }
        })
    }
    const api = new RemoteApi(backend, time)
    const timer = () => (api as unknown as { sweepTimer?: unknown }).sweepTimer
    await Promise.all(stage(api, 'upload-0001', 'AAAA'))
    const sending = call(api, 'orchestrator.send', {
      threadId: 't',
      content: 'look',
      attachments: ['upload-0001']
    })
    time.advance(STAGED_UPLOAD_TTL_MS + 5000)
    expect(timer()).toBeUndefined()
    // A refused send gives the image back and expiry is scheduled again.
    finish(false)
    await sending
    expect(timer()).toBeDefined()
    time.advance(STAGED_UPLOAD_TTL_MS + 2)
    expect((api as unknown as { uploads: Map<string, unknown> }).uploads.size).toBe(0)
    expect(timer()).toBeUndefined()
    api.close()
  })

  it('applies the sender deadline until the message is stored, never to the turn that follows', async () => {
    const time = manualClock()
    const runs: Array<{ signal: AbortSignal; onAccepted(): void; finish(): void }> = []
    const backend: RemoteBackendPort = {
      ...idleBackend,
      run: (_threadId, _content, control) =>
        new Promise((resolve) => {
          const finish = (): void => resolve({ text: 'finished', silent: false })
          runs.push({ signal: control.signal, onAccepted: control.onAccepted, finish })
          control.signal.addEventListener('abort', finish, { once: true })
        })
    }
    const api = new RemoteApi(backend, time)
    resources.push(() => api.close())
    const send = (threadId: string, signal = new AbortController().signal, deadlineMs = 1000) =>
      Promise.resolve(
        api
          .methods()
          .find((row) => row.method === 'orchestrator.send')!
          .handle({ threadId, content: 'work' }, { ...context(), signal, deadlineAt: time.now() + deadlineMs })
      )
    // The message is stored, then the deadline passes: the turn keeps running until it is done,
    // also when the session ends the request's signal at its deadline.
    const session = new AbortController()
    const accepted = send('long-turn', session.signal)
    runs[0].onAccepted()
    time.advance(60 * 60_000)
    session.abort()
    expect(runs[0].signal.aborted).toBe(false)
    runs[0].finish()
    expect(await accepted).toMatchObject({ text: 'finished' })
    // The deadline passes before the message is stored: the send is abandoned.
    const abandoned = send('never-accepted')
    time.advance(2000)
    expect(runs[1].signal.aborted).toBe(true)
    await expect(abandoned).rejects.toMatchObject({ code: 'cancelled' })
    // A cancel from the sender, well before the deadline, still ends an accepted turn.
    const cancel = new AbortController()
    const cancelled = send('cancelled-turn', cancel.signal, 60_000)
    runs[2].onAccepted()
    cancel.abort()
    expect(runs[2].signal.aborted).toBe(true)
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('refuses a chunk that changes an upload already in progress', async () => {
    const api = new RemoteApi(
      { execute: async () => ({}), snapshot: () => ({}), run: async () => ({}) },
      clock
    )
    resources.push(() => api.close())
    const base = { upload: 'upload-0003', total: 2, name: 'a.png', mimeType: 'image/png' }
    expect(await call(api, 'attachments.stage', { ...base, index: 0, data: 'AAAA' })).toMatchObject(
      { ok: true }
    )
    expect(await call(api, 'attachments.stage', { ...base, index: 0, data: 'AAAA' })).toMatchObject(
      { ok: true, received: 1 }
    )
    expect(await call(api, 'attachments.stage', { ...base, index: 0, data: 'BBBB' })).toMatchObject(
      { ok: false }
    )
    expect(
      await call(api, 'attachments.stage', { ...base, total: 3, index: 1, data: 'BBBB' })
    ).toMatchObject({ ok: false })
  })
})

describe('remote composer methods on a real profile', () => {
  async function profile() {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-remote-composer-')))
    const mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
    const api = new RemoteApi(new MmsRemoteBackend(mms), clock)
    resources.push(
      () => rmSync(home, { recursive: true, force: true }),
      () => mms.stop(),
      () => api.close()
    )
    return { mms, api }
  }

  it('lists composer options without paths', async () => {
    const { mms, api } = await profile()
    const thread = mms.threads.createThread('Options')
    const options = (await call(api, 'composer.options', { threadId: thread.id })) as Record<
      string,
      unknown
    >
    expect(Array.isArray(options.providers)).toBe(true)
    expect(options.modes).toEqual(['plan', 'agent', 'build'])
    expect(Array.isArray(options.skills)).toBe(true)
    const commands = options.commands as Array<{ name: string }>
    expect(commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(['new', 'stop', 'steer', 'skills'])
    )
    expect(JSON.stringify(options)).not.toMatch(/skillPath|rootPath/)
  })

  it('offers only the skills a turn would load, and refuses other skill modes', async () => {
    const { mms, api } = await profile()
    const thread = mms.threads.createThread('Skills')
    const skill = (id: string): SkillDescriptor => ({
      id,
      installationId: id,
      name: id.split(':')[1],
      description: 'About ' + id,
      rootPath: '/tmp/' + id,
      skillPath: '/tmp/' + id + '/SKILL.md',
      scope: 'global',
      source: 'mousse-profile',
      enabled: true,
      isActive: true
    })
    vi.spyOn(mms.skillsRegistry, 'discover').mockResolvedValue({
      sources: [],
      diagnostics: [],
      skills: [skill('mousse-profile:one'), skill('mousse-profile:two')]
    })
    const skillsOf = async () =>
      ((await call(api, 'composer.options', { threadId: thread.id })) as { skills: unknown[] })
        .skills
    const enable = (enabledSkills: string[]) =>
      mms.settings.set({
        integrations: {
          skills: { enabled: true, enableForMainAgent: true, enabledSkills }
        }
      } as Parameters<typeof mms.settings.set>[0])
    enable([])
    expect(await skillsOf()).toEqual([])
    enable(['mousse-profile:one'])
    expect(await skillsOf()).toEqual([
      { id: 'mousse-profile:one', name: 'one', description: 'About mousse-profile:one' }
    ])

    const enqueue = (skillId: string) =>
      call(api, 'queue.enqueue', {
        threadId: thread.id,
        content: 'use it',
        mode: { type: 'skill', skillId }
      })
    expect(await enqueue('mousse-profile:two')).toMatchObject({ ok: false })
    expect(mms.orchestrator.listQueue(thread.id)).toEqual([])
    // An accepted enqueue would start a turn on an idle thread, so only the hand-off is observed.
    const accept = vi.spyOn(mms.orchestrator, 'enqueueAndDrain').mockImplementation(
      (_threadId, input) =>
        ({
          id: 'q1',
          content: input.content,
          images: [],
          enqueuedAt: 0,
          order: 0,
          intent: 'queue',
          state: 'queued'
        }) as unknown as ReturnType<typeof mms.orchestrator.enqueueAndDrain>
    )
    expect(await enqueue('mousse-profile:one')).toMatchObject({ ok: true })
    expect(accept).toHaveBeenCalledTimes(1)
    expect(
      await call(api, 'orchestrator.send', {
        threadId: thread.id,
        content: 'use it',
        mode: { type: 'skill', skillId: 'mousse-profile:two' }
      })
    ).toMatchObject({ error: expect.stringMatching(/not available/) })
    expect(mms.orchestrator.getMessages(thread.id)).toEqual([])
  })

  it('keeps the remote thread snapshot and events small however many images the thread holds', async () => {
    const { mms, api } = await profile()
    const thread = mms.threads.createThread('Images')
    const data = 'A'.repeat(6 * 1024 * 1024)
    const image = { name: 'big.png', mimeType: 'image/png', data }
    const messages = Array.from({ length: 5 }, (_, index) => ({
      id: 'm' + index,
      role: 'user' as const,
      content: 'look ' + index,
      timestamp: new Date(index).toISOString(),
      images: [image, image]
    }))
    vi.spyOn(mms.orchestrator, 'getMessages').mockReturnValue(messages)
    for (let index = 0; index < 4; index++)
      mms.orchestrator.enqueueForThread(thread.id, { content: 'later ' + index, images: [image] })

    const budget = REMOTE_MESSAGE_IMAGES_MAX_CHARS + 64 * 1024
    const nameOnly = { name: 'big.png', mimeType: 'image/png' }
    const backend = new MmsRemoteBackend(mms)
    const snapshot = backend.snapshot(thread.id) as {
      messages: Array<{ images: unknown[] }>
      queue: Array<{ images: unknown[] }>
    }
    const text = JSON.stringify(snapshot)
    expect(text.length).toBeLessThan(budget)
    expect(snapshot.messages).toHaveLength(5)
    // Newest first: only the last image of the newest message fits in the budget.
    expect(snapshot.messages[4].images).toEqual([nameOnly, image])
    for (const message of snapshot.messages.slice(0, 4))
      expect(message.images).toEqual([nameOnly, nameOnly])
    expect(snapshot.queue).toHaveLength(4)
    expect(snapshot.queue[0].images).toEqual([nameOnly])
    expect(
      JSON.stringify(await call(api, 'thread.snapshot', { threadId: thread.id })).length
    ).toBeLessThan(budget)

    const source = new MmsThreadSource(mms)
    const events: Array<{ type: string; data: any }> = []
    const stop = source.onThread(thread.id, (event) =>
      events.push({ type: event.type, data: event.data })
    )
    resources.push(stop)
    mms.orchestrator.emit('thread-message', { threadId: thread.id, message: messages[4] })
    mms.orchestrator.emit('thread-messages', { threadId: thread.id, messages })
    mms.orchestrator.emit('queue-updated', {
      threadId: thread.id,
      items: mms.orchestrator.listQueue(thread.id)
    })
    expect(events.map((event) => event.type)).toEqual([
      'thread.message',
      'thread.messages',
      'queue.updated'
    ])
    for (const event of events) expect(JSON.stringify(event.data).length).toBeLessThan(budget)
    // A single message with images keeps the newest within the budget; the queue stays name-only.
    expect(events[0].data.message.images).toEqual([nameOnly, image])
    expect(events[1].data.messages[4].images).toEqual([nameOnly, image])
    expect(events[1].data.messages[3].images).toEqual([nameOnly, nameOnly])
    expect(JSON.stringify(events[2].data).length).toBeLessThan(64 * 1024)
  })

  it('keeps the data of recent images and drops it from older ones once the budget is used', async () => {
    const { mms } = await profile()
    const thread = mms.threads.createThread('Recent images')
    const small = { name: 'photo.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' }
    const big = {
      name: 'old.png',
      mimeType: 'image/png',
      data: 'B'.repeat(REMOTE_MESSAGE_IMAGES_MAX_CHARS)
    }
    const messages = [
      {
        id: 'a',
        role: 'user' as const,
        content: 'old',
        timestamp: '2026-01-01T00:00:00Z',
        images: [big]
      },
      {
        id: 'b',
        role: 'user' as const,
        content: 'new',
        timestamp: '2026-01-02T00:00:00Z',
        images: [small]
      },
      {
        id: 'c',
        role: 'user' as const,
        content: 'new too',
        timestamp: '2026-01-03T00:00:00Z',
        images: [small, small]
      }
    ]
    vi.spyOn(mms.orchestrator, 'getMessages').mockReturnValue(messages)

    const snapshot = new MmsRemoteBackend(mms).snapshot(thread.id) as {
      messages: Array<{ images: unknown[] }>
    }
    expect(snapshot.messages[2].images).toEqual([small, small])
    expect(snapshot.messages[1].images).toEqual([small])
    expect(snapshot.messages[0].images).toEqual([{ name: 'old.png', mimeType: 'image/png' }])
    // The stored messages themselves are untouched.
    expect(messages[0].images[0].data).toHaveLength(REMOTE_MESSAGE_IMAGES_MAX_CHARS)
  })

  it('a remote Stop with no run of its own does not end a turn someone else is running', async () => {
    const stopped: string[] = []
    let active = true
    const backend: RemoteBackendPort = { ...idleBackend, isActive: () => active, stop: async (threadId) => { stopped.push(threadId); return { ok: true } } }
    const api = new RemoteApi(backend, clock)
    resources.push(() => api.close())
    // The desktop user's (or a CLI's, channel's, schedule's) turn is live: a remote caller's Stop is refused like a steer.
    expect(await call(api, 'orchestrator.abort', { threadId: 'busy', run: newId('rpc') })).toEqual({ ok: false })
    expect(stopped).toEqual([])
    // The thread itself is idle (an idle parent whose subagents work): the Stop goes through.
    active = false
    expect(await call(api, 'orchestrator.abort', { threadId: 'busy', run: newId('rpc') })).toEqual({ ok: true })
    expect(stopped).toEqual(['busy'])
  })

  it('a profile backend says a thread is active while any turn of it is live', async () => {
    const { mms } = await profile()
    const backend = new MmsRemoteBackend(mms)
    const thread = mms.threads.createThread('Active')
    expect(backend.isActive(thread.id)).toBe(false)
    const turn = vi.spyOn(mms.orchestrator, 'isTurnActive').mockReturnValue(true)
    expect(backend.isActive(thread.id)).toBe(true)
    turn.mockRestore()
  })

  it('a thread whose turn is admitted or claimed but not running yet is active too', async () => {
    const { mms } = await profile()
    const backend = new MmsRemoteBackend(mms)
    const admitted = mms.threads.createThread('Admitted')
    expect(backend.isActive(admitted.id)).toBe(false)
    // Admission, queue promotion and workspace setup happen before the run is marked starting.
    mms.orchestrator.getOrCreateSession(admitted.id).turnAdmitted = true
    expect(backend.isActive(admitted.id)).toBe(true)
    mms.orchestrator.getOrCreateSession(admitted.id).turnAdmitted = false

    const claimed = mms.threads.createThread('Claimed')
    const sent = await mms.runEngine.dispatch({ kind: 'send', threadId: claimed.id, clientRequestId: 'send-claimed', source: 'gui' })
    if (sent.status !== 'accepted') throw new Error('send rejected')
    mms.runEngine.outbox.enqueue({ threadId: claimed.id, runId: sent.runId, kind: 'turn.start', payload: { threadId: claimed.id, runId: sent.runId } })
    expect(backend.isActive(claimed.id)).toBe(false)
    expect(mms.runEngine.outbox.claimNext(mms.runEngine.leaseOwner, new Date().toISOString(), { lanes: ['turn'] })).not.toBeNull()
    expect(mms.runEngine.getRun(sent.runId)!.status).toBe('queued')
    expect(backend.isActive(claimed.id)).toBe(true)
  })

  it('a remote Stop reaches only the threads of this profile', async () => {
    const { mms } = await profile()
    const backend = new MmsRemoteBackend(mms)
    await expect(backend.stop('no-such-thread')).rejects.toMatchObject({ code: 'stream_unknown' })
    const thread = mms.threads.createThread('Stoppable')
    await expect(backend.stop(thread.id)).resolves.toMatchObject({ status: 'stopped' })
  })

  it('sets one thread model without changing the computer default', async () => {
    const { mms, api } = await profile()
    const thread = mms.threads.createThread('Model')
    const before = mms.settings.get().provider
    const result = await call(api, 'threads.setModel', {
      threadId: thread.id,
      model: { instanceId: 'pi:anthropic', model: 'claude-opus-4-8', effort: 'high' }
    })
    expect(result).toMatchObject({
      ok: true,
      modelOverride: { instanceId: 'pi:anthropic', model: 'claude-opus-4-8', effort: 'high' }
    })
    expect(mms.threads.getThread(thread.id)?.modelOverride).toMatchObject({
      model: 'claude-opus-4-8',
      effort: 'high'
    })
    // An older device packs the level into the model; it is stored apart all the same.
    await call(api, 'threads.setModel', {
      threadId: thread.id,
      model: { instanceId: 'pi:anthropic', model: 'claude-opus-4-8:low' }
    })
    expect(mms.threads.getThread(thread.id)?.modelOverride).toMatchObject({
      model: 'claude-opus-4-8',
      effort: 'low'
    })
    expect(mms.settings.get().provider).toEqual(before)
    expect(
      await call(api, 'threads.setModel', {
        threadId: thread.id,
        model: { instanceId: 'nope:missing', model: 'x' }
      })
    ).toMatchObject({ ok: false, error: expect.any(String) })
  })

  it('lists queued messages without image data, removes them, and explains a steer with no turn', async () => {
    const { mms, api } = await profile()
    const thread = mms.threads.createThread('Queue')
    const item = mms.orchestrator.enqueueForThread(thread.id, {
      content: 'next',
      mode: 'plan',
      images: [{ name: 'a.png', mimeType: 'image/png', data: 'AAAA' }]
    })
    const listed = (await call(api, 'queue.list', { threadId: thread.id })) as { items: unknown[] }
    expect(listed.items).toEqual([
      expect.objectContaining({
        id: item.id,
        content: 'next',
        mode: 'plan',
        images: [{ name: 'a.png', mimeType: 'image/png' }]
      })
    ])
    expect(JSON.stringify(listed)).not.toContain('AAAA')
    const second = mms.orchestrator.enqueueForThread(thread.id, { content: 'after' })
    const reordered = (await call(api, 'queue.reorder', {
      threadId: thread.id,
      orderedIds: [second.id, item.id]
    })) as { ok: boolean; items: Array<{ id: string }> }
    expect(reordered.ok).toBe(true)
    expect(reordered.items.map((row) => row.id)).toEqual([second.id, item.id])
    await call(api, 'queue.remove', { threadId: thread.id, itemId: second.id })
    expect(
      await call(api, 'queue.promoteToSteer', { threadId: thread.id, itemId: item.id })
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/No active turn/)
    })
    expect(await call(api, 'queue.remove', { threadId: thread.id, itemId: item.id })).toEqual({
      ok: true,
      items: []
    })
    expect(await call(api, 'queue.remove', { threadId: thread.id, itemId: item.id })).toMatchObject(
      { ok: false }
    )
  })
})
