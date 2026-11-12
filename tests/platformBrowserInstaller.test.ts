import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { createManagedBrowserInstaller, detectManagedBrowserPlatform } from '../src/mms/browser/install'
import { stagingRoot } from '../src/mms/browser/install/paths'
import { ensureOwnedDirectory } from '../src/mms/browser/install/fsSafety'
import { extractChromeZip } from '../src/mms/browser/install/archive'

const VERSION_1 = '123.0.0.1'
const VERSION_2 = '124.0.0.2'

interface FixtureServer {
  server: Server
  origin: string
  setVersion(version: string): void
  setPlatform(platform: string): void
  setArchive(archive: Uint8Array): void
  setDelay(ms: number): void
  setInterrupted(value: boolean): void
  fetcher: typeof fetch
  close(): Promise<void>
}

async function fixtureServer(): Promise<FixtureServer> {
  let version = VERSION_1
  let platform = 'linux64'
  let archive = validArchive()
  let delay = 0
  let interrupted = false
  const server = createServer((request, response) => {
    if (request.url?.endsWith('last-known-good-versions-with-downloads.json')) {
      const body = JSON.stringify({ channels: { Stable: { version, revision: 'fixture', downloads: { chrome: [{ platform, url: `http://127.0.0.1:0/chrome/${version}.zip` }] } } } })
      response.writeHead(200, { 'content-type': 'application/json' }).end(body)
      return
    }
    if (request.url?.endsWith('known-good-versions-with-downloads.json')) {
      const body = JSON.stringify({ versions: [{ version, revision: 'fixture', downloads: { chrome: [{ platform, url: `http://127.0.0.1:0/chrome/${version}.zip` }] } }] })
      response.writeHead(200, { 'content-type': 'application/json' }).end(body)
      return
    }
    if (request.url?.startsWith('/chrome/')) {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archive.byteLength) })
      const split = Math.max(1, Math.floor(archive.byteLength / 2))
      response.write(archive.subarray(0, split))
      const finish = () => {
        if (!interrupted) response.end(archive.subarray(split))
      }
      if (delay) setTimeout(finish, delay)
      else finish()
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind')
  const origin = `http://127.0.0.1:${address.port}`
  const routeFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const parsed = new URL(url)
    if (parsed.hostname === 'googlechromelabs.github.io') {
      return fetch(`${origin}${parsed.pathname}`, init).then(async (response) => {
        const body = await response.text()
        return new Response(body.replaceAll('http://127.0.0.1:0', origin), { status: response.status, headers: response.headers })
      })
    }
    if (parsed.hostname === '127.0.0.1' && parsed.port === '0') return fetch(`${origin}${parsed.pathname}`, init)
    return fetch(input, init)
  }
  return {
    server,
    origin,
    setVersion: (next) => { version = next },
    setPlatform: (next) => { platform = next },
    setArchive: (next) => { archive = next },
    setDelay: (next) => { delay = next },
    setInterrupted: (next) => { interrupted = next },
    fetcher: routeFetch,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

function validArchive(): Uint8Array {
  return zipSync({ 'chrome-linux64/chrome': new TextEncoder().encode('#!/bin/sh\necho fixture\n'), 'chrome-linux64/resources.pak': new Uint8Array([1, 2, 3]) })
}

function sha256(value: Uint8Array): string { return createHash('sha256').update(value).digest('hex') }

const roots: string[] = []
const fixtures: FixtureServer[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function setup(): Promise<{ root: string; fixture: FixtureServer; installer: ReturnType<typeof createManagedBrowserInstaller> }> {
  const root = await mkdtemp(join(tmpdir(), 'mousse-managed-browser-'))
  roots.push(root)
  const fixture = await fixtureServer()
  fixtures.push(fixture)
  const installer = createManagedBrowserInstaller(detectManagedBrowserPlatform('linux', 'x64'), async (_path, _signal, expectedVersion) => ({ version: `Chrome/${expectedVersion ?? VERSION_1}` }))
  return { root, fixture, installer }
}

function options(root: string, fixture: FixtureServer, extra: Record<string, unknown> = {}) {
  return { root, fetch: fixture.fetcher, allowedOrigins: [fixture.origin], ...extra }
}

describe('managed browser installer lifecycle', () => {
  it('reports platform support and installs from a real local HTTP archive with verified progress', async () => {
    const { root, fixture, installer } = await setup()
    const progress: string[] = []
    const archive = validArchive()
    const result = await installer.install(options(root, fixture, { expectedSha256: sha256(archive), onProgress: (event) => progress.push(event.phase) }))
    expect(result.metadata.hashVerified).toBe(true)
    expect(progress).toEqual(expect.arrayContaining(['resolving', 'downloading', 'verifying', 'extracting', 'activating', 'complete']))
    expect(await installer.resolveExecutable(root)).toBe(result.executablePath)
    expect((await installer.availability(root)).status).toBe('ready')
    expect(await readFile(result.executablePath, 'utf8')).toContain('fixture')
  })

  it('rejects digest failures and unsafe archive paths without replacing the active version', async () => {
    const { root, fixture, installer } = await setup()
    const archive = validArchive()
    await installer.install(options(root, fixture, { expectedSha256: sha256(archive) }))
    fixture.setVersion(VERSION_2)
    fixture.setArchive(zipSync({ '../escape': new Uint8Array([1]), 'chrome-linux64/chrome': new Uint8Array([1]) }))
    await expect(installer.install(options(root, fixture, { expectedSha256: '0'.repeat(64) }))).rejects.toThrow(/SHA-256 mismatch/)
    fixture.setArchive(zipSync({ '../escape': new Uint8Array([1]), 'chrome-linux64/chrome': new Uint8Array([1]) }))
    await expect(installer.install(options(root, fixture))).rejects.toThrow(/escapes extraction root/)
    expect((await installer.availability(root)).version).toBe(VERSION_1)
  })

  it('cancels an interrupted download and cleans only its owned staging directory', async () => {
    const { root, fixture, installer } = await setup()
    fixture.setDelay(250)
    const controller = new AbortController()
    const pending = installer.install(options(root, fixture, { signal: controller.signal }))
    setTimeout(() => controller.abort(), 30)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(stagingRoot(root)).catch(() => [])).toEqual([])
    expect((await installer.availability(root)).status).toBe('setup-required')
  })

  it('serializes concurrent installs and preserves rollback plus active-session cleanup fencing', async () => {
    const { root, fixture, installer } = await setup()
    await installer.install(options(root, fixture))
    fixture.setVersion(VERSION_2)
    fixture.setDelay(500)
    const first = installer.install(options(root, fixture, { lockWaitMs: 1000 }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(installer.install(options(root, fixture, { lockWaitMs: 0 }))).rejects.toThrow(/busy/)
    await first
    expect((await installer.availability(root)).version).toBe(VERSION_2)
    expect((await installer.rollback(root)).version).toBe(VERSION_1)
    expect(await installer.cleanup(root, { activeSessions: 1, keepVersions: 0 })).toEqual([])
    expect((await installer.cleanup(root, { activeSessions: 0, keepVersions: 0 })).length).toBeGreaterThan(0)
  })

  it('reports unsupported architectures without attempting a download', async () => {
    const unsupported = createManagedBrowserInstaller(detectManagedBrowserPlatform('win32', 'arm64'))
    expect(unsupported.platform().supported).toBe(false)
    await expect(unsupported.install({ root: join(tmpdir(), 'unused') })).rejects.toThrow(/not supported/)
  })

  it('rejects a catalog download whose origin is outside the allowlist', async () => {
    const { installer, fixture } = await setup()
    const fetcher: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('last-known-good')) {
        return new Response(JSON.stringify({ channels: { Stable: { version: VERSION_1, downloads: { chrome: [{ platform: 'linux64', url: 'https://evil.example/chrome.zip' }] } } } }), { status: 200 })
      }
      return fixture.fetcher(input, init)
    }
    await expect(installer.resolveDownload({ fetch: fetcher, allowedOrigins: [fixture.origin] })).rejects.toThrow(/origin is not trusted/)
  })

  it('rejects declared ZIP inflation limits and Windows device or ADS paths before extraction', async () => {
    const { root, fixture, installer } = await setup()
    fixture.setArchive(zipSync({ 'chrome-linux64/chrome': new Uint8Array([1, 2, 3, 4]), 'chrome-linux64/CON:secret': new Uint8Array([1]) }))
    await expect(installer.install(options(root, fixture, { maxExtractedBytes: 4 }))).rejects.toThrow(/portable|declared size/)
    fixture.setArchive(zipSync({ 'chrome-linux64/CON': new Uint8Array([1]) }))
    await expect(installer.install(options(root, fixture))).rejects.toThrow(/reserved device name/)
  })

  it('rejects a managed root that is itself a directory link', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'mousse-managed-root-link-'))
    const target = join(parent, 'target')
    const linkedRoot = join(parent, 'managed')
    await mkdir(target)
    await symlink(target, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(ensureOwnedDirectory(linkedRoot, linkedRoot)).rejects.toThrow(/root is not a real directory/)
      const installer = createManagedBrowserInstaller(detectManagedBrowserPlatform('linux', 'x64'))
      expect(await installer.availability(linkedRoot)).toMatchObject({ status: 'blocked', canInstall: false })
    } finally {
      await unlink(linkedRoot)
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('restores the prior active files when a same-version replacement cannot commit metadata', async () => {
    const { root, fixture, installer } = await setup()
    await installer.install(options(root, fixture))
    const replacement = zipSync({
      'chrome-linux64/chrome': new TextEncoder().encode('#!/bin/sh\necho replacement\n'),
      'mousse-browser.json': new TextEncoder().encode('archive collision')
    })
    fixture.setArchive(replacement)
    await expect(installer.install(options(root, fixture, { expectedSha256: sha256(replacement) }))).rejects.toMatchObject({ code: 'EEXIST' })
    const active = await installer.availability(root)
    expect(active.status).toBe('ready')
    expect(await readFile(active.executablePath!, 'utf8')).toContain('fixture')
  })

  it('reads the active-session fence after catalog resolution and bounds catalog responses', async () => {
    const { root, fixture, installer } = await setup()
    await installer.install(options(root, fixture))
    const replacement = zipSync({ 'chrome-linux64/chrome': new TextEncoder().encode('#!/bin/sh\necho replacement\n') })
    fixture.setArchive(replacement)
    let activeSessions = 0
    const delayedCatalog: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('versions-with-downloads')) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        activeSessions = 1
      }
      return fixture.fetcher(input, init)
    }
    await expect(installer.install(options(root, fixture, {
      fetch: delayedCatalog,
      expectedSha256: sha256(replacement),
      activeSessions: () => activeSessions
    }))).rejects.toThrow(/sessions are using it/)
    expect(await readFile((await installer.availability(root)).executablePath!, 'utf8')).toContain('fixture')

    const oversizedCatalog: typeof fetch = async () => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(16 * 1024 * 1024 + 1) }
    })
    await expect(installer.resolveDownload({ fetch: oversizedCatalog })).rejects.toThrow(/catalog exceeds/)
  })

  it('keeps refusing every symlink entry for Linux and Windows archives', async () => {
    const { root, fixture, installer } = await setup()
    fixture.setArchive(zipSync({
      'chrome-linux64/chrome': new TextEncoder().encode('#!/bin/sh\necho fixture\n'),
      'chrome-linux64/lib': link('chrome')
    }))
    await expect(installer.install(options(root, fixture))).rejects.toThrow(/Archive contains a symlink entry: chrome-linux64\/lib/)
    expect((await installer.availability(root)).status).toBe('setup-required')
  })
})

