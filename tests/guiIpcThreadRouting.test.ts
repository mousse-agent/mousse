import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {},
  app: { getPath: () => '', getVersion: () => '0.0.0', on: () => undefined },
  shell: {},
  dialog: {},
  clipboard: {},
  nativeTheme: { on: () => undefined },
  session: {},
  webContents: {}
}))

import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
import { isQualifiedId, qualifyId } from '../src/shared/threadRef'

const NODE = 'nod_0123456789abcdefghjkmnpqrs'
const REMOTE = qualifyId(NODE, 'thread-1')
const OTHER_REMOTE = qualifyId(NODE, 'thread-2')

const calls: Array<{ method: string; params: unknown }> = []
const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
  calls.push({ method, params })
  if (method === 'orchestrator.answerQuestions' || method === 'orchestrator.dismissQuestions') return { ok: true }
  if (method === 'pty.isAlive') return { alive: true }
  if (method === 'git.cancelOperation') return { cancelled: true }
  return {}
})
const snapshotThread = vi.fn(async (threadId: string) => {
  calls.push({ method: 'snapshot', params: { threadId } })
  return { messages: [], queue: [], claimed: [], activeTurn: { active: false, running: false }, connectionFailed: false }
})
const presentation = new PresentationState()
/** Services the handlers under test do not use: every method does nothing. */
const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })
const guiMms = {
  request,
  snapshotThread,
  runWithSender: (_sender: unknown, run: () => unknown) => run(),
  getCurrentSenderId: () => null,
  getWindowBindingForSender: () => undefined,
  getBaseBinding: () => undefined
}

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return Promise.resolve(handler({ sender: { id: 1 } }, ...args))
}
const sent = (method: string) => calls.filter((call) => call.method === method)

beforeAll(() => {
  expect(isQualifiedId(REMOTE)).toBe(true)
  registerGuiIpc({ guiMms: inert(guiMms), presentation, settings: inert(), browserView: inert(), repoRoot: '' } as unknown as GuiIpcServices, () => null)
})
beforeEach(() => { calls.length = 0; presentation.setActiveThreadId(null) })
afterEach(() => { vi.restoreAllMocks() })

describe('calls about a request name the thread for the router', () => {
  it('forwards the thread id given by the window', async () => {
    await invoke('orchestrator:answerQuestions', 'req-1', { a: 'yes' }, REMOTE)
    await invoke('orchestrator:answerQuestionsDetailed', 'req-2', { a: 'no' }, REMOTE)
    await invoke('orchestrator:dismissQuestions', 'req-3', REMOTE)
    await invoke('git:cancelOperation', 'op-1', REMOTE)
    await invoke('pty:isAlive', 'pty-1', REMOTE)
    await invoke('pty:lookup', 'pty-2', REMOTE)
    expect(calls).toEqual([
      { method: 'orchestrator.answerQuestions', params: { requestId: 'req-1', answers: { a: 'yes' }, threadId: REMOTE } },
      { method: 'orchestrator.answerQuestions', params: { requestId: 'req-2', answers: { a: 'no' }, threadId: REMOTE } },
      { method: 'orchestrator.dismissQuestions', params: { requestId: 'req-3', threadId: REMOTE } },
      { method: 'git.cancelOperation', params: { operationId: 'op-1', threadId: REMOTE } },
      { method: 'pty.isAlive', params: { ptyId: 'pty-1', threadId: REMOTE } },
      { method: 'pty.lookup', params: { ptyId: 'pty-2', threadId: REMOTE } }
    ])
  })

  it('leaves the key out when no thread, or an empty one, is given', async () => {
    await invoke('orchestrator:answerQuestions', 'req-1', { a: 'yes' })
    await invoke('orchestrator:dismissQuestions', 'req-3', '')
    await invoke('git:cancelOperation', 'op-1')
    await invoke('pty:isAlive', 'pty-1')
    await invoke('pty:lookup', 'pty-2', undefined)
    for (const call of calls) expect(Object.keys(call.params as object)).not.toContain('threadId')
    expect(calls.map((call) => call.method)).toEqual(['orchestrator.answerQuestions', 'orchestrator.dismissQuestions', 'git.cancelOperation', 'pty.isAlive', 'pty.lookup'])
  })

  it("names the project when a Git action of a project's folder is cancelled, and only when one is given", async () => {
    const project = qualifyId(NODE, 'project-1')
    await invoke('git:cancelOperation', 'op-1', undefined, project)
    await invoke('git:cancelOperation', 'op-2', undefined, '')
    await invoke('git:cancelOperation', 'op-3')
    expect(calls).toEqual([
      { method: 'git.cancelOperation', params: { operationId: 'op-1', projectId: project } },
      { method: 'git.cancelOperation', params: { operationId: 'op-2' } },
      { method: 'git.cancelOperation', params: { operationId: 'op-3' } }
    ])
  })
})

