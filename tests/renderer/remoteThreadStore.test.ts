import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeDisplayPart } from '../../src/shared/bridge'
import { REMOTE_ATTACHMENT_CHUNK_CHARS } from '../../src/shared/bridge'
import { isId } from '../../src/shared/net'
import { useAppStore } from '../../src/renderer/stores/appStore'
import {
  REMOTE_UNSUPPORTED,
  abortRemoteTurn,
  clearRemoteSelection,
  clearRemoteUnsent,
  closeRemoteThread,
  imageChunks,
  openRemoteThread,
  refreshRemoteQuestions,
  refreshRemoteThread,
  remoteQuestionCount,
  remoteImageProblem,
  remoteSlashCommand,
  remoteThreadKey,
  remoteUnsupported,
  resetRemoteThreads,
  selectRemoteThread,
  setRemoteModel,
  shownRemoteThread,
  submitRemoteMessage,
  useRemoteThreads,
  watchRemoteThread
} from '../../src/renderer/lib/remoteThreadStore'

const node = 'nod_00000000000000000000000001' as const
const stream = 'str_00000000000000000000000001' as const
const ref = { nodeId: node, entityId: 'remote-thread' }
const key = remoteThreadKey(ref)

const message = (id: string, role: string, content: string) => ({ id, role, content, timestamp: '2026-10-27T10:00:00Z' })
const snapshot = (messages = [message('m1', 'user', 'Hello')], active = false): BridgeDisplayPart => ({
  ref, stream, epoch: 1, seq: 1,
  update: { kind: 'snapshot', value: { thread: { id: ref.entityId, name: 'Remote thread' }, messages, queue: [], pendingQuestions: [], activeTurn: { active, running: active } } }
})
const event = (seq: number, type: string, data: unknown): BridgeDisplayPart => ({ ref, stream, epoch: 1, seq, update: { kind: 'event', type, data } })

type Call = { method: string; params: any }
let calls: Call[]
let listeners: Set<(part: BridgeDisplayPart) => void>
let responses: Record<string, (params: any) => unknown>

const publish = (part: BridgeDisplayPart) => { for (const listener of listeners) listener(part) }
const flush = async () => { for (let turn = 0; turn < 12; turn++) await new Promise((resolve) => setTimeout(resolve, 0)) }
const methods = () => calls.map((call) => call.method)
const entry = () => useRemoteThreads.getState().entries[key]!

beforeEach(() => {
  calls = []
  listeners = new Set()
  responses = {}
  ;(globalThis as any).window = {
    mousse: {
      platformRequest: {
        request: async (method: string, params: any) => {
          calls.push({ method, params })
          const respond = responses[method]
          if (respond) return respond(params)
          if (method === 'bridge.hub.composerOptions') return { providers: [{ id: 'codex', instanceId: 'codex', label: 'Codex', models: [{ id: 'gpt', label: 'GPT' }] }], defaultModel: { instanceId: 'codex', llmProvider: 'codex', model: 'gpt' }, skills: [] }
          if (method === 'net.status') return { enabled: false }
          return {}
        }
      },
      bridge: { onThreadPart: (callback: (part: BridgeDisplayPart) => void) => { listeners.add(callback); return () => listeners.delete(callback) } }
    }
  }
  useAppStore.setState({ profileId: 'default', activeThreadId: 'local-thread' })
})

afterEach(async () => {
  await flush()
  resetRemoteThreads()
  await flush()
  delete (globalThis as any).window
})