const MAC_APP = 'chrome-mac-arm64/Google Chrome for Testing.app'
const MAC_FRAMEWORK = `${MAC_APP}/Contents/Frameworks/Google Chrome for Testing Framework.framework`
const S_IFLNK = 0o120755
const S_IFIFO = 0o010644

function link(target: string): [Uint8Array, { os: number; attrs: number }] {
  return [new TextEncoder().encode(target), { os: 3, attrs: S_IFLNK * 0x10000 }]
}

/** Same shape as the real Chrome for Testing macOS archive, links listed before their targets. */
function macArchive(frameworkVersion = '123.0.0.1', extra: Record<string, Uint8Array | [Uint8Array, { os: number; attrs: number }]> = {}): Uint8Array {
  return zipSync({
    [`${MAC_FRAMEWORK}/Resources`]: link('Versions/Current/Resources'),
    [`${MAC_FRAMEWORK}/Libraries`]: link('Versions/Current/Libraries'),
    [`${MAC_FRAMEWORK}/Google Chrome for Testing Framework`]: link('Versions/Current/Google Chrome for Testing Framework'),
    [`${MAC_FRAMEWORK}/Versions/Current`]: link(frameworkVersion),
    [`${MAC_FRAMEWORK}/Versions/${frameworkVersion}/Google Chrome for Testing Framework`]: new Uint8Array([7, 7, 7]),
    [`${MAC_FRAMEWORK}/Versions/${frameworkVersion}/Resources/resources.pak`]: new Uint8Array([1, 2, 3]),
    [`${MAC_FRAMEWORK}/Versions/${frameworkVersion}/Libraries/libEGL.dylib`]: new Uint8Array([4, 5]),
    [`${MAC_APP}/Contents/MacOS/Google Chrome for Testing`]: new TextEncoder().encode('#!/bin/sh\necho mac fixture\n'),
    ...extra
  })
}

