import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, expect, it } from 'vitest'
import { LocalMmsClient } from '../src/mms/protocol/client'
import type { Thread } from '../src/shared/types'
import { productBuild } from './support/build'
import { startDaemon, type Daemon } from './support/daemon'

let entry = ''
beforeAll(async () => {
  entry = (await productBuild()).entry
}, 120_000)

async function until<T>(probe: () => T | Promise<T>, ready: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value: T
  do {
    value = await probe()
    if (ready(value)) return value
    await new Promise((done) => setTimeout(done, 40))
  } while (Date.now() < deadline)
  throw new Error('Lifecycle daemon state did not arrive: ' + JSON.stringify(value!))
}

it('recovers actual daemon crashes immediately after trash AND restore rename, preserving bytes and idle admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'resource-lifecycle-daemon-'))
  const home = join(root, 'home'), control = join(root, 'fault.json'), marker = join(root, 'renamed.json')
  const daemons: Daemon[] = []
  let rpc: LocalMmsClient | undefined
  const launch = async () => {
    const daemon = await startDaemon({
      entry, home, repoRoot: root, label: 'Lifecycle daemon',
      nodeArgs: ['--import', pathToFileURL(resolve('tests/fixtures/resource-lifecycle-crash-preload.mjs')).href],
      env: { RESOURCE_LIFECYCLE_CRASH_CONTROL: control }
    })
    daemons.push(daemon)
    const owner = daemon.owner!
    rpc = new LocalMmsClient({ homeDir: home, endpoint: owner.endpoint, ownerToken: owner.token, clientType: 'gui', requestedCapabilities: ['profiles-v1'] })
    await rpc.connect()
    const { defaultProfileId } = await rpc.request<{ defaultProfileId: string }>('profiles.list', {})
    await rpc.request('profiles.bind', { profile: defaultProfileId })
    return { daemon, profileId: defaultProfileId }
  }
  try {
    const first = await launch()
    const { thread } = await rpc!.request<{ thread: Thread }>('threads.create', { name: 'crash recovery sole copy' })
    // Resolve from the persisted authority rather than assuming a movable layout.
    const recordPath = join(home, 'profiles', first.profileId, 'lifecycle', 'tasks', `${thread.id}.json`)
    expect(existsSync(recordPath), 'daemon must persist external owner authority').toBe(true)
    const original = JSON.parse(readFileSync(recordPath, 'utf8')).location as string
    expect(original).toBeTruthy()
    expect(existsSync(join(original, 'meta.json'))).toBe(true)
    const payload = Buffer.from([0, 1, 255, 10, 198, 99])
    writeFileSync(join(original, 'sole-copy.bin'), payload)
    writeFileSync(control, JSON.stringify({ from: original, marker }))
    await rpc!.request('threads.trash', { threadId: thread.id }).catch(() => undefined)
    await until(() => first.daemon.done, Boolean)
    expect(existsSync(marker), 'fault must actually intercept the completed rename').toBe(true)
    const moved = JSON.parse(readFileSync(marker, 'utf8'))
    expect(readFileSync(join(moved.to, 'sole-copy.bin'))).toEqual(payload)
    expect(existsSync(original)).toBe(false)
    await rpc!.close(); rpc = undefined
    writeFileSync(control, '{}')

    const second = await launch()
    expect(second.profileId).toBe(first.profileId)
    await expect(rpc!.request('threads.get', { threadId: thread.id })).rejects.toThrow()
    await expect(rpc!.request('threads.purge', { threadId: thread.id })).rejects.toThrow(/operationId/i)
    await expect(rpc!.request('threads.purge', { threadId: thread.id, operationId: 'unreviewed-crash-purge' })).rejects.toThrow(/preview|review/i)
    const unreviewed = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(unreviewed.state).toBe('trashed')
    expect(unreviewed.purge).toBeUndefined()
    expect(readFileSync(join(unreviewed.location, 'sole-copy.bin'))).toEqual(payload)
    rmSync(marker)
    writeFileSync(control, JSON.stringify({ to: original, marker }))
    await rpc!.request('threads.restore', { threadId: thread.id }).catch(() => undefined)
    await until(() => second.daemon.done, Boolean)
    expect(existsSync(marker), 'restore must reach its rename boundary').toBe(true)
    expect(readFileSync(join(original, 'sole-copy.bin'))).toEqual(payload)
    await rpc!.close(); rpc = undefined
    writeFileSync(control, '{}')

    await launch()
    const recovered = await rpc!.request<{ thread: Thread }>('threads.get', { threadId: thread.id })
    expect(recovered.thread.id).toBe(thread.id)
    expect(readFileSync(join(original, 'sole-copy.bin'))).toEqual(payload)
    const owner = JSON.parse(readFileSync(recordPath, 'utf8'))
    expect(owner.state).toBe('active')
    expect(owner.generation).toBeGreaterThan(1)
    for (const lock of ['execution.lease', 'queue.mut.lock', 'thread-data.mut.lock']) expect(existsSync(join(original, lock))).toBe(false)
    await rpc!.request('threads.rename', { threadId: thread.id, name: 'fresh write after recovery' })
    expect((await rpc!.request<{ thread: Thread }>('threads.get', { threadId: thread.id })).thread.name).toBe('fresh write after recovery')
  } finally {
    await rpc?.close()
    await Promise.all(daemons.map((daemon) => daemon.kill()))
    if (!basename(root).startsWith('resource-lifecycle-daemon-')) throw new Error('Unsafe fixture cleanup')
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}, 120_000)
