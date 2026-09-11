import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { createManagedBrowserInstaller, detectManagedBrowserPlatform } from '../src/mms/browser/install'
import { stagingRoot } from '../src/mms/browser/install/paths'

const VERSION_1 = '123.0.0.1'
const VERSION_2 = '124.0.0.2'

interface FixtureServer {
  server: Server
  origin: string
  setVersion(version: string): void
  setArchive(archive: Uint8Array): void
  setDelay(ms: number): void
  setInterrupted(value: boolean): void
  fetcher: typeof fetch
  close(): Promise<void>
}

async function fixtureServer(): Promise<FixtureServer> {
  let version = VERSION_1
  let archive = validArchive()
  let delay = 0
  let interrupted = false
  const server = createServer((request, response) => {
    if (request.url?.endsWith('last-known-good-versions-with-downloads.json')) {
      const body = JSON.stringify({ channels: { Stable: { version, revision: 'fixture', downloads: { chrome: [{ platform: 'linux64', url: `http://127.0.0.1:0/chrome/${version}.zip` }] } } } })
      response.writeHead(200, { 'content-type': 'application/json' }).end(body)
      return
    }
    if (request.url?.endsWith('known-good-versions-with-downloads.json')) {
      const body = JSON.stringify({ versions: [{ version, revision: 'fixture', downloads: { chrome: [{ platform: 'linux64', url: `http://127.0.0.1:0/chrome/${version}.zip` }] } }] })
      response.writeHead(200, { 'content-type': 'application/json' }).end(body)
      return
    }
    if (request.url?.startsWith('/chrome/')) {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(archive.byteLength) })
      response.write(archive.subarray(0, Math.max(1, Math.floor(archive.byteLength / 2))))
      const finish = () => {
        if (!interrupted) response.end(archive.subarray(Math.floor(archive.byteLength / 2)))
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
  const installer = createManagedBrowserInstaller(detectManagedBrowserPlatform('linux', 'x64'))
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
})