describe('remote thread lifecycle', () => {
  it('attaches, shows the thread as the active view and replays the display', async () => {
    openRemoteThread({ nodeId: node, entityId: ref.entityId, deviceName: 'Studio Mac', title: 'Fix the build' })
    await flush()
    expect(useRemoteThreads.getState().activeKey).toBe(key)
    expect(entry()).toMatchObject({ deviceName: 'Studio Mac', title: 'Fix the build', live: false })
    expect(calls.filter((call) => call.method === 'bridge.hub.attach')).toEqual([{ method: 'bridge.hub.attach', params: { ref } }])
    expect(listeners.size).toBe(1)

    publish(snapshot())
    await flush()
    expect(entry().live).toBe(true)
    expect(entry().view?.messages.map((row) => row.content)).toEqual(['Hello'])

    publish(event(2, 'thread.message', { threadId: ref.entityId, message: message('m2', 'assistant', 'Working on it') }))
    publish(event(3, 'turn.started', { threadId: ref.entityId }))
    await flush()
    expect(entry().view?.messages.map((row) => row.content)).toEqual(['Hello', 'Working on it'])
    expect(entry().view?.active).toBe(true)
    publish(event(4, 'turn.completed', { threadId: ref.entityId }))
    await flush()
    expect(entry().view?.active).toBe(false)
  })

  it('ignores display parts of other threads and opening twice keeps one attachment', async () => {
    openRemoteThread({ ...ref })
    openRemoteThread({ ...ref, deviceName: 'Studio Mac' })
    await flush()
    expect(methods().filter((method) => method === 'bridge.hub.attach')).toHaveLength(1)
    expect(useRemoteThreads.getState().order).toEqual([key])
    expect(entry().deviceName).toBe('Studio Mac')
    publish({ ...snapshot(), ref: { nodeId: node, entityId: 'other' } })
    await flush()
    expect(entry().view).toBeUndefined()
  })

  it('names the device from the roster when the caller did not', async () => {
    responses['net.status'] = () => ({ enabled: true, self: { node: 'nod_self' }, keystore: 'unlocked' })
    responses['net.transport.list'] = () => ({ manifests: [] })
    responses['bridge.nodes'] = () => ({ nodes: [{ node, name: 'Office PC', self: false, revoked: false, caps: [], state: 'open' }] })
    openRemoteThread({ ...ref })
    await flush()
    expect(entry().deviceName).toBe('Office PC')
  })

  it('detaches once the last view leaves and not before', async () => {
    openRemoteThread({ ...ref })
    await flush()
    const settings = watchRemoteThread(ref, { view: () => {}, error: () => {} })
    await flush()
    closeRemoteThread(key)
    await flush()
    expect(methods()).not.toContain('bridge.hub.detach')
    expect(useRemoteThreads.getState().activeKey).toBeNull()
    expect(useRemoteThreads.getState().order).toEqual([])
    settings()
    await flush()
    expect(calls.filter((call) => call.method === 'bridge.hub.detach')).toEqual([{ method: 'bridge.hub.detach', params: { ref } }])
  })

  it('does not detach under a different profile', async () => {
    openRemoteThread({ ...ref })
    await flush()
    useAppStore.setState({ profileId: 'work' })
    await flush()
    expect(useRemoteThreads.getState().entries).toEqual({})
    expect(methods()).not.toContain('bridge.hub.detach')
  })

  it('shows a failed attach as an error and attaches again on refresh', async () => {
    responses['bridge.hub.attach'] = () => { throw new Error('peer_offline') }
    openRemoteThread({ ...ref })
    await flush()
    expect(entry().error).toBe('peer_offline')
    responses['bridge.hub.attach'] = () => ({})
    refreshRemoteThread(key)
    await flush()
    expect(entry().error).toBe('')
    expect(methods().filter((method) => method === 'bridge.hub.attach')).toHaveLength(2)
  })
})

