import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, describe, expect, it } from 'vitest'
import { captureDarwinProcessTree, loadDarwinProcess, type DarwinProcessIdentity, type DarwinProcessModule } from '../src/mms/terminals/darwinProcess'
import { HEARTBEAT_CHILD_SCRIPT, heartbeatPath, makeLifecycleTempRoot, pidPath, readOwnedPidFile, removeOwnedTempRoot, waitForHeartbeat, waitUntilPidGone } from './fixtures/agent-platform/process-lifecycle/ownedTemp'

const roots: string[] = []
const owned: Array<{ process: ChildProcess; identities: DarwinProcessIdentity[] }> = []
afterEach(async () => {
  if (process.platform === 'darwin') {
    const native = loadDarwinProcess()
    for (const item of owned.splice(0)) {
      for (const identity of [...item.identities].reverse()) native.signal(identity.pid, identity.startedAt, 9)
      if (item.process.exitCode === null && item.process.signalCode === null) await once(item.process, 'exit')
      for (const identity of item.identities) await waitUntilPidGone(identity.pid, 'fixture cleanup')
    }
  }
  for (const root of roots.splice(0)) removeOwnedTempRoot(root)
})
async function tree(extra: Record<string, string> = {}) {
  const root = makeLifecycleTempRoot(); roots.push(root)
  const child = spawn(process.execPath, [HEARTBEAT_CHILD_SCRIPT], {
    stdio: 'ignore', env: { ...process.env, LIFECYCLE_HEARTBEAT_DIR: root, LIFECYCLE_ROLE: 'child', LIFECYCLE_SPAWN_GRANDCHILD: '1', LIFECYCLE_HEARTBEAT_MS: '40', ...extra }
  })
  const item = { process: child, identities: [] as DarwinProcessIdentity[] }; owned.push(item)
  const native = loadDarwinProcess()
  const identity = native.read(child.pid!)
  if (!identity) throw new Error('Fixture child exited before ownership capture')
  item.identities.push(identity)
  await waitForHeartbeat(heartbeatPath(root, 'child'))
  await waitForHeartbeat(heartbeatPath(root, 'grandchild'))
  const grandchild = native.read(readOwnedPidFile(pidPath(root, 'grandchild')))
  if (!grandchild) throw new Error('Fixture grandchild exited before ownership capture')
  item.identities.push(grandchild)
  return { native, identity, grandchild, root }
}
describe.runIf(process.platform === 'darwin')('Darwin kernel birth identity and exact owned descendants', () => {
  it('keeps a captured orphan after its parent exits and force-drains it without touching an unrelated live tree', async () => {
    const a = await tree({ LIFECYCLE_GRANDCHILD_IGNORE_STOP: '1' }), unrelated = await tree()
    expect(a.grandchild.parent).toBe(a.identity.pid)
    expect(a.identity.startedAt).toMatch(/^\d+:\d+$/)
    const captured = captureDarwinProcessTree(a.identity.pid)
    captured.signal('term')
    await waitUntilPidGone(a.identity.pid, 'graceful original parent')
    expect(a.native.read(a.grandchild.pid)?.startedAt).toBe(a.grandchild.startedAt)
    expect(captured.isAlive()).toBe(true)
    captured.signal('kill')
    await waitUntilPidGone(a.grandchild.pid, 'captured stubborn orphan')
    expect(captured.isAlive()).toBe(false)
    expect(a.native.read(unrelated.identity.pid)?.startedAt).toBe(unrelated.identity.startedAt)
    expect(a.native.read(unrelated.grandchild.pid)?.startedAt).toBe(unrelated.grandchild.startedAt)
  }, 15000)

  it('rejects a substituted birth identity and invalid/current PID without delivering a signal', async () => {
    const { native, identity } = await tree()
    expect(native.signal(identity.pid, `${identity.startedAt}:different`, 9)).toBe(false)
    expect(native.read(identity.pid)?.startedAt).toBe(identity.startedAt)
    for (const pid of [0, -1, process.pid, 1.5]) expect(() => native.signal(pid, identity.startedAt, 9)).toThrow()
    expect(() => native.signal(identity.pid, identity.startedAt, 2)).toThrow()
    expect(native.read(identity.pid)?.startedAt).toBe(identity.startedAt)
  })
  it('fails closed in a fresh host with missing or hash-substituted packaged resources', () => {
    const root = makeLifecycleTempRoot(); roots.push(root)
    const entry = join(root, 'probe.mjs')
    buildSync({ stdin: { contents: `import {loadDarwinProcess} from ${JSON.stringify(resolve('src/mms/terminals/darwinProcess.ts'))}; loadDarwinProcess();`, resolveDir: process.cwd(), sourcefile: 'owned-probe.ts' }, outfile: entry, bundle: true, format: 'esm', platform: 'node' })
    const missing = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 5000 })
    expect(missing.status).not.toBe(0); expect(missing.stderr).toContain('addon missing')
    const destination = join(root, 'out/net-native', `darwin-${process.arch}`), source = resolve('out/net-native', `darwin-${process.arch}`)
    mkdirSync(destination, { recursive: true }); cpSync(join(source, 'owned-process.node'), join(destination, 'owned-process.node'))
    const manifest = JSON.parse(readFileSync(join(source, 'owned-process-manifest.json'), 'utf8'))
    manifest.artifactSha256 = '0'.repeat(64)
    writeFileSync(join(destination, 'owned-process-manifest.json'), JSON.stringify(manifest))
    const substituted = spawnSync(process.execPath, [entry], { encoding: 'utf8', timeout: 5000 })
    expect(substituted.status).not.toBe(0); expect(substituted.stderr).toContain('artifact verification failed')
  })
})

describe('Darwin capture fails closed before any signal', () => {
  const root = { pid: 80001, parent: 1, startedAt: '100:17' }, child = { pid: 80002, parent: 80001, startedAt: '100:18' }
  function adapter(overrides: Partial<DarwinProcessModule> = {}): DarwinProcessModule {
    return { read: pid => pid === root.pid ? root : pid === child.pid ? child : null, children: pid => pid === root.pid ? [child.pid] : [], signal: () => { throw new Error('No signal permitted') }, ...overrides }
  }
  it('rejects a changed root birth and an unrelated child parent', () => {
    let reads = 0
    expect(() => captureDarwinProcessTree(root.pid, adapter({ read: pid => pid === root.pid ? (++reads >= 3 ? { ...root, startedAt: '100:19' } : root) : child }))).toThrow(/changed/)
    expect(() => captureDarwinProcessTree(root.pid, adapter({ read: pid => pid === root.pid ? root : { ...child, parent: 1 } }))).toThrow(/ancestry/)
  })
  it('retains unknown native identity errors and bounds capture inventory', () => {
    expect(() => captureDarwinProcessTree(root.pid, adapter({ children: () => { throw new Error('EPERM') } }))).toThrow('EPERM')
    const wide = adapter({ children: pid => pid === root.pid ? Array.from({ length: 256 }, (_, index) => 90000 + index) : [], read: pid => pid === root.pid ? root : { pid, parent: root.pid, startedAt: `100:${pid}` } })
    expect(() => captureDarwinProcessTree(root.pid, wide)).toThrow(/exceeded 256/)
    let unavailable = false
    const captured = captureDarwinProcessTree(root.pid, adapter({ read: pid => {
      if (unavailable) throw new Error('EPERM')
      return pid === root.pid ? root : child
    } }))
    expect(captured.isAlive()).toBe(true)
    unavailable = true
    expect(captured.isAlive()).toBe(true)
    expect(() => captured.signal('kill')).toThrow('No signal permitted')
  })
})
