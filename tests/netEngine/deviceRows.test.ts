/**
 * What a paired computer's row in Settings → Devices says (design §5.2), read through `netEngine.status` as the
 * window reads it: one direction down for `rowStuckMs` names that direction, a pairing that has not finished by
 * then offers Retry, and Add address saves a local network address with the helper. Fake helpers only.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { engineLimits } from '../../src/mms/netEngine/limits'
import { dispatchMethod } from '../../src/mms/protocol/handlers'
import { NET_LOCAL_CAPABILITY } from '../../src/shared/net/local'
import type { NetEngineDevice, NetEngineStatus } from '../../src/shared/netEngine/local'
import { eventually, Fabric, REAL_HELPER, type Computer } from './checks/harness'

const describeFake = REAL_HELPER ? describe.skip : describe

describeFake('engine device rows', () => {
  const fabric = new Fabric()
  afterAll(() => fabric.close(), 120_000)
  afterEach(() => vi.restoreAllMocks())

  const status = async (on: Computer): Promise<NetEngineStatus> =>
    on.dispatch('netEngine.status', {}, true)
  const device = async (on: Computer, node: string): Promise<NetEngineDevice> =>
    (await status(on)).devices.find((item) => item.node === node)!
  /** The clock moves on by `ms` for what reads the rows from here. */
  const later = (ms: number) => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => now + ms)
  }

  it('names the direction that is down once it has been down for the bound, and clears when it is back', async () => {
    const owner = await fabric.computer('rows-owner'),
      caller = await fabric.computer('rows-caller')
    const { callerOnOwner, ownerOnCaller } = await fabric.pair(owner, caller)
    expect(await device(owner, callerOnOwner)).toMatchObject({ state: 'connected' })

    // The owner's own connection to the caller is lost; the caller's to the owner stays.
    fabric.network.cutFrom(owner.endpoint, caller.endpoint)
    await eventually(async () => expect((await device(owner, callerOnOwner)).online).toBe(false))
    expect((await device(owner, callerOnOwner)).unreachable).toBeUndefined()

    later(engineLimits().rowStuckMs + 1)
    expect((await device(owner, callerOnOwner)).unreachable).toBe('out')
    expect((await device(caller, ownerOnCaller)).unreachable).toBe('in')
    vi.restoreAllMocks()

    await owner.mms.netEngine.dial(callerOnOwner)
    await eventually(async () => expect((await device(owner, callerOnOwner)).online).toBe(true))
    later(engineLimits().rowStuckMs + 1)
    expect((await device(owner, callerOnOwner)).unreachable).toBeUndefined()
    expect((await device(caller, ownerOnCaller)).unreachable).toBeUndefined()
  }, 60_000)

  it('offers Retry on a pairing that has been finishing for the bound', async () => {
    const owner = await fabric.computer('stuck-owner'),
      caller = await fabric.computer('stuck-caller')
    const invite = await owner.dispatch('netEngine.invite', {}, true)
    // Nobody answers on the owner: the caller's join waits, its row finishing.
    void caller.dispatch('netEngine.join', { ticket: invite.uri }, true).catch(() => undefined)
    await eventually(async () => expect((await status(caller)).devices).toHaveLength(1))
    const node = (await status(caller)).devices[0]!.node
    expect(await device(caller, node)).toMatchObject({ state: 'finishing' })
    expect((await device(caller, node)).stuck).toBeUndefined()
    later(engineLimits().rowStuckMs + 1)
    expect(await device(caller, node)).toMatchObject({ state: 'finishing', stuck: true })
  }, 60_000)

  it('names the host from the link before it says its own name', async () => {
    const owner = await fabric.computer('named-owner'),
      caller = await fabric.computer('named-caller')
    const invite = await owner.dispatch('netEngine.invite', {}, true)
    expect(invite.uri).toMatch(/^mousse:\/\/pair\?n=named-owner%20computer#/)
    void caller.dispatch('netEngine.join', { ticket: invite.uri }, true).catch(() => undefined)
    await eventually(async () => expect((await status(caller)).devices[0]?.name).toBe('named-owner computer'))
  }, 60_000)

  it('asks with the name the joiner has now, not the one its helper started with', async () => {
    const owner = await fabric.computer('renamed-owner'),
      caller = await fabric.computer('renamed-caller')
    // The OS's computer name answered after the caller's helper started.
    caller.mms.netEngine.displayName = 'Studio Mac'
    const invite = await owner.dispatch('netEngine.invite', {}, true)
    void caller.dispatch('netEngine.join', { ticket: invite.uri }, true).catch(() => undefined)
    await eventually(async () => expect((await status(owner)).approvals[0]?.name).toBe('Studio Mac'))
  }, 60_000)

  it('ends the invitation a window showed once that window closes or switches profile', async () => {
    const owner = await fabric.computer('closing-owner')
    const lifetime = new AbortController()
    const invite = await dispatchMethod(
      {
        mms: owner.mms,
        connection: {
          id: 'settings-closing',
          clientType: 'gui',
          capabilities: new Set([NET_LOCAL_CAPABILITY]),
          binding: { profileId: owner.mms.profileId, epoch: 1 },
          lifetime: lifetime.signal
        },
        globalSequence: () => 0
      },
      'netEngine.invite',
      {}
    )
    const open = () =>
      [...fabric.network.invitations.values()].some((item) => item.invitation === invite.invitation)
    expect(open()).toBe(true)
    lifetime.abort()
    await eventually(() => expect(open()).toBe(false))
  }, 60_000)

  it('adds a local network address with the helper, and refuses others', async () => {
    const owner = await fabric.computer('address-owner'),
      caller = await fabric.computer('address-caller')
    const { callerOnOwner } = await fabric.pair(owner, caller)
    await owner.dispatch('netEngine.address.add', { node: callerOnOwner, address: ' 192.168.1.20:47100 ' }, true)
    expect((await device(owner, callerOnOwner)).addresses).toEqual(['tcp://192.168.1.20:47100'])
    expect(owner.fake!.addresses.get(caller.endpoint)).toEqual(['tcp://192.168.1.20:47100'])

    for (const [address, reason] of [
      ['8.8.8.8:47100', 'not_private'],
      ['192.168.1.20', 'bad_address'],
      ['laptop.local:47100', 'bad_address']
    ])
      await expect(
        owner.dispatch('netEngine.address.add', { node: callerOnOwner, address }, true)
      ).rejects.toMatchObject({ details: { reason } })
    expect((await device(owner, callerOnOwner)).addresses).toEqual(['tcp://192.168.1.20:47100'])
  }, 60_000)
})