describe('selection', () => {
  it('leaves the remote view when a local thread is selected, lets go of its display and attaches again when shown', async () => {
    openRemoteThread({ ...ref })
    await flush()
    publish(snapshot())
    await flush()
    useAppStore.setState({ activeThreadId: 'another-local-thread' })
    await flush()
    expect(useRemoteThreads.getState().activeKey).toBeNull()
    // The sidebar keeps the row; the daemon's attachment is released.
    expect(useRemoteThreads.getState().order).toEqual([key])
    expect(calls.filter((call) => call.method === 'bridge.hub.detach')).toEqual([{ method: 'bridge.hub.detach', params: { ref } }])
    expect(entry()).toMatchObject({ live: false, view: undefined })
    selectRemoteThread(key)
    await flush()
    expect(useRemoteThreads.getState().activeKey).toBe(key)
    expect(methods().filter((method) => method === 'bridge.hub.attach')).toHaveLength(2)
    clearRemoteSelection()
    await flush()
    expect(useRemoteThreads.getState().activeKey).toBeNull()
    expect(methods().filter((method) => method === 'bridge.hub.detach')).toHaveLength(2)
  })

  it('opens more threads than the daemon can keep attached, one after another', async () => {
    const daemonLimit = 8
    let attached = 0
    let peak = 0
    responses['bridge.hub.attach'] = () => {
      attached += 1
      peak = Math.max(peak, attached)
      if (attached > daemonLimit) throw new Error('rate_limited')
      return {}
    }
    responses['bridge.hub.detach'] = () => { attached -= 1; return {} }
    for (let index = 0; index < 20; index++) {
      openRemoteThread({ nodeId: node, entityId: `thread-${index}` })
      await flush()
      expect(useRemoteThreads.getState().entries[remoteThreadKey({ nodeId: node, entityId: `thread-${index}` })]!.error).toBe('')
    }
    expect(peak).toBeLessThanOrEqual(2)
    expect(attached).toBe(1)
    // Every thread is still listed in the sidebar.
    expect(useRemoteThreads.getState().order).toHaveLength(20)
  })

  it('keeps the display of a thread that is not shown while a message of this window runs on it', async () => {
    let finish: (value: unknown) => void = () => {}
    responses['bridge.hub.send'] = () => new Promise((resolve) => { finish = resolve })
    openRemoteThread({ ...ref })
    await flush()
    const sending = submitRemoteMessage(key, { content: 'Run the tests' })
    await flush()
    clearRemoteSelection()
    await flush()
    expect(methods()).not.toContain('bridge.hub.detach')
    finish({ text: 'done', silent: false })
    await sending
    await flush()
    expect(calls.filter((call) => call.method === 'bridge.hub.detach')).toHaveLength(1)
  })
})

