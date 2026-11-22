/**
 * The routes-app control `lan-only-candidates` ("the app passes only LAN addresses to the helper", 1b §14) holds in
 * every route case: a join approves nothing, and a pairing's addresses (`peer.addresses.set`) keep only its LAN
 * ones, with no SSH route, so over ssh too nothing reaches the other computer.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/mms/netEngine/limits', async (original) => ({
  ...(await original<typeof import('../../src/mms/netEngine/limits')>()),
  engineControl: (name: string) => name === 'lan-only-candidates'
}))

import { NetDatabase } from '../../src/mms/net/store/database'
import type { EngineHelper } from '../../src/mms/netEngine/helper/connections'
import { ownerRoutes } from '../../src/mms/netEngine/NetEngineService'
import { approvedHints } from '../../src/mms/netEngine/routes'
import { SshAdd } from '../../src/mms/netEngine/ssh/add'
import { EnginePeerStore } from '../../src/mms/netEngine/store'

const cleanups: Array<() => unknown> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

describe('lan-only-candidates', () => {
  it('approves no hint and hands the helper only LAN addresses, no SSH route', () => {
    expect(approvedHints(['tcp://100.101.7.2:7443', 'wss://relay.example/t'])).toEqual([])
    const ssh = { requestId: 'r', routeId: 'route1', selector: 'abc' }
    expect(ownerRoutes({ ssh }, ['tcp://192.168.1.20:7443', 'tcp://100.101.7.2:7443'])).toEqual([
      'tcp://192.168.1.20:7443'
    ])
  })

  it('pins a computer added over SSH without its SSH route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-lan-only-'))
    const db = new NetDatabase({ profileDir: dir })
    cleanups.push(
      () => rmSync(dir, { recursive: true, force: true }),
      () => db.close()
    )
    const sent: Array<[string, any]> = []
    const helper = {
      speaks: () => true,
      claim: () => undefined,
      dial: async () => 1,
      request: async (op: string, fields: any) => {
        sent.push([op, fields])
        if (op === 'ssh.run')
          return {
            reply: {
              identity: 'bb'.repeat(32),
              name: 'B',
              selector: 'a'.repeat(26),
              grant_id: '4',
              existing: false,
              already: false
            }
          }
        return {}
      }
    } as unknown as EngineHelper
    const ssh = new SshAdd({
      peers: new EnginePeerStore(db),
      helper: () => helper,
      identity: () => 'aa'.repeat(32),
      name: () => 'A',
      limits: () => ({ deadlineMs: 5_000, maxAgeSecs: 86_400 }),
      changed: () => undefined,
      now: () => 1_800_000_000
    })
    await ssh.connect({ routeId: 'r1', target: 'me@b', host: 'b', user: 'me', selector: 'a'.repeat(26) })
    expect(sent.find(([op]) => op === 'peer.addresses.set')![1].routes).toEqual([])
    ssh.dispose()
  })
})
