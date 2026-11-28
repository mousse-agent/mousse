/**
 * A bot's browser watched and taken over from another computer (#2030, slice 13), over two real daemons paired through
 * the engine: what the bot's computer ends when the device can no longer reach it. A device whose connection drops
 * loses its hold at once, and a device this computer blocks is Off for the browser, as for every bot stream: its view
 * and its hold end, and it can't watch again.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import { qualifyId } from '../../../src/shared/threadRef'
import { accessPreset } from '../../../src/shared/net/accessPresets'
import type { BotBrowserFrameEvent, BotBrowserView } from '../../../src/shared/bots/personal/browser'
import type { DomainConnectionContext } from '../../../src/mms/protocol/domainRegistry'
import { dispatchMethod } from '../../../src/mms/protocol/handlers'
import { Fabric, type Computer } from './harness'

const VIEW = { open: true, control: 'bot', holder: 'bot', activations: [] } as unknown as BotBrowserView

describe('a bot’s browser of another computer, as that computer loses the device', () => {
  const fabric = new Fabric()
  let owner: Computer
  let viewer: Computer
  let viewerOnOwner: NodeId
  let ownerOnViewer: NodeId
  let keeper: string
  let q: string
  /** What the owner's bots' browsers were asked, by what. */
  const asked: string[] = []
  const emits: Array<(event: BotBrowserFrameEvent) => Promise<void>> = []
  /** What the viewer's window was told. */
  const told: BotBrowserFrameEvent[] = []
  const window: DomainConnectionContext = {
    id: 'window-browser',
    clientType: 'gui',
    capabilities: new Set(),
    binding: { profileId: '', epoch: 1 },
    emitConnectionEvent: async (_type, data) => void told.push(data as BotBrowserFrameEvent)
  }
  const fromWindow = (method: string, params: unknown) =>
    dispatchMethod({ mms: viewer.mms, connection: { ...window, binding: { profileId: viewer.mms.profileId, epoch: 1 } }, globalSequence: () => 0 }, method, params)
  const level = (fields: Record<string, unknown>) => owner.dispatch('bridge.policy', { node: viewerOnOwner, ...fields }, true)
  /** After a change of the viewer's role there, it connects again under the new one, as the app does. */
  const reconnect = () => vi.waitFor(async () => {
    await fabric.connect(viewer, ownerOnViewer)
    await viewer.dispatch('bots.get', { botId: q })
  }, { timeout: 60_000 })
  const ended = () => asked.filter((entry) => entry.startsWith('endHoldsOf'))

  beforeAll(async () => {
    owner = await fabric.computer('owner')
    viewer = await fabric.computer('viewer')
    const paired = await fabric.pair(owner, viewer)
    viewerOnOwner = paired.callerOnOwner
    ownerOnViewer = paired.ownerOnCaller
    await fabric.settle()
    await fabric.connect(viewer, ownerOnViewer)
    vi.spyOn(owner.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    keeper = (await owner.mms.personalBots!.service.create({ look: { colour: 'teal', accessory: 'cap' }, name: 'Browser keeper', description: 'keeper', clientRequestId: 'reach-bot-1' })).bot.id
    owner.mms.botDeviceAccess.set(keeper, { mode: 'chosen', nodes: [viewerOnOwner] })
    q = qualifyId(ownerOnViewer, keeper)
    // The owner's bots' browsers, without a real browser: what they are asked is what is checked.
    const browsers = owner.mms.botBrowsers
    vi.spyOn(browsers, 'view').mockImplementation(async () => VIEW)
    vi.spyOn(browsers, 'watch').mockImplementation(async (_botId, _watchId, input) => {
      asked.push(`watch ${input.connectionId}`)
      emits.push(input.emit)
      return VIEW
    })
    vi.spyOn(browsers, 'unwatch').mockImplementation((_botId, _watchId, connectionId) => void asked.push(`unwatch ${connectionId}`))
    vi.spyOn(browsers, 'hold').mockImplementation(async (_botId, _viewId, request, connectionId) => {
      asked.push(`hold ${request.op} ${connectionId}`)
      return { browser: VIEW, hold: { id: 'hold_1', lastSeq: 0, computer: 'Owner' } }
    })
    vi.spyOn(browsers, 'endHoldsOf').mockImplementation(async (botId, connectionId) => void asked.push(`endHoldsOf ${botId} ${connectionId}`))
    await level({ ...accessPreset('full').fields, bots: 'full' })
    await reconnect()
  }, 300_000)
  afterAll(() => fabric.close(), 60_000)

  it('ends a device’s hold at once when its connection drops', async () => {
    await viewer.dispatch('bots.browser.hold', { botId: q, viewId: 'view_reach_1', request: { op: 'take' } })
    expect(asked).toContain(`hold take remote:${viewerOnOwner}`)
    expect(ended()).toEqual([])
    await fabric.restartHelper(owner)
    await vi.waitFor(() => expect(ended()).toEqual([`endHoldsOf ${keeper} remote:${viewerOnOwner}`]), { timeout: 30_000 })
    // Back for the next check.
    await reconnect()
  }, 120_000)

  it('treats a blocked device as Off: its view and its hold end, and it can’t watch again', async () => {
    asked.length = 0
    await fromWindow('bots.browser.watch', { botId: q, watchId: 'watch_reach_1', width: 480, fps: 5 })
    await vi.waitFor(() => expect(asked.filter((entry) => entry.startsWith('watch'))).toHaveLength(1), { timeout: 10_000 })
    await viewer.dispatch('bots.browser.hold', { botId: q, viewId: 'view_reach_2', request: { op: 'take' } })
    expect(owner.mms.bridge.botViews.viewCount).toBe(1)

    await level({ blocked: true })
    // At once, as the block is saved: not when its connection closes later.
    expect(owner.mms.bridge.botViews.viewCount).toBe(0)
    expect(ended()).toEqual([`endHoldsOf ${keeper} remote:${viewerOnOwner}`])
    expect(asked.filter((entry) => entry.startsWith('unwatch'))).toHaveLength(1)
    // Its window is told the view stopped, and pictures no longer go.
    await vi.waitFor(() => expect(told.some((event) => event.watchId === 'watch_reach_1' && event.stalled)).toBe(true), { timeout: 10_000 })
    const before = asked.filter((entry) => entry.startsWith('watch')).length
    await expect(fromWindow('bots.browser.watch', { botId: q, watchId: 'watch_reach_1', width: 480, fps: 5 })).rejects.toBeDefined()
    expect(asked.filter((entry) => entry.startsWith('watch'))).toHaveLength(before)
    await level({ blocked: false })
  }, 120_000)
})