describe('send, steer, stop', () => {
  it('sends on the target with a request id that Stop and steering name', async () => {
    let finish: (value: unknown) => void = () => {}
    responses['bridge.hub.send'] = () => new Promise((resolve) => { finish = resolve })
    openRemoteThread({ ...ref, deviceName: 'Studio Mac' })
    await flush()
    const sending = submitRemoteMessage(key, { content: 'Run the tests' })
    await flush()
    const send = calls.find((call) => call.method === 'bridge.hub.send')!
    expect(send.params).toMatchObject({ ref, content: 'Run the tests' })
    expect(isId('rpc', send.params.options.id)).toBe(true)
    expect(send.params.options.deadlineMs).toBeGreaterThan(60_000)
    expect(entry()).toMatchObject({ sending: true, run: send.params.options.id })

    await submitRemoteMessage(key, { content: 'Also lint' })
    expect(calls.find((call) => call.method === 'bridge.hub.steer')!.params).toEqual({ ref, run: send.params.options.id, text: 'Also lint' })
    expect(methods().filter((method) => method === 'bridge.hub.send')).toHaveLength(1)

    await abortRemoteTurn(key)
    expect(calls.find((call) => call.method === 'bridge.hub.abort')!.params).toEqual({ ref, run: send.params.options.id })

    finish({ text: 'done', silent: false })
    await sending
    expect(entry()).toMatchObject({ sending: false, run: undefined })
  })

  it('steers a turn the display reports as running, naming the run it was opened with', async () => {
    const run = 'rpc_0000000000000000000000000a' as const
    openRemoteThread({ ...ref, run })
    await flush()
    publish(snapshot([message('m1', 'user', 'Hello')], true))
    await flush()
    expect(entry()).toMatchObject({ sending: true, run })
    await submitRemoteMessage(key, { content: 'Use the staging database' })
    expect(calls.find((call) => call.method === 'bridge.hub.steer')!.params.run).toBe(run)
  })

  it('after a reload, Stop and steering name the send of this thread that the hub is still waiting on', async () => {
    responses['bridge.hub.requests'] = () => [
      { id: 'rpc_0000000000000000000000000b', method: 'orchestrator.send', state: 'unknown', threadId: ref.entityId, running: true, createdAt: 20 },
      { id: 'rpc_0000000000000000000000000c', method: 'threads.create', state: 'completed', createdAt: 30 },
      // Another thread's send, in flight.
      { id: 'rpc_0000000000000000000000000d', method: 'orchestrator.send', state: 'unknown', threadId: 'other-thread', running: true, createdAt: 40 },
      // This thread's sends that a restart interrupted: nobody is waiting on them any more.
      { id: 'rpc_0000000000000000000000000e', method: 'orchestrator.send', state: 'unknown', threadId: ref.entityId, createdAt: 50 },
      { id: 'rpc_0000000000000000000000000f', method: 'orchestrator.send', state: 'unknown', threadId: ref.entityId, createdAt: 60 }
    ]
    openRemoteThread({ ...ref })
    await flush()
    publish(snapshot([message('m1', 'user', 'Hello')], true))
    await flush()
    await abortRemoteTurn(key)
    expect(calls.find((call) => call.method === 'bridge.hub.abort')!.params).toEqual({ ref, run: 'rpc_0000000000000000000000000b' })
    await submitRemoteMessage(key, { content: 'Use the staging database' })
    expect(calls.find((call) => call.method === 'bridge.hub.steer')!.params).toEqual({ ref, run: 'rpc_0000000000000000000000000b', text: 'Use the staging database' })
  })

  it('never names another thread\'s run or an interrupted send when this thread has none', async () => {
    responses['bridge.hub.requests'] = () => [
      { id: 'rpc_0000000000000000000000000d', method: 'orchestrator.send', state: 'unknown', threadId: 'other-thread', running: true, createdAt: 40 },
      { id: 'rpc_0000000000000000000000000e', method: 'orchestrator.send', state: 'unknown', threadId: ref.entityId, createdAt: 50 }
    ]
    responses['bridge.hub.abort'] = () => ({ ok: false })
    openRemoteThread({ ...ref, deviceName: 'Studio Mac' })
    await flush()
    publish(snapshot([message('m1', 'user', 'Hello')], true))
    await flush()
    await abortRemoteTurn(key)
    const named = calls.find((call) => call.method === 'bridge.hub.abort')!.params.run
    expect(['rpc_0000000000000000000000000d', 'rpc_0000000000000000000000000e']).not.toContain(named)
    expect(entry().notice).toContain('cannot be stopped from here')
    await submitRemoteMessage(key, { content: 'Hurry up' })
    expect(methods()).not.toContain('bridge.hub.steer')
    expect(entry().notice).toContain('Studio Mac')
  })

  it('lets the hub wait a day for a send and shows nothing when that wait runs out', async () => {
    responses['bridge.hub.send'] = () => { throw new Error('deadline_exceeded') }
    openRemoteThread({ ...ref })
    await flush()
    await submitRemoteMessage(key, { content: 'A very long task' })
    expect(calls.find((call) => call.method === 'bridge.hub.send')!.params.options.deadlineMs).toBe(24 * 60 * 60_000)
    // The turn may well be running; the display says so, and no error is claimed.
    expect(entry()).toMatchObject({ notice: '', sending: false })
  })

  it('tells the user when a running turn is not theirs to steer', async () => {
    responses['bridge.hub.requests'] = () => []
    openRemoteThread({ ...ref, deviceName: 'Studio Mac' })
    await flush()
    publish(snapshot([message('m1', 'user', 'Hello')], true))
    await flush()
    await submitRemoteMessage(key, { content: 'Hurry up' })
    expect(methods()).not.toContain('bridge.hub.steer')
    expect(entry().notice).toContain('Studio Mac')
  })

  it('stages images in chunks before the send names them', async () => {
    openRemoteThread({ ...ref })
    await flush()
    const data = 'A'.repeat(REMOTE_ATTACHMENT_CHUNK_CHARS + 10)
    await submitRemoteMessage(key, { content: 'Look at this', images: [{ name: 'shot.png', mimeType: 'image/png', data }] })
    const staged = calls.filter((call) => call.method === 'bridge.hub.stageAttachment')
    expect(staged).toHaveLength(2)
    expect(staged.map((call) => [call.params.index, call.params.total, call.params.data.length])).toEqual([[0, 2, REMOTE_ATTACHMENT_CHUNK_CHARS], [1, 2, 10]])
    expect(new Set(staged.map((call) => call.params.upload)).size).toBe(1)
    expect(staged[0]!.params.target).toBe(node)
    const send = calls.find((call) => call.method === 'bridge.hub.send')!
    expect(send.params.attachments).toEqual([staged[0]!.params.upload])
    expect(methods().indexOf('bridge.hub.send')).toBeGreaterThan(methods().lastIndexOf('bridge.hub.stageAttachment'))
  })

  it('does not send when an image is refused and shows why', async () => {
    openRemoteThread({ ...ref })
    await flush()
    await submitRemoteMessage(key, { content: 'x', images: [{ name: 'doc.pdf', mimeType: 'application/pdf', data: 'AAAA' }] })
    expect(methods()).not.toContain('bridge.hub.send')
    expect(entry().notice).toBe('doc.pdf is not a supported image.')
    expect(remoteImageProblem([{ name: 'a.png', mimeType: 'image/png', data: 'AAAA' }])).toBe('')
    expect(imageChunks('')).toEqual([])
  })

  it('stops staging and reports a refusal from the target', async () => {
    responses['bridge.hub.stageAttachment'] = () => ({ ok: false, error: 'Too many images are waiting to be sent.' })
    openRemoteThread({ ...ref })
    await flush()
    await submitRemoteMessage(key, { content: 'x', images: [{ name: 'a.png', mimeType: 'image/png', data: 'AAAA' }] })
    expect(methods()).not.toContain('bridge.hub.send')
    expect(entry()).toMatchObject({ notice: 'Too many images are waiting to be sent.', sending: false })
  })

  it('shows a failed or refused send and frees the composer', async () => {
    responses['bridge.hub.send'] = () => { throw new Error('peer_offline') }
    openRemoteThread({ ...ref })
    await flush()
    await submitRemoteMessage(key, { content: 'x' })
    expect(entry()).toMatchObject({ notice: 'peer_offline', sending: false, run: undefined })
    responses['bridge.hub.send'] = () => ({ text: '', silent: false, error: 'This thread already has a remote-owned run.' })
    await submitRemoteMessage(key, { content: 'y' })
    expect(entry().notice).toBe('This thread already has a remote-owned run.')
  })

  it('reports a stop the target refused', async () => {
    responses['bridge.hub.abort'] = () => ({ ok: false })
    openRemoteThread({ ...ref })
    await flush()
    await abortRemoteTurn(key)
    expect(entry().notice).toContain('cannot be stopped from here')
  })
})