describe('a terminal on another computer', () => {
  it('names the thread for typing, resizing and stopping, and leaves it out for a local terminal', async () => {
    await invoke('pty:write', 'pty-1', 'ls\r', REMOTE)
    await invoke('pty:resize', 'pty-1', 100, 30, REMOTE)
    await invoke('pty:kill', 'pty-1', REMOTE)
    await invoke('pty:write', 'pty-2', 'x')
    await invoke('pty:resize', 'pty-2', 80, 24)
    await invoke('pty:kill', 'pty-2', '')
    expect(calls).toEqual([
      { method: 'pty.write', params: { ptyId: 'pty-1', data: 'ls\r', threadId: REMOTE } },
      { method: 'pty.resize', params: { ptyId: 'pty-1', cols: 100, rows: 30, threadId: REMOTE } },
      { method: 'pty.kill', params: { ptyId: 'pty-1', threadId: REMOTE } },
      { method: 'pty.write', params: { ptyId: 'pty-2', data: 'x' } },
      { method: 'pty.resize', params: { ptyId: 'pty-2', cols: 80, rows: 24 } },
      { method: 'pty.kill', params: { ptyId: 'pty-2' } }
    ])
  })

  it('opens it with a thread and a project shell only: no folder, shell, arguments or environment of this computer', async () => {
    presentation.setActiveThreadId(REMOTE)
    const request = { agentId: '__project-shell__:tab', cwd: 'C:\\here', command: 'x', env: { A: 'b' }, shellArgs: ['-c'] }
    await invoke('pty:create', request)
    expect(sent('pty.create')[0].params).toEqual({ threadId: REMOTE, agentId: '__project-shell__:tab' })
    // A terminal of this computer is opened as it always was.
    calls.length = 0
    presentation.setActiveThreadId('local-thread')
    await invoke('pty:create', request)
    expect(sent('pty.create')[0].params).toEqual({ threadId: 'local-thread', ...request })
  })
})

describe('selecting a thread on another computer', () => {
  it('holds it open before reading it, and lets go of it when the selection moves on', async () => {
    await invoke('threads:select', REMOTE)
    expect(calls.map((call) => call.method)).toEqual(['threads.focus', 'snapshot'])
    expect(calls[0].params).toEqual({ threadId: REMOTE, focused: true })
    calls.length = 0
    await invoke('threads:select', OTHER_REMOTE)
    expect(sent('threads.focus').map((call) => call.params)).toEqual([
      { threadId: REMOTE, focused: false },
      { threadId: OTHER_REMOTE, focused: true }
    ])
    calls.length = 0
    await invoke('threads:select', 'local-thread')
    expect(calls.map((call) => call.params)).toEqual([{ threadId: OTHER_REMOTE, focused: false }, { threadId: 'local-thread' }])
  })

  it('asks nothing extra for a thread of this computer', async () => {
    await invoke('threads:select', 'local-a')
    await invoke('threads:select', 'local-b')
    expect(sent('threads.focus')).toEqual([])
    expect(calls.map((call) => call.method)).toEqual(['snapshot', 'snapshot'])
  })

  it('still shows the thread when the hold fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    request.mockImplementationOnce(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      throw Object.assign(new Error('secret detail'), { code: 'node_unreachable' })
    })
    await invoke('threads:select', REMOTE)
    expect(sent('snapshot')).toEqual([{ method: 'snapshot', params: { threadId: REMOTE } }])
    expect(warn).toHaveBeenCalledWith('threads.focus failed:', 'node_unreachable')
  })
})

