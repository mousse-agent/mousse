/**
 * A pairing that moves to a newer path (a LAN path taking over from Tailscale, say) tells the windows: the device
 * row names the route of the path in use, and the window hears that the row changed once the move is done.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../../src/mms/MousseMainService'
import { Channel } from '../../src/mms/netEngine/session/transport'
import { newId, type NodeId } from '../../src/shared/net'
import { fakeLink } from './fakeLink'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('a path taking over', () => {
  it('tells the window, and the row names the route of the path now in use', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'engine-path-in-use-')))
    const mms = await MousseMainService.create({ homeDir: home, repoRoot: home, headless: true, requireOwnership: false })
    cleanups.push(
      () => rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }),
      () => mms.stop()
    )
    const engine = mms.netEngine
    await engine.enable()
    // What the windows hear: a device row changed.
    const changed = vi.fn()
    mms.events.on('protocol:event', ((event: { type: string; data: { kind?: string } }) => {
      if (event.type === 'ui.notify' && event.data.kind === 'net-engine') changed()
    }) as (data: unknown) => void)
    const grant = 'grant-held-by-owner'
    const node = engine.pair({
      endpoint: 'owner.test:7000',
      fingerprint: 'sha256:owner',
      grant,
      name: 'Owner computer',
      state: 'connected'
    }).localId as NodeId
    const link = (cls: string) => {
      const made = fakeLink({ ownerOnCaller: node, callerOnOwner: newId('node') as NodeId, grant, endpoint: 'owner.test:7000' })
      made.inbound.onStream((stream) => {
        const channel = new Channel(stream)
        channel.onMessage((message) => {
          if (message.header.t === 'hello') channel.send({ t: 'hello', proto: 1, name: 'owner' })
          if (message.header.t === 'call') {
            channel.send({ t: 'result', result: {} })
            channel.end()
          }
        })
      })
      Object.assign(made.outbound, { route: { kind: 'tcp', class: cls } })
      return made
    }
    const route = () => engine.devices().find((device) => device.node === node)?.route
    await engine.attach(link('tailnet').outbound)
    expect(route()).toBe('tailnet')
    await new Promise((resolve) => setTimeout(resolve, 20))
    changed.mockClear()
    await engine.attach(link('lan').outbound)
    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 2_000 })
    expect(route()).toBe('lan')
  })
})
