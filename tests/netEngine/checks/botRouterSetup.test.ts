/**
 * Setting a bot of another computer up from a window (#2030, slice 10), over two real daemons paired through the
 * engine. The viewer's window names the owner's bot by its qualified id; the owner's gate decides.
 *
 * - At Use, every setup row is the owner's refusal (Full bot access needed), and nothing changes there; New bot's
 *   Lives on lists no computer.
 * - At Full, each one runs there: About, Rename, a sentence, Pause and Resume, its model rows, which devices reach it
 *   (the viewer always among them), a new bot made there and deleted.
 * - Full bot access never widens thread access: with a thread ceiling below Full access, Allow everything is refused.
 * - Rows kept to the bot's own computer are refused at once, and nothing is sent.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import { qualifyId } from '../../../src/shared/threadRef'
import { accessPreset } from '../../../src/shared/net/accessPresets'
import { BOT_FULL_TRUST_PERMISSION } from '../../../src/shared/bots/personal/manifest'
import { Fabric, codeOf, type Computer } from './harness'

describe('setting up a bot of another computer from a window', () => {
  const fabric = new Fabric()
  let owner: Computer
  let viewer: Computer
  let viewerOnOwner: NodeId
  let ownerOnViewer: NodeId
  let keeper: string
  let q: string
  const refused = async (call: Promise<unknown>): Promise<{ code?: string; message?: string; details?: any }> => {
    try {
      await call
    } catch (error) {
      const code = (error as { code?: unknown }).code
      return { code: typeof code === 'string' ? code : codeOf(error), message: (error as Error).message, details: (error as { details?: unknown }).details }
    }
    throw new Error('The call was not refused.')
  }
  const sent = (from: number): string[] =>
    fabric.crossed
      .slice(from)
      .filter((row) => row.from === viewer.endpoint && row.label === 'mousse.rpc' && row.header.t === 'call' && String(row.header.method).startsWith('bots.'))
      .map((row) => String(row.header.method))
  const service = () => owner.mms.personalBots!.service
  const LOOK = { colour: 'teal', accessory: 'cap' }
  /** Every setup row, as the window sends it, for the owner's bot `botId` (qualified). */
  const setupCalls = (botId: string): Array<[string, Record<string, unknown>]> => [
    ['bots.update', { botId, name: 'Renamed' }],
    ['bots.update', { botId, description: 'Keeps the servers up.' }],
    ['bots.personal.pause', { botId }],
    ['bots.personal.resume', { botId }],
    ['bots.model.get', { botId }],
    ['bots.model.choices', { node: ownerOnViewer }],
    ['bots.model.setImage', { botId, pick: null }],
    ['bots.model.setSlots', { botId, oneWork: true }],
    ['bots.devices.get', { botId }],
    ['bots.devices.set', { botId, access: { mode: 'this_computer' } }],
    ['bots.create', { node: ownerOnViewer, look: LOOK, description: 'Made from the viewer', clientRequestId: 'setup-use-create' }],
    ['bots.delete', { botId }]
  ]
  /** The viewer's bot level here (its device row's bot switch): the grant stays as it is. */
  const level = async (fields: Record<string, unknown>) => {
    await owner.dispatch('bridge.policy', { node: viewerOnOwner, ...fields }, true)
  }
  /** After a change of the viewer's role there, it connects again under the new one, as the app does. */
  const reconnect = () => vi.waitFor(async () => {
    await fabric.connect(viewer, ownerOnViewer)
    await viewer.dispatch('bots.get', { botId: q })
  }, { timeout: 60_000 })

  beforeAll(async () => {
    owner = await fabric.computer('owner')
    viewer = await fabric.computer('viewer')
    const paired = await fabric.pair(owner, viewer)
    viewerOnOwner = paired.callerOnOwner
    ownerOnViewer = paired.ownerOnCaller
    await fabric.settle()
    vi.spyOn(owner.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    vi.spyOn(viewer.mms.personalBots!, 'enqueueChat').mockResolvedValue(undefined as never)
    keeper = (await service().create({ look: LOOK, name: 'Server keeper', description: 'keeper', clientRequestId: 'setup-bot-1' })).bot.id
    owner.mms.botDeviceAccess.set(keeper, { mode: 'chosen', nodes: [viewerOnOwner] })
    q = qualifyId(ownerOnViewer, keeper)
    // Full control of threads there, with the bot level set on its own below.
    await level({ ...accessPreset('full').fields, bots: 'use' })
    await reconnect()
    await vi.waitFor(() => expect(viewer.mms.bridge.remoteBots.row(ownerOnViewer, keeper)?.offline).toBeUndefined(), { timeout: 30_000 })
  }, 300_000)
  afterAll(() => fabric.close(), 60_000)

  it('at Use, every setup row is the owner’s refusal and nothing changes there; Lives on lists no computer', async () => {
    const before = { summary: service().get(keeper).summary, access: owner.mms.botDeviceAccess.get(keeper).access, bots: service().list().bots.length }
    for (const [method, params] of setupCalls(q)) {
      const no = await refused(viewer.dispatch(method, params))
      expect(no, method).toMatchObject({ code: 'computer_forbidden', details: { reason: 'bots_full_needed', node: ownerOnViewer } })
    }
    expect(service().get(keeper).summary).toMatchObject({ name: before.summary.name, description: before.summary.description })
    expect(service().get(keeper).summary.paused).toBeFalsy()
    expect(owner.mms.botDeviceAccess.get(keeper).access).toEqual(before.access)
    expect(service().list().bots).toHaveLength(before.bots)
    // Allow everything is a setup row too.
    expect(await refused(viewer.dispatch('bots.permissions.set', { botId: q, permissionId: BOT_FULL_TRUST_PERMISSION, enabled: true })))
      .toMatchObject({ details: { reason: 'bots_full_needed' } })
    const listed = await viewer.dispatch('bots.remote.list', {})
    expect(listed.computers).toEqual([])
    expect(listed.bots.find((bot: { id: string }) => bot.id === q)?.lives.level).toBeUndefined()
  }, 120_000)

  it('at Full, each setup row runs on the bot’s computer, the viewer always reaches it, and a bot made there is deleted from here', async () => {
    await level({ bots: 'full' })
    // The viewer learns its level there in the background, and Lives on offers that computer.
    await vi.waitFor(async () => expect((await viewer.dispatch('bots.remote.list', {})).computers).toEqual([{ node: ownerOnViewer, name: expect.any(String) }]), { timeout: 30_000 })
    const listed = await viewer.dispatch('bots.remote.list', {})
    expect(listed.bots.find((bot: { id: string }) => bot.id === q)?.lives.level).toBe('full')

    expect((await viewer.dispatch('bots.update', { botId: q, name: 'Renamed' })).bot).toMatchObject({ id: q, name: 'Renamed' })
    expect(service().get(keeper).summary.name).toBe('Renamed')
    await viewer.dispatch('bots.update', { botId: q, description: 'Keeps the servers up.' })
    expect(service().get(keeper).summary.description).toBe('Keeps the servers up.')
    await viewer.dispatch('bots.update', { botId: q, look: { colour: 'purple', accessory: 'crown' } })
    expect(service().get(keeper).summary.look).toMatchObject({ colour: 'purple', accessory: 'crown' })
    await viewer.dispatch('bots.personal.pause', { botId: q })
    expect(service().get(keeper).summary.state).toBe('paused')
    await viewer.dispatch('bots.personal.resume', { botId: q })
    expect(service().get(keeper).summary.state).not.toBe('paused')

    // Its model rows, with the choices of its own computer only.
    expect(await viewer.dispatch('bots.model.get', { botId: q })).toBeDefined()
    const choices = await viewer.dispatch('bots.model.choices', { node: ownerOnViewer })
    expect(choices.computers.map((computer: { id: string }) => computer.id)).toEqual(['this_computer'])
    expect(await viewer.dispatch('bots.model.setImage', { botId: q, pick: null })).toMatchObject({ bot: { id: q } })

    // Which devices reach it: the viewer is marked as the device in hand, and is never left out.
    // The owner opened no connection to the viewer here: the viewer, which is calling, is listed all the same.
    const devices = await viewer.dispatch('bots.devices.get', { botId: q })
    expect(devices.access).toEqual({ mode: 'chosen', nodes: [viewerOnOwner] })
    expect(devices.devices.find((device: { node: string }) => device.node === viewerOnOwner)).toMatchObject({ caller: true })
    const set = await viewer.dispatch('bots.devices.set', { botId: q, access: { mode: 'this_computer' } })
    expect(set.access).toEqual({ mode: 'chosen', nodes: [viewerOnOwner] })
    expect(owner.mms.botDeviceAccess.get(keeper).access).toEqual({ mode: 'chosen', nodes: [viewerOnOwner] })

    // A new bot made there from here: it lives there, the viewer reaches it, and it is deleted from here.
    const made = await viewer.dispatch('bots.create', { node: ownerOnViewer, look: LOOK, description: 'Made from the viewer', clientRequestId: 'setup-full-create' })
    const madeId = String(made.bot.id)
    expect(madeId.startsWith(`${ownerOnViewer}:`)).toBe(true)
    const local = madeId.slice(ownerOnViewer.length + 1)
    expect(service().get(local).summary.description).toBe('Made from the viewer')
    expect(owner.mms.botDeviceAccess.get(local).access).toEqual({ mode: 'chosen', nodes: [viewerOnOwner] })
    expect(viewer.mms.personalBots!.service.list().bots.some((bot) => bot.description === 'Made from the viewer')).toBe(false)
    await viewer.dispatch('bots.delete', { botId: madeId })
    expect(() => service().get(local)).toThrow()
  }, 180_000)

  it('Full bot access with a thread ceiling below Full access sets the bot up, but cannot turn on Allow everything', async () => {
    await level({ ...accessPreset('work').fields, bots: 'full' })
    await reconnect()
    expect((await viewer.dispatch('bots.update', { botId: q, name: 'Ceiling' })).bot.name).toBe('Ceiling')
    const no = await refused(viewer.dispatch('bots.permissions.set', { botId: q, permissionId: BOT_FULL_TRUST_PERMISSION, enabled: true }))
    // Refused by the owner's gate, not for the bot level (which is Full).
    expect(no).toMatchObject({ code: 'computer_forbidden' })
    expect(no.details?.reason).not.toMatch(/^bots_/)
    expect(service().get(keeper).fullTrust).not.toBe(true)
    // With Full access it may.
    await level({ ...accessPreset('full').fields })
    await reconnect()
    await viewer.dispatch('bots.permissions.set', { botId: q, permissionId: BOT_FULL_TRUST_PERMISSION, enabled: true })
    expect(service().get(keeper).fullTrust).toBe(true)
    await viewer.dispatch('bots.permissions.set', { botId: q, permissionId: BOT_FULL_TRUST_PERMISSION, enabled: false })
  }, 120_000)

  it('at Full, a row kept to the bot’s own computer is still refused at once, and nothing is sent', async () => {
    const from = fabric.crossed.length
    for (const [method, params] of [
      ['bots.memory.export', { botId: q, dir: viewer.home }],
      ['bots.facePicture.save', { botId: q, key: 'k', png: 'aGk=' }],
      ['bots.browser.window', { botId: q, viewId: 'v', holdId: 'h', op: 'open' }],
      ['bots.browser.files', { botId: q, viewId: 'v', holdId: 'h', paths: [] }],
      ['bots.model.set', { botId: q, model: null }],
      ['bots.schedules.add', { botId: q, schedule: {} }]
    ] as const) {
      const no = await refused(viewer.dispatch(method, params))
      expect(no.code, method).toBe('not_available_remotely')
    }
    expect(sent(from)).toEqual([])
  }, 60_000)
})