describe('a message that does not go out', () => {
  const image = { name: 'a.png', mimeType: 'image/png', data: 'AAAA' }

  it('reports it and keeps the text and images for the composer to take back', async () => {
    openRemoteThread({ ...ref })
    await flush()
    // An image refused before anything is sent.
    expect(await submitRemoteMessage(key, { content: 'Look', images: [{ name: 'doc.pdf', mimeType: 'application/pdf', data: 'AAAA' }] })).toBe(false)
    expect(entry().unsent).toMatchObject({ content: 'Look', images: [{ name: 'doc.pdf' }] })
    clearRemoteUnsent(key)
    expect(entry().unsent).toBeUndefined()
    // A refusal by the target.
    responses['bridge.hub.send'] = () => ({ text: '', silent: false, error: 'That skill is not available.' })
    expect(await submitRemoteMessage(key, { content: 'Use it', images: [image] })).toBe(false)
    expect(entry()).toMatchObject({ notice: 'That skill is not available.', unsent: { content: 'Use it', images: [image] } })
    // A failed upload and an unreachable computer.
    responses['bridge.hub.send'] = () => { throw new Error('peer_offline') }
    expect(await submitRemoteMessage(key, { content: 'Again' })).toBe(false)
    expect(entry().unsent).toMatchObject({ content: 'Again' })
    responses['bridge.hub.stageAttachment'] = () => ({ ok: false, error: 'Too many images are waiting to be sent.' })
    expect(await submitRemoteMessage(key, { content: 'Pic', images: [image] })).toBe(false)
    expect(entry().unsent).toMatchObject({ content: 'Pic', images: [image] })
  })

  it('keeps nothing back for a message that went out, or whose wait ran out', async () => {
    openRemoteThread({ ...ref })
    await flush()
    expect(await submitRemoteMessage(key, { content: 'Fine' })).toBe(true)
    responses['bridge.hub.send'] = () => { throw new Error('deadline_exceeded') }
    expect(await submitRemoteMessage(key, { content: 'Long task' })).toBe(true)
    expect(entry().unsent).toBeUndefined()
  })

  it('gives a steer back when the turn is not one this window can steer', async () => {
    responses['bridge.hub.requests'] = () => []
    openRemoteThread({ ...ref, deviceName: 'Studio Mac' })
    await flush()
    publish(snapshot([message('m1', 'user', 'Hello')], true))
    await flush()
    expect(await submitRemoteMessage(key, { content: 'Hurry up' })).toBe(false)
    expect(entry().unsent).toMatchObject({ content: 'Hurry up' })
    responses['bridge.hub.requests'] = () => [{ id: 'rpc_0000000000000000000000000b', method: 'orchestrator.send', state: 'unknown', threadId: ref.entityId, running: true, createdAt: 1 }]
    responses['bridge.hub.steer'] = () => ({ ok: false })
    expect(await submitRemoteMessage(key, { content: 'Too late' })).toBe(false)
    responses['bridge.hub.steer'] = () => ({ ok: true })
    expect(await submitRemoteMessage(key, { content: 'In time' })).toBe(true)
  })
})

