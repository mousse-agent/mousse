import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import type { RoutesRecord } from '../../../src/shared/net'

const fixtureCommand = vi.hoisted(() => ({ binary: undefined as string | undefined }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const invoke = (method: 'spawn' | 'execFile', input: unknown[]) => {
    if (process.platform === 'win32' && input[0] === fixtureCommand.binary) {
      // I run this shebang fixture through Node on Windows, including its
      // version probe. Every other process keeps its real invocation.
      return Reflect.apply(actual[method], undefined, [
        process.execPath,
        [fixtureCommand.binary, ...(input[1] as string[])],
        ...input.slice(2)
      ])
    }
    return Reflect.apply(actual[method], undefined, input)
  }
  return {
    ...actual,
    spawn: ((...input: unknown[]) => invoke('spawn', input)) as typeof actual.spawn,
    execFile: ((...input: unknown[]) => invoke('execFile', input)) as typeof actual.execFile
  }
})

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  fixtureCommand.binary = undefined
})
function profile() {
  const directory = mkdtempSync(join(tmpdir(), 'mousse-net-transition-'))
  const net = new NetService({ profileDir: directory })
  cleanup.push(
    () => rmSync(directory, { recursive: true, force: true }),
    () => net.shutdown()
  )
  return { directory, net }
}

it('preserves an unchanged quick tunnel when withdrawing direct after a peer retains signed routes', async () => {
  const host = profile(),
    follower = profile()
  await host.net.request('net.init', { listen: true, port: 0 })
  await host.net.request('net.protect', { passphrase: 'transition-owner-protection' })
  const authority = host.net.status().self!.node
  const invite = (await host.net.request('bridge.invite', {})) as { invite: string }
  await follower.net.request('bridge.join', {
    invite: invite.invite,
    passphrase: 'transition-follower-protection'
  })
  const starts = join(host.directory, 'starts'),
    binary = join(host.directory, 'cloudflared-fixture')
  writeFileSync(
    binary,
    `#!${process.execPath}\nif(process.argv.includes('--version'))process.exit(0);const fs=require('fs'),path=${JSON.stringify(starts)},n=fs.existsSync(path)?Number(fs.readFileSync(path)):0;fs.writeFileSync(path,String(n+1));console.error('https://run'+n+'.trycloudflare.com');console.error('Registered tunnel connection');setInterval(()=>{},1000)`,
    { mode: 0o700 }
  )
  fixtureCommand.binary = binary
  await host.net.request('net.transport.configure', {
    id: 'cloudflared',
    enabled: true,
    settings: { mode: 'quick', binary }
  })
  const before = JSON.parse(
    Buffer.from(host.net.signedRoutes().payload, 'base64url').toString()
  ) as RoutesRecord
  expect(before.routes).toContainEqual(
    expect.objectContaining({ transport: 'cloudflared', address: 'wss://run0.trycloudflare.com/mousse-net' })
  )
  let retained: RoutesRecord | undefined
  await vi.waitFor(
    () => {
      const row = follower.net
        .runtime()
        .db.database.prepare('SELECT signed FROM net_peer_routes WHERE node=?')
        .get(authority)
      expect(row).toBeDefined()
      retained = JSON.parse(
        Buffer.from(JSON.parse(String(row!.signed)).payload, 'base64url').toString()
      ) as RoutesRecord
      expect(retained!.routes).toEqual(before.routes)
    },
    { timeout: 5000 }
  )
  await host.net.request('net.transport.configure', { id: 'direct', enabled: false, settings: {} })
  const after = JSON.parse(
    Buffer.from(host.net.signedRoutes().payload, 'base64url').toString()
  ) as RoutesRecord
  expect(after.routes).toEqual(
    retained!.routes.filter((route) => route.transport === 'cloudflared')
  )
  expect(after.version).toBeGreaterThan(before.version)
  expect(readFileSync(starts, 'utf8')).toBe('1')
}, 15_000)
