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
import { STAGED_UPLOAD_TTL_MS } from '../../../../src/mms/bridge/remote/RemoteApi'
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
      run: async (_threadId, content, _control, extras) => {
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
      run: async () =>
        refuse
          ? { text: '', silent: false, error: 'Thread already has a running turn' }
          : { text: 'ok', silent: false }
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
      run: () => new Promise((resolve) => (release = () => resolve({ text: 'ok', silent: false })))
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
        run: async (...args) => {
          runs.push(args)
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

  it('sets one thread model without changing the computer default', async () => {
    const { mms, api } = await profile()
    const thread = mms.threads.createThread('Model')
    const before = mms.settings.get().provider
    const result = await call(api, 'threads.setModel', {
      threadId: thread.id,
      model: { instanceId: 'pi:anthropic', model: 'claude-opus-4-8:high' }
    })
    expect(result).toMatchObject({
      ok: true,
      modelOverride: { instanceId: 'pi:anthropic', model: 'claude-opus-4-8:high' }
    })
    expect(mms.threads.getThread(thread.id)?.modelOverride).toMatchObject({
      model: 'claude-opus-4-8:high'
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