describe('slash commands and shortcuts', () => {
  it('knows /stop and /steer and leaves every other text a message', () => {
    expect(remoteSlashCommand('/stop')).toEqual({ kind: 'stop' })
    expect(remoteSlashCommand('  /stop now ')).toEqual({ kind: 'stop' })
    expect(remoteSlashCommand('/steer use the staging database')).toEqual({ kind: 'steer', text: 'use the staging database' })
    expect(remoteSlashCommand('/steer')).toEqual({ kind: 'steer', text: '' })
    for (const text of ['stop', '/stopping', '/steering now', '/new', '/usage', 'Hello /stop']) expect(remoteSlashCommand(text)).toBeUndefined()
  })

  it('names the shown remote thread and whether a message of it is running', async () => {
    expect(shownRemoteThread()).toBeNull()
    openRemoteThread({ ...ref })
    await flush()
    expect(shownRemoteThread()).toEqual({ key, running: false })
    publish(snapshot([message('m1', 'user', 'Hello')], true))
    await flush()
    expect(shownRemoteThread()).toEqual({ key, running: true })
    clearRemoteSelection()
    expect(shownRemoteThread()).toBeNull()
  })
})

describe('questions the thread is waiting on', () => {
  it('follow the target while a turn runs, in both directions, and are not asked about an idle thread', async () => {
    let pending: unknown[] = []
    responses['bridge.hub.questions'] = () => ({ pending })
    openRemoteThread({ ...ref })
    await flush()
    publish(snapshot([message('m1', 'user', 'Hello')], false))
    await flush()
    await refreshRemoteQuestions(key)
    expect(methods()).not.toContain('bridge.hub.questions')
    publish(event(2, 'turn.started', { threadId: ref.entityId }))
    await flush()
    pending = [{ requestId: 'q1' }, { requestId: 'q2' }]
    await refreshRemoteQuestions(key)
    expect(calls.find((call) => call.method === 'bridge.hub.questions')!.params).toEqual({ ref })
    expect(remoteQuestionCount(entry())).toBe(2)
    // A later event of the display does not undo what the target answered.
    publish(event(3, 'thread.message', { threadId: ref.entityId, message: message('m2', 'assistant', 'Which one?') }))
    await flush()
    expect(remoteQuestionCount(entry())).toBe(2)
    // The turn ends while the question still shows; it is read until the target says it is gone.
    publish(event(4, 'turn.completed', { threadId: ref.entityId }))
    await flush()
    expect(remoteQuestionCount(entry())).toBe(2)
    pending = []
    await refreshRemoteQuestions(key)
    expect(remoteQuestionCount(entry())).toBe(0)
    await refreshRemoteQuestions(key)
    expect(methods().filter((method) => method === 'bridge.hub.questions')).toHaveLength(2)
  })

  it('keeps the last count when the target cannot be asked', async () => {
    responses['bridge.hub.questions'] = () => { throw new Error('peer_offline') }
    openRemoteThread({ ...ref })
    await flush()
    publish({ ...snapshot([message('m1', 'user', 'Hello')], true) })
    await flush()
    await refreshRemoteQuestions(key)
    expect(remoteQuestionCount(entry())).toBe(0)
  })
})

