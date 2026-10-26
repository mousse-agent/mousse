/**
 * Managed installs of registry agents (agent CLIs plan §4, v3 B): downloads are checked against
 * the registry checksum, capped and pinned to their host; the receipt records every file and a
 * changed file refuses the launch; an unverified download needs consent for each version; profiles
 * share one copy under the agent's lock; references of deleted profiles keep nothing alive; an old
 * version goes once no process uses it.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InstanceEnv } from '../../src/mms/harness/env'
import { AgentInstalls, ConsentRequiredError, downloadArtifact, isolatedNpmEnv, packageBin, resetAgentInstallState, resolveNpm, sha512Of, withoutCredentials, type InstallProgress, type NpmRunner, type RegistrySource } from '../../src/mms/harness/agents/install'
import { LockBusyError, withLock } from '../../src/mms/harness/agents/lock'
import type { RegistryAgent } from '../../src/mms/harness/agents/registry'
import { tarGzOf } from './archiveFixtures'

const KEY = 'linux-x86_64' as const
const dirs: string[] = []
const servers: Server[] = []

beforeEach(() => resetAgentInstallState())
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** A local download server: `/archive/<name>` serves `files[name]`; `/redirect/<name>?to=…` redirects. */
async function downloads(files: Record<string, Buffer>) {
  const hits: string[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    hits.push(url.pathname)
    if (url.pathname.startsWith('/redirect/')) {
      response.writeHead(302, { location: url.searchParams.get('to') ?? '/' })
      response.end()
      return
    }
    const file = files[url.pathname.replace(/^\/archive\//, '')]
    if (!file) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, { 'content-length': String(file.length) })
    response.end(file)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { base: `http://127.0.0.1:${port}`, port, hits }
}

const archive = tarGzOf([
  { name: 'bin/', type: '5' },
  { name: 'bin/demo', data: '#!/bin/sh\necho demo\n', mode: 0o755 },
  { name: 'lib/helper.txt', data: 'helper' }
])

function agent(version: string, url: string, options: { sha256?: string | null; args?: string[] } = {}): RegistryAgent {
  const digest = options.sha256 === null ? undefined : options.sha256 ?? sha(archive)
  return {
    id: 'demo-agent',
    name: 'Demo',
    version,
    description: '',
    authors: [],
    distribution: { binary: { [KEY]: { archive: url, cmd: './bin/demo', ...(digest ? { sha256: digest } : {}), args: options.args ?? ['--acp'], env: { DEMO_MODE: 'acp' } } } }
  }
}

function setup(options: { profiles?: Array<{ id: string; displayName?: string }>; npm?: NpmRunner; maxDownloadBytes?: number; liveInstances?: () => string[]; fetch?: typeof fetch; npmRegistry?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-agent-install-'))
  dirs.push(home)
  const registry = { current: undefined as RegistryAgent | undefined }
  const source = { agent: async (id: string) => (registry.current?.id === id ? registry.current : undefined), cached: () => (registry.current ? [registry.current] : []) }
  const profiles = options.profiles ?? [{ id: 'p1', displayName: 'Personal' }, { id: 'p2', displayName: 'Work' }]
  const listed = { profiles }
  const installs = (profileId: string) => new AgentInstalls({
    installationHome: home,
    profileId,
    registry: source,
    listProfiles: () => listed.profiles,
    platformKeys: [KEY],
    exitGraceMs: 50,
    ...(options.liveInstances ? { liveInstances: options.liveInstances } : {}),
    ...(options.npm ? { npm: options.npm } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.npmRegistry ? { npmRegistry: options.npmRegistry } : {}),
    ...(options.maxDownloadBytes ? { maxDownloadBytes: options.maxDownloadBytes } : {})
  })
  const env: InstanceEnv = { instanceId: 'acp:demo', driver: 'acp', configRevision: 0, homeId: 'default', env: { ...process.env }, searchPath: [] }
  const agentDir = join(home, 'agents', 'demo-agent')
  return { home, registry, listed, installs, env, agentDir }
}

const binarySource = (version = '1.0.0', consent?: RegistrySource['consent']): RegistrySource => ({ kind: 'registry', agentId: 'demo-agent', version, distribution: 'binary', ...(consent ? { consent } : {}) })

function stagingLeft(agentDir: string): string[] {
  return existsSync(agentDir) ? readdirSync(agentDir).filter((name) => name.startsWith('.staging-')) : []
}

describe('managed agent installs', () => {
  it('installs a checked download with byte progress and records every file in its receipt', async () => {
    const server = await downloads({ 'demo.tar.gz': archive })
    const { registry, installs, env, agentDir } = setup()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    const progress: InstallProgress[] = []
    const installed = await installs('p1').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: (step) => progress.push(step) })
    expect(progress.some((step) => step.receivedBytes === archive.length && step.totalBytes === archive.length)).toBe(true)
    expect(installed.root).toBe(join(agentDir, '1.0.0', KEY))
    expect(installed.receipt).toMatchObject({
      agentId: 'demo-agent', version: '1.0.0', platform: KEY, distribution: 'binary', checksum: 'registry',
      expected: { algorithm: 'sha256', digest: sha(archive) }, archiveSha256: sha(archive),
      launch: { cmd: 'bin/demo', args: ['--acp'], env: { DEMO_MODE: 'acp' } }, bytes: 26
    })
    expect(Object.keys(installed.receipt.files).sort()).toEqual(['bin/demo', 'lib/helper.txt'])
    expect(installed.receipt.consentedAt).toBeUndefined()
    expect(JSON.parse(readFileSync(join(agentDir, 'refs', 'p1.json'), 'utf8'))).toEqual({ instances: { 'acp:demo': { version: '1.0.0', platform: KEY } } })
    expect(stagingLeft(agentDir)).toEqual([])
    const launch = installs('p1').launch(installed, env)
    expect(launch.path).toBe(join(installed.root, 'dist', 'bin', 'demo'))
    expect(launch.args).toEqual(['--acp'])
  })

  it('refuses a download that misses the registry checksum or the size cap, leaving nothing behind', async () => {
    const server = await downloads({ 'demo.tar.gz': archive })
    const { registry, installs, env, agentDir } = setup()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`, { sha256: 'b'.repeat(64) })
    await expect(installs('p1').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })).rejects.toThrow(/does not match the registry checksum/)
    expect(existsSync(join(agentDir, '1.0.0'))).toBe(false)
    expect(stagingLeft(agentDir)).toEqual([])
    const capped = setup({ maxDownloadBytes: 16 })
    capped.registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    await expect(capped.installs('p1').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })).rejects.toThrow(/larger than/)
    expect(stagingLeft(capped.agentDir)).toEqual([])
  })

  it('follows redirects on the declared host or the GitHub asset hosts only, and records the final URL', async () => {
    const server = await downloads({ 'demo.tar.gz': archive })
    const { registry, installs, env } = setup()
    registry.current = agent('1.0.0', `${server.base}/redirect/demo.tar.gz?to=${encodeURIComponent('/archive/demo.tar.gz')}`)
    const installed = await installs('p1').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    expect(installed.receipt.finalUrl).toBe(`${server.base}/archive/demo.tar.gz`)
    const other = setup()
    other.registry.current = agent('1.0.0', `${server.base}/redirect/demo.tar.gz?to=${encodeURIComponent(`http://localhost:${server.port}/archive/demo.tar.gz`)}`)
    await expect(other.installs('p1').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })).rejects.toThrow(/redirected to localhost:\d+/)

    const target = join(other.home, 'download')
    const redirect = (to: string) => (async (url: string) => (url.startsWith('https://github.com/') ? new Response(null, { status: 302, headers: { location: to } }) : new Response('data'))) as unknown as typeof fetch
    await expect(downloadArtifact('https://github.com/o/r/releases/a.zip', target, { fetch: redirect('https://release-assets.githubusercontent.com/a'), label: 'Demo' })).resolves.toMatchObject({ finalUrl: 'https://release-assets.githubusercontent.com/a', bytes: 4 })
    await expect(downloadArtifact('https://github.com/o/r/releases/a.zip', `${target}2`, { fetch: redirect('https://evil.example/a'), label: 'Demo' })).rejects.toThrow(/evil\.example/)
    await expect(downloadArtifact('https://github.com/o/r/releases/a.zip', `${target}3`, { fetch: redirect('http://github.com/a'), label: 'Demo' })).rejects.toThrow(/does not download agents from/)
  })

  it('finds changed, added and removed files, and a replaced install record', async () => {
    const server = await downloads({ 'demo.tar.gz': archive })
    const { registry, installs, env } = setup()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    const manager = installs('p1')
    const installed = await manager.install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    const dist = join(installed.root, 'dist')
    expect(await manager.changed(installed, installed.hash)).toBeUndefined()
    expect(await manager.changed(installed, 'f'.repeat(64))).toBe('the install was replaced')
    writeFileSync(join(dist, 'lib', 'helper.txt'), 'patched')
    expect(await manager.changed(installed, installed.hash)).toBe('lib/helper.txt changed')
    writeFileSync(join(dist, 'lib', 'helper.txt'), 'helper')
    writeFileSync(join(dist, 'bin', 'planted.dll'), 'x')
    expect(await manager.changed(installed, installed.hash)).toBe('bin/planted.dll was added')
    unlinkSync(join(dist, 'bin', 'planted.dll'))
    unlinkSync(join(dist, 'lib', 'helper.txt'))
    expect(await manager.changed(installed, installed.hash)).toBe('lib/helper.txt is missing')
  })

  it('reports when the registry changes how the installed version starts, without changing the receipt', async () => {
    const server = await downloads({ 'demo.tar.gz': archive })
    const { registry, installs, env } = setup()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    const manager = installs('p1')
    const installed = await manager.install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    expect(manager.advisory(installed)).toBeUndefined()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`, { args: ['--acp', '--experimental'] })
    expect(manager.advisory(installed)).toMatch(/starts this version differently/)
    expect(manager.installed(binarySource())!.receipt.launch.args).toEqual(['--acp'])
    // A newer registry version is an update, not a change to this one.
    registry.current = agent('2.0.0', `${server.base}/archive/demo.tar.gz`, { args: ['--other'] })
    expect(manager.advisory(installed)).toBeUndefined()
  })

  it('asks for consent for every new unverified download', async () => {
    const server = await downloads({ 'demo.tar.gz': archive, 'demo-2.tar.gz': archive })
    const { registry, installs, env } = setup()
    const url = `${server.base}/archive/demo.tar.gz`
    registry.current = agent('1.0.0', url, { sha256: null })
    const manager = installs('p1')
    await expect(manager.install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })).rejects.toBeInstanceOf(ConsentRequiredError)
    await expect(manager.install({ instanceId: 'acp:demo', source: binarySource('1.0.0', { version: '1.0.0', artifactUrl: `${url}?other` }), env, label: 'Demo', onProgress: () => {} })).rejects.toBeInstanceOf(ConsentRequiredError)
    const installed = await manager.install({ instanceId: 'acp:demo', source: binarySource('1.0.0', { version: '1.0.0', artifactUrl: url }), env, label: 'Demo', onProgress: () => {} })
    expect(installed.receipt).toMatchObject({ checksum: 'none', consentedAt: expect.any(String) })
    expect(installed.receipt.expected).toBeUndefined()
    // An update to another unverified download: the old consent does not cover it.
    registry.current = agent('1.1.0', `${server.base}/archive/demo-2.tar.gz`, { sha256: null })
    await expect(manager.install({ instanceId: 'acp:demo', source: binarySource('1.1.0', { version: '1.0.0', artifactUrl: url }), env, label: 'Demo', onProgress: () => {} })).rejects.toBeInstanceOf(ConsentRequiredError)
  })

  it('shares one copy between profiles under the agent lock, and takes over a stale lock', async () => {
    const server = await downloads({ 'demo.tar.gz': archive })
    const { registry, installs, env, agentDir } = setup()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    const [first, second] = await Promise.all([
      installs('p1').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} }),
      installs('p2').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    ])
    expect(second.root).toBe(first.root)
    expect(second.hash).toBe(first.hash)
    expect(readdirSync(join(agentDir, 'refs')).sort()).toEqual(['p1.json', 'p2.json'])
    // A third install finds the published copy and downloads nothing.
    const hits = server.hits.length
    await installs('p1').install({ instanceId: 'acp:other', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    expect(server.hits.length).toBe(hits)

    // The lock is SQLite's write lock on a file that stays.
    expect(existsSync(join(agentDir, 'lock.db'))).toBe(true)
  })

  it('deletes downloaded files unless another listed profile uses them; a deleted profile keeps nothing alive', async () => {
    const server = await downloads({ 'demo.tar.gz': archive })
    const { registry, installs, env, listed } = setup()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    const installed = await installs('p1').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    await installs('p2').install({ instanceId: 'acp:work', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    expect(await installs('p1').removeInstall({ instanceId: 'acp:demo', source: binarySource(), force: false }))
      .toEqual({ removed: false, usedBy: [{ profileId: 'p2', profileName: 'Work', entries: 1 }] })
    expect(existsSync(installed.root)).toBe(true)
    // p2 is deleted: its reference no longer counts.
    listed.profiles = [{ id: 'p1', displayName: 'Personal' }]
    expect(await installs('p1').removeInstall({ instanceId: 'acp:demo', source: binarySource(), force: false })).toEqual({ removed: true, bytes: installed.receipt.bytes })
    expect(existsSync(installed.root)).toBe(false)

    // "Delete anyway" over a live reference.
    listed.profiles = [{ id: 'p1' }, { id: 'p2', displayName: 'Work' }]
    const again = await installs('p1').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    const running = installs('p1').track(again.root)
    await expect(installs('p1').removeInstall({ instanceId: 'acp:demo', source: binarySource(), force: true })).rejects.toThrow(/still running/)
    running()
    expect(await installs('p1').removeInstall({ instanceId: 'acp:demo', source: binarySource(), force: true })).toMatchObject({ removed: true })
    expect(existsSync(again.root)).toBe(false)
  })

  it('ignores a reference this profile kept for an entry it no longer has', async () => {
    const server = await downloads({ 'demo.tar.gz': archive })
    const live = { ids: ['acp:demo', 'acp:gone'] }
    const { registry, installs, env } = setup({ liveInstances: () => live.ids })
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    const installed = await installs('p1').install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    await installs('p1').install({ instanceId: 'acp:gone', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    expect(await installs('p1').removeInstall({ instanceId: 'acp:demo', source: binarySource(), force: false })).toMatchObject({ removed: false })
    // `acp:gone` was removed without letting go of its reference (a lock timeout, a crash).
    live.ids = ['acp:demo']
    expect(await installs('p1').removeInstall({ instanceId: 'acp:demo', source: binarySource(), force: false })).toEqual({ removed: true, bytes: installed.receipt.bytes })
  })

  it('deletes the version an update replaced once no process and no other entry uses it', async () => {
    const server = await downloads({ 'demo.tar.gz': archive, 'demo-2.tar.gz': archive })
    const { registry, installs, env, agentDir } = setup()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    const manager = installs('p1')
    const v1 = await manager.install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    const v1Other = await manager.install({ instanceId: 'acp:pinned', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    expect(v1Other.root).toBe(v1.root)
    const running = manager.track(v1.root)
    registry.current = agent('1.1.0', `${server.base}/archive/demo-2.tar.gz`)
    await manager.install({ instanceId: 'acp:demo', source: binarySource('1.1.0'), env, label: 'Demo', onProgress: () => {} })
    await manager.install({ instanceId: 'acp:pinned', source: binarySource('1.1.0'), env, label: 'Demo', onProgress: () => {} })
    // Still running here: kept, and recorded for the next start.
    expect(existsSync(v1.root)).toBe(true)
    expect(JSON.parse(readFileSync(join(agentDir, 'pending-delete.json'), 'utf8'))).toEqual([{ version: '1.0.0', platform: KEY }])
    running()
    expect(existsSync(v1.root)).toBe(false)
    expect(existsSync(join(agentDir, '1.1.0', KEY, 'receipt.json'))).toBe(true)
  })

  it('keeps an old version another profile reuses while it waited to be deleted', async () => {
    const server = await downloads({ 'demo.tar.gz': archive, 'demo-2.tar.gz': archive })
    const { registry, installs, env } = setup()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    const p1 = installs('p1')
    const v1 = await p1.install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    const running = p1.track(v1.root)
    registry.current = agent('1.1.0', `${server.base}/archive/demo-2.tar.gz`)
    await p1.install({ instanceId: 'acp:demo', source: binarySource('1.1.0'), env, label: 'Demo', onProgress: () => {} })
    expect(existsSync(v1.root)).toBe(true)
    // p2 adds the old version while p1's process still runs from it: it reuses the published copy.
    const reused = await installs('p2').install({ instanceId: 'acp:old', source: binarySource('1.0.0'), env, label: 'Demo', onProgress: () => {} })
    expect(reused.root).toBe(v1.root)
    running()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(existsSync(join(v1.root, 'receipt.json'))).toBe(true)
  })

  it('rejects a download whose file fails, and leaves nothing open', async () => {
    const body = Buffer.alloc(128 * 1024, 7)
    const fetchFile = (async () => new Response(body, { headers: { 'content-length': String(body.length) } })) as unknown as typeof fetch
    const { home } = setup()
    await expect(downloadArtifact('https://example.com/a.zip', join(home, 'missing', 'folder', 'a.zip'), { fetch: fetchFile, label: 'Demo' })).rejects.toThrow(/ENOENT/)
    // A cancel while the file is being written rejects too, and the file is closed afterwards.
    const controller = new AbortController()
    const slow = (async () => new Response(new ReadableStream({
      pull(stream) {
        stream.enqueue(new Uint8Array(64 * 1024))
        controller.abort(new Error('Install cancelled'))
      }
    }))) as unknown as typeof fetch
    const target = join(home, 'b.zip')
    await expect(downloadArtifact('https://example.com/b.zip', target, { fetch: slow, label: 'Demo', signal: controller.signal })).rejects.toThrow(/cancelled/)
    rmSync(target, { force: true })
    expect(existsSync(target)).toBe(false)
  })

  it('holds the agent lock for one caller at a time in this process, through async work', async () => {
    const { home } = setup()
    const lock = join(home, 'agents', 'demo-agent', 'lock.db')
    const order: string[] = []
    let release: () => void = () => {}
    const first = withLock(lock, async () => {
      order.push('first in')
      await new Promise<void>((resolve) => { release = resolve })
      order.push('first out')
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    // A second profile in the same daemon waits, and gives up at its deadline.
    await expect(withLock(lock, () => order.push('never'), { timeoutMs: 120, pollMs: 20 })).rejects.toBeInstanceOf(LockBusyError)
    const second = withLock(lock, () => order.push('second'), { timeoutMs: 5_000, pollMs: 20 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first in', 'first out', 'second'])
    // A throw inside releases the lock too.
    await expect(withLock(lock, () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withLock(lock, () => 'free', { timeoutMs: 200 })).resolves.toBe('free')
  })

  it('applies the registry rules to the receipt launch again when an agent starts', async () => {
    const server = await downloads({ 'demo.tar.gz': archive })
    const { registry, installs, env } = setup()
    registry.current = agent('1.0.0', `${server.base}/archive/demo.tar.gz`)
    const manager = installs('p1')
    const installed = await manager.install({ instanceId: 'acp:demo', source: binarySource(), env, label: 'Demo', onProgress: () => {} })
    const edited = { ...installed, receipt: { ...installed.receipt, launch: { ...installed.receipt.launch, args: ['--acp', 5 as unknown as string], env: { PATH: '/evil', NODE_OPTIONS: '--require x', DEMO_MODE: 'acp' } } } }
    expect(manager.launch(edited, env)).toMatchObject({ args: ['--acp'], env: { DEMO_MODE: 'acp' } })
  })

  it('removes staging folders of installs whose process is gone at the next start', async () => {
    const { installs, agentDir } = setup()
    mkdirSync(join(agentDir, '.staging-dead'), { recursive: true })
    writeFileSync(join(agentDir, '.staging-dead', 'owner.json'), JSON.stringify({ pid: 2_147_483_646 }))
    mkdirSync(join(agentDir, '.staging-fresh'), { recursive: true })
    installs('p1').sweep()
    expect(stagingLeft(agentDir)).toEqual(['.staging-fresh'])
  })
})

describe('npm agent installs', () => {
  const packageDir = (prefix: string) => (process.platform === 'win32' ? join(prefix, 'node_modules', 'demo-npm') : join(prefix, 'lib', 'node_modules', 'demo-npm'))
  const npmAgent: RegistryAgent = { id: 'demo-npm', name: 'Demo npm', version: '2.0.0', description: '', authors: [], distribution: { npx: { package: 'demo-npm@2.0.0', args: ['--acp'], env: {} } } }
  const npxSource: RegistrySource = { kind: 'registry', agentId: 'demo-npm', version: '2.0.0', distribution: 'npx' }
  const REGISTRY = 'https://npm.test/'
  const tarball = tarGzOf([{ name: 'package/package.json', data: '{"name":"demo-npm","version":"2.0.0"}' }])
  const sha512 = createHash('sha512').update(tarball).digest('base64')

  /** The npm registry: this version's metadata and its tarball. */
  function npmRegistry(options: { integrity?: string; tarballUrl?: string } = {}) {
    const requests: string[] = []
    const fetchFile = (async (url: string) => {
      requests.push(url)
      if (url === `${REGISTRY}demo-npm/2.0.0`)
        return Response.json({ name: 'demo-npm', version: '2.0.0', dist: { integrity: options.integrity ?? `sha512-${sha512} sha1-abc`, tarball: options.tarballUrl ?? `${REGISTRY}demo-npm/-/demo-npm-2.0.0.tgz` } })
      if (url === `${REGISTRY}demo-npm/-/demo-npm-2.0.0.tgz`) return new Response(tarball, { headers: { 'content-length': String(tarball.length) } })
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch
    return { fetch: fetchFile, requests }
  }

  /** npm as a fake: writes the package (and whatever `extra` adds) under the prefix. */
  function fakeNpm(calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }>, extra?: (pkg: string) => void, version = '2.0.0'): NpmRunner {
    return async (args, options) => {
      calls.push({ args, env: options.env.env, cwd: options.cwd })
      const prefix = args[args.indexOf('--prefix') + 1]!
      mkdirSync(join(packageDir(prefix), 'bin'), { recursive: true })
      writeFileSync(join(packageDir(prefix), 'package.json'), JSON.stringify({ name: 'demo-npm', version, bin: { 'demo-npm': 'bin/cli.js' } }))
      writeFileSync(join(packageDir(prefix), 'bin', 'cli.js'), 'console.log(1)\n')
      extra?.(packageDir(prefix))
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
  }

  function npmSetup(npm: NpmRunner, registryOptions: Parameters<typeof npmRegistry>[0] = {}) {
    const served = npmRegistry(registryOptions)
    const base = setup({ npm, fetch: served.fetch, npmRegistry: REGISTRY })
    base.registry.current = npmAgent
    return { ...base, served }
  }

  it('checks the package against the npm registry sha512, then installs it with npm isolated from the user setup', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = []
    const { installs, env, served } = npmSetup(fakeNpm(calls))
    // The user's own npm setup: a saved token in their .npmrc and registry overrides.
    const userHome = mkdtempSync(join(tmpdir(), 'mousse-user-home-'))
    dirs.push(userHome)
    writeFileSync(join(userHome, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_SAVEDSECRET\n@demo:registry=https://evil.example/\n')
    const installed = await installs('p1').install({
      instanceId: 'acp:npm', source: npxSource, label: 'Demo npm', onProgress: () => {},
      env: {
        ...env,
        env: {
          ...env.env, HOME: userHome, USERPROFILE: userHome, NPM_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k',
          npm_config_registry: 'https://evil.example/', 'npm_config_@demo:registry': 'https://evil.example/',
          NPM_CONFIG_USERCONFIG: join(userHome, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(userHome, '.npmrc'), npm_config__authToken: 't'
        }
      }
    })
    expect(served.requests).toEqual([`${REGISTRY}demo-npm/2.0.0`, `${REGISTRY}demo-npm/-/demo-npm-2.0.0.tgz`])
    expect(calls).toHaveLength(1)
    const { args, env: npmEnv, cwd } = calls[0]!
    expect(args).toEqual(expect.arrayContaining(['install', '--global', '--prefix', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`]))
    // npm installs the tarball Mousse checked, not a name it would look up itself.
    expect(args.at(-1)).toMatch(/package\.tgz$/)
    const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))!.slice(name.length + 3)
    expect(npmEnv.NPM_CONFIG_USERCONFIG).toBe(flag('userconfig'))
    expect(npmEnv.NPM_CONFIG_GLOBALCONFIG).toBe(flag('globalconfig'))
    expect(npmEnv.NPM_CONFIG_CACHE).toBe(flag('cache'))
    for (const name of Object.keys(npmEnv)) if (/^npm_config_/i.test(name)) expect(['NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_UPDATE_NOTIFIER'], name).toContain(name)
    expect(npmEnv.HOME).not.toBe(userHome)
    expect(npmEnv.USERPROFILE).toBe(npmEnv.HOME)
    expect(cwd.startsWith(userHome)).toBe(false)
    expect(npmEnv.NPM_TOKEN).toBeUndefined()
    expect(npmEnv.ANTHROPIC_API_KEY).toBeUndefined()
    expect(installed.receipt).toMatchObject({
      distribution: 'npx', platform: 'node', checksum: 'registry', artifactUrl: 'demo-npm@2.0.0',
      finalUrl: `${REGISTRY}demo-npm/-/demo-npm-2.0.0.tgz`, expected: { algorithm: 'sha512', digest: sha512 },
      launch: { runner: 'node', args: ['--acp'] }
    })
    expect(installed.receipt.launch.cmd).toMatch(/node_modules\/demo-npm\/bin\/cli\.js$/)
    // Nothing of the npm setup Mousse made, nor the tarball, is part of the install or published.
    expect(Object.keys(installed.receipt.files).every((file) => file.includes('demo-npm'))).toBe(true)
    expect(readdirSync(installed.root).sort()).toEqual(['dist', 'receipt.json'])
    expect(existsSync(join(calls[0]!.cwd))).toBe(false)
    const launch = installs('p1').launch(installed, { env: process.env, searchPath: [] })
    expect(launch.args[launch.args.length - 2]).toBe(launch.path)
    expect(launch.path).toMatch(/cli\.js$/)
  })

  it('refuses a package that misses the npm registry sha512, comes from another host, or has no sha512', async () => {
    for (const [registryOptions, message] of [
      [{ integrity: `sha512-${createHash('sha512').update('other').digest('base64')}` }, /does not match the npm registry checksum/],
      [{ tarballUrl: 'https://evil.example/demo-npm-2.0.0.tgz' }, /served from evil\.example/],
      [{ integrity: 'sha1-abc' }, /publishes no sha512/]
    ] as const) {
      const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = []
      const { installs, env, agentDir } = npmSetup(fakeNpm(calls), registryOptions)
      await expect(installs('p1').install({ instanceId: 'acp:npm', source: npxSource, env, label: 'Demo npm', onProgress: () => {} })).rejects.toThrow(message)
      expect(calls).toEqual([])
      expect(stagingLeft(agentDir)).toEqual([])
    }
  })

  it('refuses a package npm installed at another version, and reports npm failures', async () => {
    const one = npmSetup(fakeNpm([], undefined, '9.9.9'))
    await expect(one.installs('p1').install({ instanceId: 'acp:npm', source: npxSource, env: one.env, label: 'Demo npm', onProgress: () => {} })).rejects.toThrow(/9\.9\.9, not 2\.0\.0/)
    const failing = npmSetup(async () => ({ code: 1, stdout: '', stderr: 'npm ERR! 404 Not Found', timedOut: false }))
    await expect(failing.installs('p1').install({ instanceId: 'acp:npm', source: npxSource, env: failing.env, label: 'Demo npm', onProgress: () => {} })).rejects.toThrow(/npm failed: npm ERR! 404/)
    expect(stagingLeft(failing.agentDir)).toEqual([])
  })

  it('refuses a dependency linked from outside the install, at install and at launch, and checks linked files inside it', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'mousse-outside-dep-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'index.js'), 'module.exports = 1\n')
    // A `file:` dependency npm links to its source folder (a junction on Windows).
    const linked = npmSetup(fakeNpm([], (pkg) => {
      mkdirSync(join(pkg, 'node_modules'), { recursive: true })
      symlinkSync(outside, join(pkg, 'node_modules', 'dep'), 'junction')
    }))
    await expect(linked.installs('p1').install({ instanceId: 'acp:npm', source: npxSource, env: linked.env, label: 'Demo npm', onProgress: () => {} })).rejects.toThrow(/node_modules\/dep links outside the install/)
    expect(stagingLeft(linked.agentDir)).toEqual([])

    // An absolute link inside the staging folder would dangle once published: refused.
    const absolute = npmSetup(fakeNpm([], (pkg) => {
      mkdirSync(join(pkg, 'lib'), { recursive: true })
      mkdirSync(join(pkg, 'node_modules'), { recursive: true })
      symlinkSync(join(pkg, 'lib'), join(pkg, 'node_modules', 'alias'), 'junction')
    }))
    await expect(absolute.installs('p1').install({ instanceId: 'acp:npm', source: npxSource, env: absolute.env, label: 'Demo npm', onProgress: () => {} })).rejects.toThrow(/node_modules\/alias is an absolute link/)

    // A relative link inside the install is kept; the files it points at are hashed where they are.
    // (Windows without the symlink privilege cannot make one; npm makes these on POSIX only.)
    try {
      symlinkSync('index.js', join(outside, 'probe-link'))
    } catch {
      return
    }
    const internal = npmSetup(fakeNpm([], (pkg) => {
      mkdirSync(join(pkg, 'lib'), { recursive: true })
      writeFileSync(join(pkg, 'lib', 'impl.js'), 'module.exports = 2\n')
      mkdirSync(join(pkg, 'node_modules'), { recursive: true })
      symlinkSync(join('..', 'lib'), join(pkg, 'node_modules', 'alias'), 'dir')
    }))
    const manager = internal.installs('p1')
    const installed = await manager.install({ instanceId: 'acp:npm', source: npxSource, env: internal.env, label: 'Demo npm', onProgress: () => {} })
    const pkg = packageDir(join(installed.root, 'dist'))
    expect(await manager.changed(installed, installed.hash)).toBeUndefined()
    writeFileSync(join(pkg, 'lib', 'impl.js'), 'module.exports = 3\n')
    expect(await manager.changed(installed, installed.hash)).toMatch(/lib\/impl\.js changed/)
    writeFileSync(join(pkg, 'lib', 'impl.js'), 'module.exports = 2\n')
    // The internal link swapped for one to outside: the next launch refuses it.
    rmSync(join(pkg, 'node_modules', 'alias'), { recursive: false, force: true })
    symlinkSync(outside, join(pkg, 'node_modules', 'alias'), 'junction')
    expect(await manager.changed(installed, installed.hash)).toMatch(/node_modules\/alias links outside the install/)
  })

  it('runs npm on Windows as Node with the npm-cli.js beside it, else an npm.exe launcher, never the shell script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-npm-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'node.exe'), 'MZ', { mode: 0o755 })
    writeFileSync(join(dir, 'npm'), '#!/bin/sh', { mode: 0o755 })
    const volta = resolveNpm({ env: { PATH: dir }, searchPath: [] }, 'win32')
    expect(volta).toBeUndefined()
    writeFileSync(join(dir, 'npm.exe'), 'MZ', { mode: 0o755 })
    expect(resolveNpm({ env: { PATH: dir }, searchPath: [] }, 'win32')).toMatchObject({ command: join(dir, 'npm.exe') })
    mkdirSync(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
    const npm = resolveNpm({ env: { PATH: dir }, searchPath: [] }, 'win32')
    expect(npm).toEqual({ path: join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), command: join(dir, 'node.exe'), args: [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')] })
  })

  it('runs the package command named after the agent, else after the package, else its only one', () => {
    expect(packageBin({ bin: 'cli.js' }, 'demo', 'demo')).toBe('cli.js')
    expect(packageBin({ bin: { other: 'a.js' } }, 'demo', 'demo')).toBe('a.js')
    expect(packageBin({ bin: { helper: 'h.js', 'demo-agent': 'a.js', demo: 'p.js' } }, 'demo-agent', '@scope/demo')).toBe('a.js')
    expect(packageBin({ bin: { helper: 'h.js', demo: 'p.js' } }, 'demo-agent', '@scope/demo')).toBe('p.js')
    expect(packageBin({ bin: { helper: 'h.js', tool: 't.js' } }, 'demo-agent', '@scope/demo')).toBeUndefined()
  })

  it('keeps credentials and every npm setting of the user out of the npm environment', () => {
    expect(withoutCredentials({ PATH: '/bin', NPM_TOKEN: 'x', GITHUB_TOKEN: 'x', OPENAI_API_KEY: 'x', MY_SECRET: 'x', NODE_AUTH_TOKEN: 'x', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' })
    expect(isolatedNpmEnv({ PATH: '/bin', HOME: '/h', USERPROFILE: '/h', npm_config_registry: 'x', NPM_CONFIG_PREFIX: 'x', 'npm_config_@s:registry': 'x' }, { home: '/m', userconfig: '/m/u', globalconfig: '/m/g', cache: '/m/c' }))
      .toEqual({ PATH: '/bin', HOME: '/m', USERPROFILE: '/m', NPM_CONFIG_USERCONFIG: '/m/u', NPM_CONFIG_GLOBALCONFIG: '/m/g', NPM_CONFIG_CACHE: '/m/c', NPM_CONFIG_UPDATE_NOTIFIER: 'false' })
    expect(sha512Of('sha1-abc sha512-XYZ==')).toBe('XYZ==')
    expect(sha512Of('sha1-abc')).toBeUndefined()
  })
})
