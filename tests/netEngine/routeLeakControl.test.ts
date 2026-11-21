/**
 * The routes-app control `route-leak` ("the app adds routes other than the one under test, offered first and
 * answering", 1b §14): the route offered is a second address of the helper's listener, on a port the checks'
 * class map leaves out, so over tcp it is of another class; over ssh B's prepare reply offers it, and A pins B with
 * it before the SSH route, so A's first connection to B is not over SSH.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/mms/netEngine/limits', async (original) => ({
  ...(await original<typeof import('../../src/mms/netEngine/limits')>()),
  engineControl: (name: string) => name === 'route-leak'
}))

import { NetDatabase } from '../../src/mms/net/store/database'
import type { EngineHelper } from '../../src/mms/netEngine/helper/connections'
import { pairbackRoutes } from '../../src/mms/netEngine/routes'
import { SshAdd } from '../../src/mms/netEngine/ssh/add'
import { EnginePeerStore } from '../../src/mms/netEngine/store'

const cleanups: Array<() => unknown> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

describe('route-leak', () => {
  it('offers first a second address of the listener, outside the class map, in pairback', () => {
    expect(pairbackRoutes({ port: 47301, routes: [] }, [], 'tcp://127.0.0.1:52000')).toEqual([
      'tcp://127.0.0.1:52000'
    ])
  })

  it('pins a computer added over SSH with the listener B offered before its SSH route', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engine-route-leak-'))
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
              already: false,
              routes: ['tcp://127.0.0.1:47999']
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
    expect(sent.find(([op]) => op === 'peer.addresses.set')![1].routes).toEqual([
      'tcp://127.0.0.1:47999',
      { route_id: 'r1', selector: 'a'.repeat(26), shell: 'sh' }
    ])
    ssh.dispose()
  })
})
