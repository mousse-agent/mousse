/**
 * The setup card through the real service and protocol: a request opens a card and every window of this computer is
 * told the thread (only its id travels), a window reads the card and answers Not now through `computerUse.setupRequest.*`,
 * and changing computer use in Settings lets the thread's agents ask again.
 */
import { join } from 'node:path'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { ComputerUseDriver } from '../src/mms/computerUse/ComputerUseDriver'
import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import { LocalMmsClient } from '../src/mms/protocol/client'
import { bridgeProtocolEvent } from '../src/main/mms/protocolEventBridge'
import { parseComputerUseOutcome, type ComputerUseSetupRequestView } from '../src/shared/computerUse'

type Event = { type: string; data?: unknown; threadId?: string }

let home: string
let mms: MousseMainService
let server: MmsProtocolServer
let window: LocalMmsClient
let seen: Event[]

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-cu-setup-')))
  process.env.MOUSSE_HOME = home
  mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await mms.start()
  const ownerToken = mms.getOwnerLease()!.owner.token
  server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
  const endpoint = await server.start()
  seen = []
  window = new LocalMmsClient({ homeDir: home, endpoint, ownerToken, clientType: 'gui' })
  window.onEvent((event) => seen.push(event as Event))
  await window.connect()
  await window.subscribe()
}, 60_000)

afterEach(async () => {
  await window?.close()
  await server?.stop()
  await mms?.stop()
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    // Windows can hold a database open a moment after stop.
  }
})

const waitFor = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20))
  if (!check()) throw new Error(`no ${what}`)
}

it('opens a card, tells the windows its thread, answers Not now from a window, and settings let agents ask again', async () => {
  const { orchestrator } = await mms.getProfileServices(mms.profileId)
  // Cua Driver not installed here; nothing is run.
  ;(orchestrator as unknown as { computerDriver: ComputerUseDriver }).computerDriver = new ComputerUseDriver({
    settings: () => ({ enabled: true }), platform: 'linux', env: { PATH: '' }, home: join(home, 'user'),
    version: async () => 'cua-driver 0.38.0', telemetryOff: async () => undefined, exists: () => false
  })
  const thread = mms.threads.createThread('Design', undefined, undefined, { started: true })
  const setup = orchestrator.computerUseSetup()

  const asked = await setup.request({ threadId: thread.id, reason: 'Open Figma' })
  expect(parseComputerUseOutcome(asked.text)?.outcome).toBe('setup_needed')
  await waitFor(() => seen.some((event) => event.type === 'computerUse.setupRequest.changed'), 'event')
  const event = seen.find((entry) => entry.type === 'computerUse.setupRequest.changed')!
  expect(event.data).toEqual({ threadId: thread.id })
  // The main process passes it on to the windows under its own channel.
  const sent: Array<[string, unknown]> = []
  expect(bridgeProtocolEvent(event as never, ((channel: string, payload: unknown) => sent.push([channel, payload])) as never, { getActiveThreadId: () => null } as never)).toBe(true)
  expect(sent).toEqual([['computerUse:setupRequestChanged', { threadId: thread.id }]])

  const { request } = await window.request<{ request: ComputerUseSetupRequestView | null }>('computerUse.setupRequest.get', { threadId: thread.id })
  expect(request).toMatchObject({ threadId: thread.id, reason: 'Open Figma' })
  expect(await window.request('computerUse.setupRequest.dismiss', { threadId: thread.id, requestId: request!.requestId })).toEqual({ dismissed: true })
  expect(parseComputerUseOutcome((await setup.request({ threadId: thread.id, reason: 'again' })).text)?.outcome).toBe('declined')

  await window.request('settings.set', { partial: { agentAccess: { computerUse: false } } })
  expect(setup.isDeclined(thread.id)).toBe(false)
}, 60_000)
