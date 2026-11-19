import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as createTar } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activeNativeRuntime, installNativeAntigravity, nativeRoot, verifyNativeHandshake, type NativeInstallOptions, type NativeVerifier
} from '../src/mms/harness/acp/presets/antigravity/nativeInstall'
import {
  NATIVE_AGENT_NAME, NATIVE_RELEASES, classifyVendorFeed, isNativeAssetUrl, nativeTarget, type NativeRelease, type NativeTarget
} from '../src/mms/harness/acp/presets/antigravity/nativeRelease'

// The real install path on a real folder. Only the download and the agent's `initialize` are stood in for.
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const newHome = () => { const home = mkdtempSync(join(tmpdir(), 'mousse-agy-native-')); homes.push(home); return home }

const sha512 = (bytes: Buffer) => createHash('sha512').update(bytes).digest('hex')
const urlFor = (version: string, folder = 'windows-x64', file = 'cli_windows_x64.exe') =>
  `https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-1234/${folder}/${file}`

/** A Windows-style release (the download is the executable) of `version` holding `payload`. */
function exeRelease(version: string, payload: Buffer): NativeRelease {
  return { version, url: urlFor(version), format: 'exe', size: payload.length, executableSize: payload.length, sha512: sha512(payload) }
}
const serve = (payload: Buffer): typeof fetch => vi.fn(async () => new Response(new Uint8Array(payload)))
/** An agent answering `initialize` as Google's CLI of `version`. */
const answers = (version: string, name = NATIVE_AGENT_NAME): NativeVerifier => vi.fn(async () => ({ name, version }))

const target: NativeTarget = 'windows_amd64'
function install(home: string, release: NativeRelease, payload: Buffer, extra: Partial<NativeInstallOptions> = {}) {
  return installNativeAntigravity(home, { release, target, fetch: serve(payload), verify: answers(release.version), freeBytes: () => undefined, ...extra })
}
const activeFile = (home: string) => { const path = join(nativeRoot(home), 'active.json'); return existsSync(path) ? readFileSync(path, 'utf8') : undefined }
const stagingLeft = (home: string) => existsSync(nativeRoot(home)) ? readdirSync(nativeRoot(home)).filter((entry) => entry.startsWith('.stage-')) : []

describe('the reviewed release table', () => {
  it('names a real Google path, size and SHA-512 for every target Google publishes', () => {
    for (const [name, release] of Object.entries(NATIVE_RELEASES)) {
      expect(isNativeAssetUrl(release.url, release.version, name as NativeTarget)).toBe(true)
      expect(release.sha512).toMatch(/^[0-9a-f]{128}$/)
      expect(release.size).toBeGreaterThan(0)
    }
  })

  it.each([
    ['win32', 'x64', false, 'windows_amd64'], ['win32', 'arm64', false, 'windows_arm64'],
    ['darwin', 'x64', false, 'darwin_amd64'], ['darwin', 'arm64', false, 'darwin_arm64'],
    ['linux', 'x64', false, 'linux_amd64'], ['linux', 'arm64', true, 'linux_arm64_musl'],
    ['linux', 'ia32', false, undefined], ['freebsd', 'x64', false, undefined]
  ] as const)('%s %s (musl %s) is %s', (platform, arch, musl, expected) => {
    expect(nativeTarget(platform, arch, musl)).toBe(expected)
  })
})

describe('Google asset URLs', () => {
  it.each([
    ['the exact path', urlFor('1.5.12'), true],
    ['another host', urlFor('1.5.12').replace('storage.googleapis.com', 'storage.example.com'), false],
    ['plain http', urlFor('1.5.12').replace('https:', 'http:'), false],
    ['another version in the path', urlFor('1.5.11'), false],
    ['another system\'s file', urlFor('1.5.12', 'linux-x64', 'cli_linux_x64.tar.gz'), false],
    ['a query string', `${urlFor('1.5.12')}?x=1`, false],
    ['credentials', urlFor('1.5.12').replace('https://', 'https://user@'), false],
    ['an extra folder', urlFor('1.5.12').replace('/windows-x64/', '/windows-x64/x/'), false],
    ['another bucket', urlFor('1.5.12').replace('antigravity-public', 'someone-else'), false]
  ])('%s: %s', (_case, url, expected) => {
    expect(isNativeAssetUrl(url, '1.5.12', 'windows_amd64')).toBe(expected)
  })
})

