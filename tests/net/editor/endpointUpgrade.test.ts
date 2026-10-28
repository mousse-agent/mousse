import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { NetService } from '../../../src/mms/net/NetService'
import { EditorEndpoint } from '../../../src/mms/net/editor/endpoint/endpoint'
import { createUnixHost } from '../../../src/mms/net/editor/endpoint/unixHost'
import { MousseMainService } from '../../../src/mms/MousseMainService'
import { newId, type NodeId } from '../../../src/shared/net'

/**
 * What an upgrade does to a device that already had "Editor connections" on: before the endpoint its connections
 * ended at the computer's own SSH server, and they keep doing so (it needs a key it accepts, as it did), so the
 * upgrade grants nothing new and changes nothing it reaches. Devices that get the switch afterwards use the endpoint.
 */

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task()
})

function storedConfig(main: MousseMainService): { editorSystemSshNodes?: string[] } {
  const row = main.net
    .runtime()
    .db.database.prepare('SELECT value FROM net_service_config WHERE singleton=1')
    .get() as { value: string }
  return JSON.parse(String(row.value))
}

it('keeps a device that had the switch on at the system’s SSH server, and gives later devices the endpoint', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-editor-upgrade-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const open = (): Promise<MousseMainService> =>
    MousseMainService.create({
      homeDir: join(root, 'home'),
      repoRoot: root,
      headless: true,
      requireOwnership: false
    })
  const before: NodeId = newId('node')
  const after: NodeId = newId('node')
  let main = await open()
  await main.net.request('net.init', { listen: true })
  // A new profile has nothing to keep: the list is looked at once, and is empty.
  expect(storedConfig(main).editorSystemSshNodes).toEqual([])

  // The state of a profile from before the endpoint: a device with the switch on, and no record of the upgrade.
  const { policy, db } = main.net.runtime()
  policy.set(before, { editor: true })
  const raw = db.database.prepare('SELECT value FROM net_service_config WHERE singleton=1')
  const stored = JSON.parse(String((raw.get() as { value: string }).value))
  delete stored.editorSystemSshNodes
  db.database
    .prepare('UPDATE net_service_config SET value=? WHERE singleton=1')
    .run(JSON.stringify(stored))
  await main.stop()

  main = await open()
  cleanup.push(() => main.stop())
  expect(storedConfig(main).editorSystemSshNodes).toEqual([before])
  // A device that gets the switch later is not in the list: it uses the endpoint.
  main.net.runtime().policy.set(after, { editor: true })
  expect(storedConfig(main).editorSystemSshNodes).toEqual([before])
  // Turning the switch off ends the old arrangement for that device: a new grant is the endpoint's.
  main.net.runtime().policy.set(before, { editor: false })
  expect(storedConfig(main).editorSystemSshNodes).toEqual([])
}, 60_000)

it.skipIf(process.platform === 'win32')(
  'stops a server that an earlier run of the daemon left for a device with no right, when Net starts',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'net-editor-start-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const info = userInfo()
    const host = () =>
      createUnixHost({
        account: { user: info.username, home: root, shell: info.shell || '/bin/sh' },
        systemEnvironmentFiles: []
      })
    const profileDir = join(root, 'profile')
    mkdirSync(profileDir)
    const first = new NetService({ profileDir, editorTunnel: { endpointHost: host() } })
    await first.request('net.init', { name: 'owner', listen: false })
    // The marker of a device that is not on this computer's roster, made with this profile's own key store.
    const stranger: NodeId = newId('node')
    const token = new EditorEndpoint({ keys: first.runtime().keys, host: host() }).scopeOf(stranger)
    const pidFile = join(root, 'stranger.pid')
    const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));c.unref()`
    spawnSync(process.execPath, ['-e', script], {
      env: { PATH: process.env.PATH, MOUSSE_EDITOR_SCOPE: token }
    })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await first.shutdown()
    // Shutting down leaves it (an ordinary end); the daemon starts again and the sweep finds it by its marker.
    process.kill(pid, 0)
    const second = new NetService({ profileDir, editorTunnel: { endpointHost: host() } })
    cleanup.push(() => second.shutdown())
    await second.start()
    const deadline = Date.now() + 15_000
    for (;;) {
      try {
        process.kill(pid, 0)
        // A zombie of ours is gone for the purposes of this test; a process that is still running is not.
        const stat = readFileSync(`/proc/${pid}/stat`, 'latin1').replace(/^\d+ \(.*\) /u, '')
        if (stat.startsWith('Z') || stat.startsWith('X')) break
      } catch {
        break
      }
      if (Date.now() > deadline) throw new Error('the server was not stopped')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  },
  60_000
)
