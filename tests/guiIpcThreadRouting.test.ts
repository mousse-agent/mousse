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
