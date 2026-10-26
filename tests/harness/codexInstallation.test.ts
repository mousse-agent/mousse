import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACTIVE_FILE, CODEX_STAGING_STALE_MS, CodexInstallation, COMPLETE_FILE } from '../../src/mms/harness/codex/installation'
import { CODEX_MANAGED_VERSION, CODEX_RELEASES, codexReleaseFor, type CodexRelease } from '../../src/mms/harness/codex/release'
import { tarGzOf, type ArchiveEntry } from './archiveFixtures'

const TARGET = 'x86_64-unknown-linux-musl'
const URL = `https://github.com/openai/codex/releases/download/rust-v${CODEX_MANAGED_VERSION}/codex-package-${TARGET}.tar.gz`

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ layoutVersion: 1, version: CODEX_MANAGED_VERSION, target: TARGET, variant: 'codex', entrypoint: 'bin/codex', ...overrides })
}

function packageEntries(options: { skip?: string; manifest?: string } = {}): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [
    { name: 'bin/', type: '5' },
    { name: 'bin/codex', data: '#!/bin/sh\necho codex\n', mode: 0o755 },
    { name: 'bin/codex-code-mode-host', data: 'host', mode: 0o755 },
    { name: 'codex-package.json', data: options.manifest ?? manifest() },
    { name: 'codex-path/', type: '5' },
    { name: 'codex-path/rg', data: 'rg', mode: 0o755 }
  ]
  return entries.filter((entry) => entry.name !== options.skip)
}

function releaseOf(archive: Buffer, overrides: Partial<CodexRelease> = {}): CodexRelease {
  return { version: CODEX_MANAGED_VERSION, target: TARGET, url: URL, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), windows: false, ...overrides }
}

/** Serves `archive` at the release URL; `hold` keeps the body open until it resolves. */
function fakeFetch(archive: Buffer, options: { hold?: Promise<void>; contentLength?: number } = {}): typeof fetch & { calls: number } {
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    fn.calls += 1
    if (String(input) !== URL) return new Response('missing', { status: 404 })
    const signal = init?.signal
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new Uint8Array(archive.subarray(0, Math.min(16, archive.length))))
        if (options.hold) {
          await Promise.race([options.hold, new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))]).catch((error) => controller.error(error))
        }
        try {
          controller.enqueue(new Uint8Array(archive.subarray(16)))
          controller.close()
        } catch {
          // Already errored by the abort.
        }
      }
    })
    return new Response(body, { status: 200, headers: { 'content-length': String(options.contentLength ?? archive.length) } })
  }) as typeof fetch & { calls: number }
  fn.calls = 0
  return fn
}

const okVersion = async () => `codex-cli ${CODEX_MANAGED_VERSION}\n`