describe('a chat is created on another computer', () => {
  it('names the computer for the daemon, and only when one is picked', async () => {
    const project = qualifyId(NODE, 'project-1')
    await invoke('threads:create', 'Fix it', project, { worktreeEnabled: true, node: NODE })
    await invoke('threads:create', 'Fix it', undefined, { worktreeEnabled: false })
    await invoke('threads:create', undefined, undefined, { node: '' })
    expect(sent('threads.create').map((call) => call.params)).toEqual([
      { name: 'Fix it', projectId: project, worktreeEnabled: true, node: NODE },
      { name: 'Fix it', projectId: undefined, worktreeEnabled: false },
      { name: 'New Chat', projectId: undefined, worktreeEnabled: false }
    ])
  })
})

describe('a long thread of another computer', () => {
  it('reads a page of older messages and a missing image, naming the thread for the router', async () => {
    await invoke('threads:loadEarlier', REMOTE, 'message-9')
    await invoke('threads:messageImage', REMOTE, 'message-3', 1)
    expect(calls).toEqual([
      { method: 'thread.messages', params: { before: 'message-9', threadId: REMOTE } },
      { method: 'thread.messageImage', params: { messageId: 'message-3', index: 1, threadId: REMOTE } }
    ])
  })

  it('hands the window the part that was left out of the first view', async () => {
    const broadcasts: Array<{ channel: string; data: unknown }> = []
    const { broadcastThreadSnapshot } = await import('../src/main/mms/protocolEventBridge')
    presentation.setActiveThreadId(REMOTE)
    broadcastThreadSnapshot(
      REMOTE,
      { messages: [], queue: [], earlier: { before: 'message-9', count: 40 } },
      (channel, data) => { broadcasts.push({ channel, data }) },
      presentation
    )
    expect(broadcasts.find((entry) => entry.channel === 'thread:view')?.data).toMatchObject({ threadId: REMOTE, earlier: { before: 'message-9', count: 40 } })
    broadcasts.length = 0
    broadcastThreadSnapshot(REMOTE, { messages: [], queue: [] }, (channel, data) => { broadcasts.push({ channel, data }) }, presentation)
    expect(Object.keys(broadcasts.find((entry) => entry.channel === 'thread:view')!.data as object)).not.toContain('earlier')
  })
})

describe('a call to another computer that was not confirmed', () => {
  const uncertain = (method: string) =>
    Object.assign(new Error('Studio did not confirm this. It may have happened; check before trying again.'), {
      code: 'outcome_uncertain',
      details: { node: NODE, name: 'Studio', method }
    })

  it('still tells the window, and reads the thread in view again', async () => {
    presentation.setActiveThreadId(REMOTE)
    request.mockImplementationOnce(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      throw uncertain(method)
    })
    await expect(invoke('threads:rename', REMOTE, 'New name')).rejects.toMatchObject({ code: 'outcome_uncertain' })
    await vi.waitFor(() => expect(sent('threads.list')).toHaveLength(1))
    // The thread is held and read afresh, as when it is opened.
    expect(sent('threads.focus').map((call) => call.params)).toContainEqual({ threadId: REMOTE, focused: true })
    expect(sent('snapshot')).toEqual([{ method: 'snapshot', params: { threadId: REMOTE } }])
  })

  it('leaves a thread of another computer, or of this one, that is not in view alone', async () => {
    presentation.setActiveThreadId('local-thread')
    request.mockImplementationOnce(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      throw uncertain(method)
    })
    await expect(invoke('threads:rename', OTHER_REMOTE, 'New name')).rejects.toMatchObject({ code: 'outcome_uncertain' })
    await new Promise((done) => setTimeout(done, 20))
    expect(calls.map((call) => call.method)).toEqual(['threads.rename'])
  })

  it('does not read anything again for a refusal, which is a decided answer', async () => {
    presentation.setActiveThreadId(REMOTE)
    request.mockImplementationOnce(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      throw Object.assign(new Error('Studio is offline.'), { code: 'computer_offline', details: { node: NODE, name: 'Studio' } })
    })
    await expect(invoke('threads:rename', REMOTE, 'New name')).rejects.toMatchObject({ code: 'computer_offline' })
    await new Promise((done) => setTimeout(done, 20))
    expect(calls.map((call) => call.method)).toEqual(['threads.rename'])
  })
})