async function macSetup(): Promise<{ root: string; fixture: FixtureServer; installer: ReturnType<typeof createManagedBrowserInstaller> }> {
  const context = await setup()
  context.fixture.setPlatform('mac-arm64')
  context.fixture.setArchive(macArchive())
  const installer = createManagedBrowserInstaller(detectManagedBrowserPlatform('darwin', 'arm64'), async (_path, _signal, expectedVersion) => ({ version: `Chrome/${expectedVersion ?? VERSION_1}` }))
  return { ...context, installer }
}

async function treeLinks(directory: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isSymbolicLink()) found.push(join(entry.parentPath, entry.name))
  }
  return found
}

describe.skipIf(process.platform === 'win32')('managed browser installer with the macOS app bundle', () => {
  it('installs a macOS archive whose framework links stay inside the bundle, then replaces and cleans it up', async () => {
    const { root, fixture, installer } = await macSetup()
    const first = await installer.install(options(root, fixture))
    expect((await installer.availability(root)).status).toBe('ready')
    expect(await readFile(first.executablePath, 'utf8')).toContain('mac fixture')
    const versionRoot = join(root, 'versions', `mac-arm64-${VERSION_1}`, MAC_FRAMEWORK)
    expect(await readlink(join(versionRoot, 'Versions/Current'))).toBe('123.0.0.1')
    expect(await readlink(join(versionRoot, 'Resources'))).toBe('Versions/Current/Resources')
    expect([...await readFile(join(versionRoot, 'Resources/resources.pak'))]).toEqual([1, 2, 3])
    expect([...await readFile(join(versionRoot, 'Google Chrome for Testing Framework'))]).toEqual([7, 7, 7])

    // Same-version replacement moves the linked tree aside and back; a newer
    // version followed by cleanup removes the old linked tree.
    await installer.install(options(root, fixture, { expectedSha256: sha256(macArchive()) }))
    fixture.setVersion(VERSION_2)
    fixture.setArchive(macArchive('124.0.0.2'))
    await installer.install(options(root, fixture))
    expect((await installer.availability(root)).version).toBe(VERSION_2)
    const removed = await installer.cleanup(root, { keepVersions: 0 })
    expect(removed).toContain(join(root, 'versions', `mac-arm64-${VERSION_1}`))
    expect(await readdir(stagingRoot(root))).toEqual([])
  })

  const unsafe: Array<[string, Record<string, Uint8Array | [Uint8Array, { os: number; attrs: number }]>, RegExp]> = [
    ['an absolute link target', { [`${MAC_APP}/Contents/escape`]: link('/etc') }, /absolute or not portable/],
    ['a link target that climbs out with ..', { [`${MAC_APP}/Contents/escape`]: link('../../../../outside') }, /outside the extraction root/],
    ['a chain whose second link climbs out through the first', {
      [`${MAC_APP}/Contents/up`]: link('..'),
      // Read as plain text this stays inside (chrome-mac-arm64/escaped); the
      // filesystem follows `up` first and leaves the root.
      [`${MAC_APP}/Contents/escape`]: link('up/../../../escaped')
    }, /outside the extraction root/],
    ['a link later used as a directory to write through', {
      [`${MAC_APP}/Contents/through`]: link('MacOS'),
      [`${MAC_APP}/Contents/through/planted`]: new Uint8Array([1])
    }, /written through a symlink entry/],
    ['a dangling link', { [`${MAC_APP}/Contents/dangling`]: link('Missing/thing') }, /missing from the archive/],
    ['a link loop', { [`${MAC_APP}/Contents/a`]: link('b'), [`${MAC_APP}/Contents/b`]: link('a') }, /too long or loops/],
    ['a link to the extraction root', { [`${MAC_APP}/Contents/top`]: link('../../..') }, /extraction root/],
    ['an entry path that escapes', { '../escape': new Uint8Array([1]) }, /escapes extraction root/],
    ['a FIFO entry', { [`${MAC_APP}/Contents/fifo`]: [new Uint8Array(), { os: 3, attrs: S_IFIFO * 0x10000 }] }, /unsupported file type/]
  ]
  it.each(unsafe)('refuses %s and leaves no link or install behind', async (_label, extra, error) => {
    const { root, fixture, installer } = await macSetup()
    fixture.setArchive(macArchive('123.0.0.1', extra))
    await expect(installer.install(options(root, fixture))).rejects.toThrow(error)
    expect((await installer.availability(root)).status).toBe('setup-required')
    expect(await readdir(stagingRoot(root))).toEqual([])
    expect(await treeLinks(root)).toEqual([])
  })

  it('refuses the same archive shapes when symlinks are not allowed at all', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-managed-browser-link-'))
    roots.push(root)
    await expect(extractChromeZip(macArchive(), join(root, 'out'), { maxEntries: 100, maxExtractedBytes: 1024 * 1024 })).rejects.toThrow(/Archive contains a symlink entry/)
    expect(await treeLinks(root)).toEqual([])
  })

  it('removes links it created when the on-disk check refuses the tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-managed-browser-link-'))
    roots.push(root)
    const out = join(root, 'out')
    // Occupy a path a link needs so creation fails midway through.
    await mkdir(join(out, MAC_FRAMEWORK, 'Libraries'), { recursive: true })
    await expect(extractChromeZip(macArchive(), out, { maxEntries: 100, maxExtractedBytes: 1024 * 1024, allowContainedSymlinks: true })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await treeLinks(out)).toEqual([])
  })
})
