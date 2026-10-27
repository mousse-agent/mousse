import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeDisplayPart } from '../../src/shared/bridge'
import { REMOTE_ATTACHMENT_CHUNK_CHARS } from '../../src/shared/bridge'
import { isId } from '../../src/shared/net'
import { useAppStore } from '../../src/renderer/stores/appStore'
import {
  REMOTE_UNSUPPORTED,
  abortRemoteTurn,
  clearRemoteSelection,
  closeRemoteThread,
  imageChunks,
  openRemoteThread,
  refreshRemoteThread,
  remoteImageProblem,
  remoteThreadKey,
  remoteUnsupported,
  resetRemoteThreads,
  selectRemoteThread,
  setRemoteModel,
  sidebarRemoteThreads,
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
  it('leaves the remote view when a local thread is selected but keeps it attached', async () => {
    openRemoteThread({ ...ref })
    await flush()
    useAppStore.setState({ activeThreadId: 'another-local-thread' })
    expect(useRemoteThreads.getState().activeKey).toBeNull()
    expect(useRemoteThreads.getState().order).toEqual([key])
    expect(methods()).not.toContain('bridge.hub.detach')
    selectRemoteThread(key)
    expect(useRemoteThreads.getState().activeKey).toBe(key)
    clearRemoteSelection()
    expect(useRemoteThreads.getState().activeKey).toBeNull()
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

  it('finds the one running send when the thread was started elsewhere in this window', async () => {
    responses['bridge.hub.requests'] = () => [
      { id: 'rpc_0000000000000000000000000b', method: 'orchestrator.send', state: 'unknown' },
      { id: 'rpc_0000000000000000000000000c', method: 'threads.create', state: 'completed' }
    ]
    openRemoteThread({ ...ref })
    await flush()
    publish(snapshot([message('m1', 'user', 'Hello')], true))
    await flush()
    await abortRemoteTurn(key)
    expect(calls.find((call) => call.method === 'bridge.hub.abort')!.params.run).toBe('rpc_0000000000000000000000000b')
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
  const entry = (entityId: string, localProjectId?: string) => ({
    key: remoteThreadKey({ nodeId: node, entityId }),
    ref: { nodeId: node, entityId },
    ...(localProjectId ? { localProjectId } : {}),
    live: false, error: '', sending: false, notice: '', attachment: 0
  })

  it('lists the newest attachment first, under the local project it was started from, else with the project-less chats', () => {
    const a = entry('a', 'project-here'), b = entry('b'), c = entry('c', 'project-gone')
    const entries = { [a.key]: a, [b.key]: b, [c.key]: c }
    const placed = sidebarRemoteThreads(entries, [a.key, b.key, c.key, 'nod_missing:x'], new Set(['project-here']))
    expect(placed.all.map((row) => row.ref.entityId)).toEqual(['c', 'b', 'a'])
    expect([...placed.byProject.entries()].map(([project, rows]) => [project, rows.map((row) => row.ref.entityId)]))
      .toEqual([['project-here', ['a']]])
    // A project removed from this computer no longer holds its remote threads.
    expect(placed.unfiled.map((row) => row.ref.entityId)).toEqual(['c', 'b'])
  })

  it('remembers the local project a thread was opened with', () => {
    openRemoteThread({ ...ref, deviceName: 'Studio', localProjectId: 'project-here' })
    expect(useRemoteThreads.getState().entries[key]?.localProjectId).toBe('project-here')
  })
})
