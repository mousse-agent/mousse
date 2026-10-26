/**
 * Managed installs of registry agents (agent CLIs plan §4, v3 B): downloads are checked against
 * the registry checksum, capped and pinned to their host; the receipt records every file and a
 * changed file refuses the launch; an unverified download needs consent for each version; profiles
 * share one copy under the agent's lock; references of deleted profiles keep nothing alive; an old
 * version goes once no process uses it.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InstanceEnv } from '../../src/mms/harness/env'
import { AgentInstalls, ConsentRequiredError, downloadArtifact, resetAgentInstallState, resolveNpm, withoutCredentials, type InstallProgress, type NpmRunner, type RegistrySource } from '../../src/mms/harness/agents/install'
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

function setup(options: { profiles?: Array<{ id: string; displayName?: string }>; npm?: NpmRunner; maxDownloadBytes?: number } = {}) {
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
    ...(options.npm ? { npm: options.npm } : {}),
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

    const lock = join(agentDir, '.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: 0, token: 'held' }))
    await expect(withLock(lock, () => 'never', { timeoutMs: 150, pollMs: 20 })).rejects.toBeInstanceOf(LockBusyError)
    writeFileSync(lock, JSON.stringify({ pid: 2_147_483_646, startedAt: 0, token: 'gone' }))
    await expect(withLock(lock, () => 'taken', { timeoutMs: 150, pollMs: 20 })).resolves.toBe('taken')
    expect(existsSync(lock)).toBe(false)
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

  it('installs with --ignore-scripts and no credentials, and runs the package bin with Node', async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = []
    const npm: NpmRunner = async (args, options) => {
      calls.push({ args, env: options.env.env })
      const prefix = args[args.indexOf('--prefix') + 1]!
      mkdirSync(join(packageDir(prefix), 'bin'), { recursive: true })
      writeFileSync(join(packageDir(prefix), 'package.json'), JSON.stringify({ name: 'demo-npm', version: '2.0.0', bin: { 'demo-npm': 'bin/cli.js' } }))
      writeFileSync(join(packageDir(prefix), 'bin', 'cli.js'), 'console.log(1)\n')
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const { registry, installs, env } = setup({ npm })
    registry.current = npmAgent
    const installed = await installs('p1').install({
      instanceId: 'acp:npm', source: npxSource, label: 'Demo npm', onProgress: () => {},
      env: { ...env, env: { ...env.env, NPM_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k', npm_config__authToken: 't' } }
    })
    expect(calls).toHaveLength(1)
    const { args, env: npmEnv } = calls[0]!
    expect(args).toEqual(expect.arrayContaining(['install', '--global', '--prefix', '--ignore-scripts', '--no-audit', '--no-fund']))
    expect(args.at(-1)).toBe('demo-npm@2.0.0')
    expect(npmEnv.NPM_TOKEN).toBeUndefined()
    expect(npmEnv.ANTHROPIC_API_KEY).toBeUndefined()
    expect(npmEnv.npm_config__authToken).toBeUndefined()
    expect(installed.receipt).toMatchObject({ distribution: 'npx', platform: 'node', checksum: 'registry', artifactUrl: 'demo-npm@2.0.0', launch: { runner: 'node', args: ['--acp'] } })
    expect(installed.receipt.launch.cmd).toMatch(/node_modules\/demo-npm\/bin\/cli\.js$/)
    expect(Object.keys(installed.receipt.files)).toEqual(expect.arrayContaining([expect.stringMatching(/demo-npm\/package\.json$/)]))
    const launch = installs('p1').launch(installed, { env: process.env, searchPath: [] })
    expect(launch.args[launch.args.length - 2]).toBe(launch.path)
    expect(launch.path).toMatch(/cli\.js$/)
  })

  it('refuses a package npm installed at another version, and reports npm failures', async () => {
    const wrong: NpmRunner = async (args) => {
      const prefix = args[args.indexOf('--prefix') + 1]!
      mkdirSync(packageDir(prefix), { recursive: true })
      writeFileSync(join(packageDir(prefix), 'package.json'), JSON.stringify({ name: 'demo-npm', version: '9.9.9', bin: 'cli.js' }))
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const one = setup({ npm: wrong })
    one.registry.current = npmAgent
    await expect(one.installs('p1').install({ instanceId: 'acp:npm', source: npxSource, env: one.env, label: 'Demo npm', onProgress: () => {} })).rejects.toThrow(/9\.9\.9, not 2\.0\.0/)
    const failing = setup({ npm: async () => ({ code: 1, stdout: '', stderr: 'npm ERR! 404 Not Found', timedOut: false }) })
    failing.registry.current = npmAgent
    await expect(failing.installs('p1').install({ instanceId: 'acp:npm', source: npxSource, env: failing.env, label: 'Demo npm', onProgress: () => {} })).rejects.toThrow(/npm failed: npm ERR! 404/)
    expect(stagingLeft(failing.agentDir)).toEqual([])
  })

  it('runs npm on Windows as Node with the npm-cli.js beside it, never the extensionless shell script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-npm-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'node.exe'), 'MZ', { mode: 0o755 })
    writeFileSync(join(dir, 'npm'), '#!/bin/sh', { mode: 0o755 })
    mkdirSync(join(dir, 'node_modules', 'npm', 'bin'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), '')
    const npm = resolveNpm({ env: { PATH: dir }, searchPath: [] }, 'win32')
    expect(npm).toEqual({ path: join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), command: join(dir, 'node.exe'), args: [join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')] })
  })

  it('keeps credentials out of the npm environment', () => {
    expect(withoutCredentials({ PATH: '/bin', NPM_TOKEN: 'x', GITHUB_TOKEN: 'x', OPENAI_API_KEY: 'x', MY_SECRET: 'x', NODE_AUTH_TOKEN: 'x', HOME: '/h' })).toEqual({ PATH: '/bin', HOME: '/h' })
  })
})