describe('Google\'s update feed', () => {
  const reviewed = exeRelease('1.5.12', Buffer.from('agent'))
  const entry = (version: string, digest = reviewed.sha512, url = urlFor(version)) => ({ version, url, sha512: digest })
  it.each([
    ['the reviewed release', entry('1.5.12'), { kind: 'reviewed', version: '1.5.12' }],
    ['the reviewed release, digest in capitals', entry('1.5.12', reviewed.sha512.toUpperCase()), { kind: 'reviewed', version: '1.5.12' }],
    ['a newer release', entry('1.6.0', 'a'.repeat(128)), { kind: 'newer', version: '1.6.0' }],
    ['an older release', entry('1.5.11', 'a'.repeat(128)), { kind: 'withdrawn', version: '1.5.11' }],
    ['the same version with another digest', entry('1.5.12', 'b'.repeat(128)), { kind: 'mismatch', version: '1.5.12' }],
    ['a URL off Google\'s path', entry('1.6.0', 'a'.repeat(128), 'https://example.com/agy.exe'), { kind: 'invalid' }],
    ['a short digest', entry('1.6.0', 'abc'), { kind: 'invalid' }],
    ['a pre-release version', entry('1.6.0-rc1', 'a'.repeat(128)), { kind: 'invalid' }],
    ['not an object', ['1.5.12'], { kind: 'invalid' }]
  ])('%s', (_case, raw, expected) => {
    expect(classifyVendorFeed(raw, 'windows_amd64', reviewed)).toEqual(expected)
  })
})

describe('the start-up check of a downloaded CLI', () => {
  // Node stands in for `agy`: started as `node acp --gemini-dir …` in the scratch folder, it runs the
  // `acp` script written there, which answers like the CLI. The check itself runs as shipped.
  const agent = (home: string, reply: string) => {
    const scratch = join(home, 'check')
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, 'acp'), `process.stdin.once('data', (line) => { const { id } = JSON.parse(String(line)); process.stdout.write('not json\\n' + JSON.stringify({ jsonrpc: '2.0', id, ${reply} }) + '\\n') }); setInterval(() => {}, 1000)`)
    return scratch
  }

  it('reads the name and version the agent answers `initialize` with, on a private profile', async () => {
    const home = newHome()
    const scratch = agent(home, `result: { agentInfo: { name: '${NATIVE_AGENT_NAME}', version: '1.5.12' } }`)
    await expect(verifyNativeHandshake(process.execPath, scratch, new AbortController().signal)).resolves.toEqual({ name: NATIVE_AGENT_NAME, version: '1.5.12' })
    expect(existsSync(join(scratch, 'profile'))).toBe(true)
  })

  it('fails when the agent refuses `initialize`', async () => {
    const home = newHome()
    const scratch = agent(home, `error: { code: -32603, message: 'no' }`)
    await expect(verifyNativeHandshake(process.execPath, scratch, new AbortController().signal)).rejects.toThrow(/refused/)
  })
})