describe('composer options and model', () => {
  it('loads the target composer options and sets the model on the target', async () => {
    openRemoteThread({ ...ref })
    await flush()
    expect(calls.find((call) => call.method === 'bridge.hub.composerOptions')!.params).toEqual({ target: node, threadId: ref.entityId })
    expect(entry().options?.providers.map((provider) => provider.id)).toEqual(['codex'])
    expect(entry().options?.defaultModel?.model).toBe('gpt')
    await setRemoteModel(key, { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-next' })
    expect(calls.find((call) => call.method === 'bridge.hub.setModel')!.params).toEqual({ ref, model: { instanceId: 'codex', llmProvider: 'codex', model: 'gpt-next' } })
  })

  it('keeps going with an empty picker when the options cannot be read', async () => {
    responses['bridge.hub.composerOptions'] = () => { throw new Error('forbidden') }
    openRemoteThread({ ...ref })
    await flush()
    expect(entry().options).toBeUndefined()
    expect(entry().error).toBe('')
  })
})

describe('unsupported actions', () => {
  it('says the same thing wherever a remote thread cannot do an action, and where to do it', () => {
    expect(REMOTE_UNSUPPORTED).toBe('Not available for threads on another computer')
    for (const action of ['terminal', 'files', 'git', 'panel', 'questions'] as const) {
      expect(remoteUnsupported(action, 'Studio Mac').title).toBe(REMOTE_UNSUPPORTED)
      expect(remoteUnsupported(action, 'Studio Mac').detail).toContain('Studio Mac')
    }
    expect(remoteUnsupported('questions', 'Studio Mac').detail).toBe("Answer the agent's question on Studio Mac.")
    expect(remoteUnsupported('git').detail).toBe('The Git changes of this thread are on the other computer.')
  })
})

describe('sidebar placement', () => {
  it('remembers the local project a thread was opened with', () => {
    openRemoteThread({ ...ref, deviceName: 'Studio', localProjectId: 'project-here' })
    expect(useRemoteThreads.getState().entries[key]?.localProjectId).toBe('project-here')
  })
})
