/**
 * A window that missed events reads its open thread again (`resnapshotWindow` in registerGuiIpc). The turn state
 * it is sent must be a whole TurnState, the service's own: `{ threadId, state: 'processing' }` had no phase, read as
 * no turn, and the transcript dropped Working while the turn still ran.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
const sentToWindow = vi.hoisted(() => [] as Array<{ channel: string; data: unknown }>)
const windows = vi.hoisted(() => [
  { isDestroyed: () => false, webContents: { id: 7, send: (channel: string, data: unknown) => void sentToWindow.push({ channel, data }) } }
])

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => windows },
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
import { isTurnActivePhase, type TurnState } from '../src/shared/types'

const listeners = new Map<string, Array<(payload: unknown) => void>>()
const running = { active: true, running: true }
const serviceState: TurnState = { threadId: 't1', turnId: 'run:1', phase: 'thinking', step: { kind: 'reasoning' }, updatedAt: '2026-11-11T10:00:00.000Z' }
let snapshotTurnState: TurnState | undefined = serviceState

const guiMms = {
  on: (event: string, listener: (payload: unknown) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener])
  },
  request: vi.fn(async () => ({})),
  snapshotThread: vi.fn(async () => ({ messages: [], queue: [], claimed: [], activeTurn: running, connectionFailed: false })),
  snapshotThreadForSender: vi.fn(async () => ({
    messages: [], queue: [], claimed: [], activeTurn: running, connectionFailed: false,
    ...(snapshotTurnState ? { turnState: snapshotTurnState } : {})
  })),
  activityForSender: vi.fn(async () => ({})),
  runWithSender: (_sender: unknown, run: () => unknown) => run(),
  getCurrentSenderId: () => 7,
  getWindowBindingForSender: () => ({ profileId: 'profile-1' }),
  getBaseBinding: () => undefined
}
const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })

const turnStatesSent = () => sentToWindow.filter((sent) => sent.channel === 'orchestrator:turn-state').map((sent) => sent.data as TurnState)

async function resnapshot(): Promise<TurnState | undefined> {
  sentToWindow.length = 0
  for (const listener of listeners.get('window-resnapshot') ?? []) listener({ senderId: 7 })
  await vi.waitFor(() => expect(turnStatesSent().length).toBeGreaterThan(0))
  return turnStatesSent().at(-1)
}

beforeAll(async () => {
  registerGuiIpc({ guiMms: inert(guiMms), presentation: new PresentationState(), settings: inert(), browserView: inert(), repoRoot: '' } as unknown as GuiIpcServices, () => null)
  // The window shows thread t1.
  await handlers.get('threads:select')!({ sender: { id: 7 } }, 't1')
})

describe('a window that read its thread again after missing events', () => {
  it("is sent the service's own turn state, phase and step", async () => {
    const state = await resnapshot()
    expect(state).toEqual(serviceState)
    expect(state).not.toHaveProperty('state')
  })

  it('without one from the service, still gets a running phase for a running turn, never a bare activity', async () => {
    snapshotTurnState = undefined
    const state = await resnapshot()
    expect(state).toMatchObject({ threadId: 't1' })
    expect(isTurnActivePhase(state!.phase)).toBe(true)
    expect(state).not.toHaveProperty('state')
    snapshotTurnState = serviceState
  })
})
