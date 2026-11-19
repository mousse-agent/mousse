/**
 * Owner check `phase1a.reconnect`: two paired computers connect again on their own after either one's helper
 * restarts, after either one's app restarts, and after the owner's address changes (its helper starts on another
 * port; the caller finds it through the browse file, `MOUSSE_HELPER_BROWSE_FILE`, as it would through mDNS).
 *
 * It needs the real helper (`MOUSSE_NET_HELPER`, a debug build: loopback routes and the browse file are debug-only);
 * without it, a check run fails with `no_helper` and a plain test run skips it. Its control, a helper built with
 * `no-rediscovery` (once a pairing has a last working route, only that route is tried), fails it with `unreachable`,
 * which only the address change gives: the pairing and the restarts before it must work under the control too.
 * `scripts/net-engine-check.mjs phase1a.reconnect` runs it and prints the marker.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NodeId } from '../../../src/shared/net'
import { eventually, Fabric, REAL_HELPER, step, type Computer } from './harness'

const browseFile = join(mkdtempSync(join(tmpdir(), 'engine-browse-')), 'hosts')
writeFileSync(browseFile, '')
process.env.MOUSSE_HELPER_BROWSE_FILE = browseFile

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe.runIf(REAL_HELPER)('phase1a.reconnect', () => {
  const fabric = new Fabric()
  let owner: Computer, caller: Computer
  let callerOnOwner: NodeId, ownerOnCaller: NodeId
  beforeAll(async () => {
    owner = await fabric.computer('owner')
    caller = await fabric.computer('caller')
    // A working pairing first, both ways, with its own reason: `unreachable` is the address change's alone.
    ;({ callerOnOwner, ownerOnCaller } = await step('not_paired', () => fabric.pair(owner, caller)))
  }, 120_000)
  afterAll(() => fabric.close(), 120_000)

  /** Both directions are up again. */
  const bothOnline = (reason: string, timeout = 60_000) =>
    step(reason, () =>
      eventually(() => {
        expect(owner.mms.netEngine.online(callerOnOwner)).toBe(true)
        expect(caller.mms.netEngine.online(ownerOnCaller)).toBe(true)
      }, timeout)
    )
  /** Both directions went down (the restart was seen) before they come back. */
  const wentDown = () =>
    eventually(() => {
      expect(
        owner.mms.netEngine.online(callerOnOwner) && caller.mms.netEngine.online(ownerOnCaller)
      ).toBe(false)
    }, 10_000).catch(() => undefined)

  it('reconnects after the owner helper restarts', async () => {
    await bothOnline('not_reconnected')
    await fabric.restartHelper(owner)
    await bothOnline('not_reconnected')
  }, 120_000)

  it('reconnects after the caller helper restarts', async () => {
    await fabric.restartHelper(caller)
    await bothOnline('not_reconnected')
  }, 120_000)

  it('reconnects after either app restarts', async () => {
    await fabric.restartEngine(owner)
    await bothOnline('not_reconnected')
    await fabric.restartEngine(caller)
    await bothOnline('not_reconnected')
  }, 180_000)

  it("reconnects after the owner's address changes", async () => {
    const port = await freePort()
    writeFileSync(browseFile, `127.0.0.1:${port}\n`)
    owner.port = port
    await fabric.restartHelper(owner)
    expect(owner.engine.info.port).toBe(port)
    await wentDown()
    await bothOnline('unreachable', 90_000)
  }, 180_000)
})

describe.runIf(!REAL_HELPER && !!process.env.MOUSSE_NET_ENGINE_CHECK_OUT)(
  'phase1a.reconnect',
  () => {
    it('needs the real helper', async () => {
      await step('no_helper', () => {
        throw new Error('phase1a.reconnect runs only with MOUSSE_NET_HELPER (a debug helper build)')
      })
    })
  }
)
