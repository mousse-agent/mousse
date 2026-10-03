import { createRequire } from 'node:module'
import { join } from 'node:path'
import { realpathSync, writeFileSync } from 'node:fs'
import { HeadlessAgentRunner } from '../../../src/mms/terminals/HeadlessAgentRunner'
import { captureDarwinProcessTree, loadDarwinProcess } from '../../../src/mms/terminals/darwinProcess'
import { quoteForShell, heartbeatPath, pidPath, readOwnedPidFile, waitForHeartbeat, waitUntilPidGone } from '../../../tests/fixtures/agent-platform/process-lifecycle/ownedTemp'

async function main(): Promise<void> {
  const directory = realpathSync(process.env.MOUSSE_OWNED_PROCESS_QA_DIRECTORY!)
  const heartbeat = realpathSync(process.env.MOUSSE_OWNED_PROCESS_QA_HEARTBEAT!)
  let app: { whenReady(): Promise<void>; setPath(name: string, path: string): void; exit(code: number): void; disableHardwareAcceleration(): void; dock?: { hide(): void } } | undefined
  if (process.versions.electron) {
    app = createRequire(import.meta.url)('electron').app
    app!.setPath('userData', join(directory, 'electron-data')); app!.disableHardwareAcceleration()
    await app!.whenReady(); app!.dock?.hide()
  }
  const runner = new HeadlessAgentRunner(), unrelated = new HeadlessAgentRunner(), native = loadDarwinProcess()
  const spawn = async (owner: HeadlessAgentRunner, name: string, stubborn: boolean) => {
    const beats = join(directory, name)
    owner.spawn(name, directory, `${quoteForShell(process.execPath)} ${quoteForShell(heartbeat)}`, { env: {
      ELECTRON_RUN_AS_NODE: '1', LIFECYCLE_HEARTBEAT_DIR: beats, LIFECYCLE_ROLE: 'child',
      LIFECYCLE_HEARTBEAT_MS: '40', LIFECYCLE_SPAWN_GRANDCHILD: '1', LIFECYCLE_GRANDCHILD_IGNORE_STOP: stubborn ? '1' : '0'
    } })
    await waitForHeartbeat(heartbeatPath(beats, 'child')); await waitForHeartbeat(heartbeatPath(beats, 'grandchild'))
    return { child: readOwnedPidFile(pidPath(beats, 'child')), grandchild: readOwnedPidFile(pidPath(beats, 'grandchild')) }
  }
  try {
    const tree = await spawn(runner, 'owned', true), other = await spawn(unrelated, 'unrelated', false)
    const original = native.read(tree.child)!, grandchild = native.read(tree.grandchild)!
    if (native.signal(tree.child, `${original.startedAt}:wrong`, 9) || native.read(tree.child)?.startedAt !== original.startedAt) throw new Error('Birth mismatch guard failed')
    const captured = captureDarwinProcessTree(tree.child)
    const close = runner.shutdown({ timeoutMs: 1500 })
    await waitUntilPidGone(tree.child, 'graceful parent')
    const capturedOrphan = native.read(tree.grandchild)?.startedAt === grandchild.startedAt && captured.isAlive()
    await close
    await waitUntilPidGone(tree.grandchild, 'forced orphan')
    const unrelatedAlive = native.read(other.child) !== null && native.read(other.grandchild) !== null
    if (!capturedOrphan || !unrelatedAlive || runner.getActiveCount() !== 0) throw new Error('Owned tree drain or unrelated guard failed')
    await unrelated.shutdown({ timeoutMs: 1500 })
    await waitUntilPidGone(other.child, 'unrelated cleanup'); await waitUntilPidGone(other.grandchild, 'unrelated grandchild cleanup')
    const result = { platform: process.platform, arch: process.arch, node: process.versions.node, electron: process.versions.electron, napi: process.versions.napi, capturedOrphan, unrelatedAlive, birthMismatchDenied: true, ownedCount: runner.getActiveCount(), allPidsGone: true }
    writeFileSync(join(directory, 'evidence.json'), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify(result)); app?.exit(0)
  } finally {
    await Promise.all([runner.shutdown({ timeoutMs: 2000 }), unrelated.shutdown({ timeoutMs: 2000 })])
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