describe('Codex release table', () => {
  it('pins every published platform with full digests', () => {
    expect(Object.keys(CODEX_RELEASES).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64'])
    for (const release of Object.values(CODEX_RELEASES)) {
      expect(release.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(release.url).toBe(`https://github.com/openai/codex/releases/download/rust-v0.162.1/codex-package-${release.target}.tar.gz`)
    }
    expect(codexReleaseFor('win32', 'x64')?.windows).toBe(true)
    expect(codexReleaseFor('linux', 'x64')?.target).toBe('x86_64-unknown-linux-musl')
    expect(codexReleaseFor('freebsd', 'x64')).toBeUndefined()
  })
})

describe('CodexInstallation', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'mousse-codex-install-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const codexDir = () => join(home, 'agents', 'codex')

  function installation(archive: Buffer, options: { release?: CodexRelease; fetch?: typeof fetch; runVersion?: (binary: string, signal: AbortSignal) => Promise<string> } = {}) {
    return new CodexInstallation({
      installationHome: home,
      release: options.release ?? releaseOf(archive),
      fetch: options.fetch ?? fakeFetch(archive),
      runVersion: options.runVersion ?? okVersion
    })
  }

  it('downloads, checks and publishes the pinned version', async () => {
    const archive = tarGzOf(packageEntries())
    const install = installation(archive)
    const progress: string[] = []
    const result = await install.install((entry) => progress.push(entry.message))
    expect(result.version).toBe(CODEX_MANAGED_VERSION)
    expect(result.path).toBe(join(codexDir(), CODEX_MANAGED_VERSION, 'bin', 'codex'))
    expect(progress.some((line) => /^Downloading Codex \d+ MB of \d+ MB$/.test(line))).toBe(true)
    const installed = install.installed()
    expect(installed).toMatchObject({ path: result.path, version: CODEX_MANAGED_VERSION })
    expect(installed?.broken).toBeUndefined()
    expect(installed?.bytes).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(join(codexDir(), ACTIVE_FILE), 'utf8'))).toMatchObject({ version: CODEX_MANAGED_VERSION, target: TARGET })
    expect(readdirSync(codexDir()).filter((name) => name.startsWith('.install-'))).toEqual([])
    await expect(install.verify(new AbortController().signal)).resolves.toBeUndefined()
  })

  it('refuses a download whose digest differs, leaving no version folder', async () => {
    const archive = tarGzOf(packageEntries())
    const install = installation(archive, { release: releaseOf(archive, { sha256: '0'.repeat(64) }) })
    await expect(install.install(() => {})).rejects.toThrow(/does not match/)
    expect(existsSync(join(codexDir(), CODEX_MANAGED_VERSION))).toBe(false)
    expect(install.installed()).toBeUndefined()
  })

  it('fails at once when the download is larger than the pinned size', async () => {
    const archive = tarGzOf(packageEntries())
    const install = installation(archive, { release: releaseOf(archive, { bytes: archive.length - 1 }) })
    await expect(install.install(() => {})).rejects.toThrow(/larger than/)
    expect(existsSync(join(codexDir(), CODEX_MANAGED_VERSION))).toBe(false)
  })

  it('fails when a file of the pinned layout is missing', async () => {
    const archive = tarGzOf(packageEntries({ skip: 'codex-path/rg' }))
    await expect(installation(archive).install(() => {})).rejects.toThrow(/codex-path\/rg/)
    expect(existsSync(join(codexDir(), CODEX_MANAGED_VERSION))).toBe(false)
  })

  it('fails when the manifest names another version', async () => {
    const archive = tarGzOf(packageEntries({ manifest: manifest({ version: '0.162.0' }) }))
    await expect(installation(archive).install(() => {})).rejects.toThrow(/not version 0\.162\.1/)
  })

  it('fails when codex --version prints another version', async () => {
    const archive = tarGzOf(packageEntries())
    await expect(installation(archive, { runVersion: async () => 'codex-cli 0.163.0\n' }).install(() => {})).rejects.toThrow(/instead of codex-cli 0\.162\.1/)
    expect(existsSync(join(codexDir(), CODEX_MANAGED_VERSION))).toBe(false)
  })

  it('re-verifies a version already on disk instead of downloading it again', async () => {
    const archive = tarGzOf(packageEntries())
    const fetchFn = fakeFetch(archive)
    const install = installation(archive, { fetch: fetchFn })
    await install.install(() => {})
    expect(fetchFn.calls).toBe(1)
    await install.install(() => {})
    expect(fetchFn.calls).toBe(1)
  })

  it('reports a tampered install and replaces it on the next install', async () => {
    const archive = tarGzOf(packageEntries())
    const fetchFn = fakeFetch(archive)
    const install = installation(archive, { fetch: fetchFn })
    await install.install(() => {})
    const host = join(codexDir(), CODEX_MANAGED_VERSION, 'bin', 'codex-code-mode-host')
    writeFileSync(host, 'tampered')
    await expect(install.verify(new AbortController().signal)).resolves.toMatch(/codex-code-mode-host changed/)
    await install.install(() => {})
    expect(fetchFn.calls).toBe(2)
    expect(readFileSync(host, 'utf8')).toBe('host')
    await expect(install.verify(new AbortController().signal)).resolves.toBeUndefined()
  })

  it('reads a hand-edited active.json naming another version as broken', async () => {
    const archive = tarGzOf(packageEntries())
    const install = installation(archive)
    await install.install(() => {})
    writeFileSync(join(codexDir(), ACTIVE_FILE), JSON.stringify({ version: '0.170.0', target: TARGET, sha256: 'x' }))
    expect(install.installed()?.broken).toMatch(/Reinstall/)
  })

  it('reads an install without its completion record as broken', async () => {
    const archive = tarGzOf(packageEntries())
    const install = installation(archive)
    await install.install(() => {})
    rmSync(join(codexDir(), CODEX_MANAGED_VERSION, COMPLETE_FILE))
    expect(install.installed()?.broken).toMatch(/incomplete/)
  })

  it('cancel deletes the staging folder and keeps the previous version', async () => {
    const archive = tarGzOf(packageEntries())
    const first = installation(archive)
    await first.install(() => {})
    // A tampered copy forces a new download, which is then cancelled midway.
    writeFileSync(join(codexDir(), CODEX_MANAGED_VERSION, 'codex-path', 'rg'), 'changed')
    let release!: () => void
    const hold = new Promise<void>((resolve) => (release = resolve))
    const second = installation(archive, { fetch: fakeFetch(archive, { hold }) })
    const running = second.install(() => {})
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(second.installing()).toBe(true)
    expect(second.cancel()).toBe(true)
    await expect(running).rejects.toThrow()
    release()
    expect(second.installing()).toBe(false)
    expect(readdirSync(codexDir()).filter((name) => name.startsWith('.install-'))).toEqual([])
    expect(existsSync(join(codexDir(), CODEX_MANAGED_VERSION, 'bin', 'codex'))).toBe(true)
    expect(second.installed()?.version).toBe(CODEX_MANAGED_VERSION)
  })

  it('sweeps only staging folders older than a day', () => {
    const archive = tarGzOf(packageEntries())
    const install = installation(archive)
    mkdirSync(join(codexDir(), '.install-old'), { recursive: true })
    mkdirSync(join(codexDir(), '.active-old'), { recursive: true })
    mkdirSync(join(codexDir(), '.install-fresh'), { recursive: true })
    mkdirSync(join(codexDir(), 'keep'), { recursive: true })
    const old = (Date.now() - CODEX_STAGING_STALE_MS - 60_000) / 1000
    utimesSync(join(codexDir(), '.install-old'), old, old)
    utimesSync(join(codexDir(), '.active-old'), old, old)
    install.sweep()
    expect(readdirSync(codexDir()).sort()).toEqual(['.install-fresh', 'keep'])
  })

  it('names an unsupported platform', async () => {
    const install = new CodexInstallation({ installationHome: home, platform: 'freebsd', arch: 'x64' })
    expect(install.unsupportedMessage()).toBe('OpenAI publishes no Codex package for freebsd-x64. Use your own Codex CLI.')
    expect(install.installed()).toBeUndefined()
    await expect(install.install(() => {})).rejects.toThrow(/OpenAI publishes no Codex package/)
  })

  it('refuses to delete files a running app-server holds, then deletes them once it exits', async () => {
    const archive = tarGzOf(packageEntries())
    const install = installation(archive)
    await install.install(() => {})
    const release = install.acquire()
    await expect(install.removeInstall({ force: true })).rejects.toThrow(/still running/)
    expect(existsSync(join(codexDir(), CODEX_MANAGED_VERSION))).toBe(true)
    release()
    const result = await install.removeInstall({ force: false })
    expect(result).toMatchObject({ removed: true })
    expect(existsSync(join(codexDir(), CODEX_MANAGED_VERSION))).toBe(false)
    expect(install.installed()).toBeUndefined()
  })
})