describe('installing the native CLI', () => {
  const payload = Buffer.from('agy executable bytes')
  const release = exeRelease('1.5.12', payload)

  it('publishes the verified executable and makes it the active release', async () => {
    const home = newHome()
    const progress = vi.fn()
    const verify = answers('1.5.12')
    const installed = await install(home, release, payload, { verify, progress })
    expect(readFileSync(installed.binary)).toEqual(payload)
    expect(installed.version).toBe('1.5.12')
    expect(activeNativeRuntime(home, target)).toEqual(installed)
    // The check ran on the staged copy, before anything was published.
    expect(vi.mocked(verify).mock.calls[0]?.[0]).toContain('.stage-')
    expect(progress).toHaveBeenCalledWith('Downloading Google Antigravity…')
    expect(stagingLeft(home)).toEqual([])
  })

  it('clears staging an install left when Mousse stopped mid-way', async () => {
    const home = newHome()
    mkdirSync(join(nativeRoot(home), '.stage-left-behind', 'release'), { recursive: true })
    writeFileSync(join(nativeRoot(home), '.stage-left-behind', 'download'), 'partial')
    await install(home, release, payload)
    expect(stagingLeft(home)).toEqual([])
  })

  it('does nothing for the release that is already active', async () => {
    const home = newHome()
    await install(home, release, payload)
    const fetchFile = serve(payload)
    await install(home, release, payload, { fetch: fetchFile })
    expect(fetchFile).not.toHaveBeenCalled()
  })

  // Every row: the install throws, the active release stays as it was, and no staging is left.
  const newer = Buffer.from('newer agy bytes')
  it.each<[string, Partial<NativeInstallOptions> & { release?: NativeRelease; payload?: Buffer }, RegExp]>([
    ['a version Mousse withdrew', { withdrawn: ['1.6.0'] }, /withdrawn/],
    ['a release Google withdrew', { feed: { kind: 'withdrawn', version: '1.5.12' } }, /withdrew/],
    ['a feed that lists other bytes for the version', { feed: { kind: 'mismatch', version: '1.6.0' } }, /different/],
    ['a URL off Google\'s path', { release: { ...exeRelease('1.6.0', newer), url: 'https://example.com/agy.exe' } }, /release path/],
    ['another system\'s file', { release: { ...exeRelease('1.6.0', newer), url: urlFor('1.6.0', 'linux-x64', 'cli_linux_x64.tar.gz') } }, /release path/],
    ['a download larger than reviewed', { payload: Buffer.concat([newer, Buffer.from('x')]) }, /larger/],
    ['a download with other bytes', { payload: Buffer.from('other agy bytes') }, /SHA-512/],
    ['a failed download', { fetch: vi.fn(async () => new Response('gone', { status: 404 })) }, /404/],
    ['an agent reporting another version', { verify: answers('1.5.12') }, /reports/],
    ['an agent with another name', { verify: answers('1.6.0', 'Some Other Agent') }, /reports/],
    ['an agent that cannot start', { verify: vi.fn(async () => { throw new Error('The Antigravity CLI stopped during its start-up check.') }) }, /stopped/],
    ['too little free space', { freeBytes: () => 1024 }, /free to install/]
  ])('refuses %s and keeps the active release', async (_case, options, error) => {
    const home = newHome()
    const first = await install(home, release, payload)
    const before = activeFile(home)
    const next = options.release ?? exeRelease('1.6.0', newer)
    await expect(install(home, next, options.payload ?? newer, { ...options })).rejects.toThrow(error)
    expect(activeFile(home)).toBe(before)
    expect(activeNativeRuntime(home, target)).toEqual(first)
    expect(stagingLeft(home)).toEqual([])
  })

  it('refuses to go back to an older version', async () => {
    const home = newHome()
    await install(home, exeRelease('1.6.0', newer), newer)
    await expect(install(home, release, payload)).rejects.toThrow(/older version/)
    expect(activeNativeRuntime(home, target)?.version).toBe('1.6.0')
  })

  it('stops before publishing when cancelled during the check', async () => {
    const home = newHome()
    const abort = new AbortController()
    const verify: NativeVerifier = vi.fn(async () => { abort.abort(new Error('cancelled')); return { name: NATIVE_AGENT_NAME, version: '1.5.12' } })
    await expect(install(home, release, payload, { verify, signal: abort.signal })).rejects.toThrow('cancelled')
    expect(activeFile(home)).toBeUndefined()
    expect(stagingLeft(home)).toEqual([])
  })

  it('keeps the release before as the last good one, and removes older ones', async () => {
    const home = newHome()
    const one = await install(home, release, payload)
    const two = await install(home, exeRelease('1.6.0', newer), newer)
    expect(JSON.parse(activeFile(home)!)).toMatchObject({ id: two.id, previous: { id: one.id, version: '1.5.12' } })
    expect(existsSync(one.binary)).toBe(true)
    const third = Buffer.from('third agy bytes')
    await install(home, exeRelease('1.7.0', third), third)
    expect(existsSync(one.binary)).toBe(false)
    expect(existsSync(two.binary)).toBe(true)
  })

  it.each([
    ['damaged', (binary: string) => writeFileSync(binary, 'short'), undefined],
    ['missing', (binary: string) => rmSync(binary), undefined],
    ['withdrawn after it was installed', () => undefined, ['1.6.0']]
  ] as const)('runs the last good release when the active one is %s', async (_case, spoil, withdrawn) => {
    const home = newHome()
    const one = await install(home, release, payload)
    const two = await install(home, exeRelease('1.6.0', newer), newer)
    spoil(two.binary)
    expect(activeNativeRuntime(home, target, withdrawn ?? [])).toEqual(one)
  })

  it('accepts a macOS or Linux archive holding only the executable, and refuses any other entry', async () => {
    const make = async (dir: string, files: Record<string, string>) => {
      mkdirSync(dir, { recursive: true })
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
      const archive = join(dir, '..', `${Object.keys(files).join('-')}.tar.gz`)
      await createTar({ gzip: true, file: archive, cwd: dir }, Object.keys(files))
      return readFileSync(archive)
    }
    const linux: NativeTarget = 'linux_amd64'
    const tarRelease = (bytes: Buffer, executableSize: number): NativeRelease => ({
      version: '1.5.12', url: urlFor('1.5.12', 'linux-x64', 'cli_linux_x64.tar.gz'), format: 'tar.gz', size: bytes.length, executableSize, sha512: sha512(bytes)
    })
    const home = newHome()
    const good = await make(join(home, 'src-good'), { antigravity: 'linux agy' })
    const installed = await installNativeAntigravity(home, { release: tarRelease(good, 9), target: linux, fetch: serve(good), verify: answers('1.5.12'), freeBytes: () => undefined })
    expect(readFileSync(installed.binary, 'utf8')).toBe('linux agy')

    const other = newHome()
    const extra = await make(join(other, 'src-extra'), { antigravity: 'linux agy', 'run.sh': 'echo' })
    await expect(installNativeAntigravity(other, { release: tarRelease(extra, 9), target: linux, fetch: serve(extra), verify: answers('1.5.12'), freeBytes: () => undefined })).rejects.toThrow()
    expect(activeNativeRuntime(other, linux)).toBeUndefined()
    expect(stagingLeft(other)).toEqual([])
  })
})
