import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareVersions, installOwnerOf, updateNeedsElevation, type HarnessDriver } from '../../src/mms/harness/driver'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver } from '../../src/mms/harness/drivers/codex'
import { latestSourceFor } from '../../src/mms/harness/gateway'
import { brewInfoVersion, LatestVersionCache } from '../../src/mms/harness/latest'
import { compatibilityOf, updateAffordance } from '../../src/mms/harness/status'
import type { InstallOwner, InstanceBinary } from '../../src/shared/harness/status'

const homes: string[] = []
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const claude = claudeCodeDriver()
const codex = codexDriver({ builtIn: () => ({}) as never })

describe('version comparison', () => {
  it('compares numerically, and a pre-release counts as its release', () => {
    expect(compareVersions('2.1.10', '2.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.167.0', '0.167.999')).toBeLessThan(0)
    expect(compareVersions('2.2.0', '2.1.999')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(0)
  })
})

describe('the install method, from the executable path', () => {
  const links: Record<string, string> = {
    '/usr/local/bin/codex': '/usr/local/lib/node_modules/@openai/codex/bin/codex.js',
    '/opt/homebrew/bin/claude': '/opt/homebrew/Caskroom/claude-code/2.1.300/claude',
    '/Users/me/.local/bin/claude': '/Users/me/.local/share/claude/versions/2.1.300',
    '/usr/local/bin/mystery': '/opt/mystery/mystery'
  }
  const realpath = (path: string) => links[path] ?? path

  it('follows a link on PATH to the package manager that owns its target', () => {
    expect(installOwnerOf('/usr/local/bin/codex', 'path', realpath)).toBe('npm')
    expect(installOwnerOf('/opt/homebrew/bin/claude', 'path', realpath)).toBe('brew')
    expect(installOwnerOf('/Users/me/.local/bin/claude', 'path', realpath)).toBe('standalone')
  })

  it('reads the path itself when there is no link, and says unknown when nothing proves an owner', () => {
    expect(installOwnerOf('/Users/me/.npm-global/lib/node_modules/.bin/codex', 'path', realpath)).toBe('npm')
    expect(installOwnerOf('/Users/me/Library/pnpm/claude', 'path', realpath)).toBe('pnpm')
    expect(installOwnerOf('/Users/me/.bun/bin/claude', 'path', realpath)).toBe('bun')
    expect(installOwnerOf('/home/linuxbrew/.linuxbrew/bin/codex', 'path', realpath)).toBe('brew')
    expect(installOwnerOf('/usr/local/bin/mystery', 'path', realpath)).toBe('unknown')
    expect(installOwnerOf(undefined, 'path', realpath)).toBe('unknown')
    expect(installOwnerOf('/any/where', 'managed', realpath)).toBe('managed')
  })

  it('needs elevation when the link folder or the package folder is not writable, never on Windows', () => {
    const rootOwned = (path: string) => !path.startsWith('/usr/local')
    expect(updateNeedsElevation('/usr/local/bin/codex', 'npm', { realpath, canWrite: rootOwned, platform: 'darwin' })).toBe(true)
    expect(updateNeedsElevation('/opt/homebrew/bin/claude', 'brew', { realpath, canWrite: rootOwned, platform: 'darwin' })).toBe(false)
    expect(updateNeedsElevation('/usr/local/bin/codex', 'npm', { realpath, canWrite: () => false, platform: 'win32' })).toBe(false)
    // The npm package folder is checked, not just the bin folder.
    const checked: string[] = []
    updateNeedsElevation('/usr/local/bin/codex', 'npm', { realpath, canWrite: (path) => (checked.push(path), true), platform: 'linux' })
    expect(checked).toEqual(['/usr/local/bin', '/usr/local/lib/node_modules'])
    // Nothing to run for an unknown owner or Mousse's own install.
    expect(updateNeedsElevation('/usr/local/bin/mystery', 'unknown', { realpath, canWrite: () => false, platform: 'linux' })).toBe(false)
  })
})

describe('the update command per install method', () => {
  const methods: InstallOwner[] = ['standalone', 'npm', 'pnpm', 'bun', 'brew', 'winget', 'unknown']
  it('Claude Code: its own updater for the native install, the package manager otherwise', () => {
    expect(Object.fromEntries(methods.map((owner) => [owner, claude.updateCommand?.(owner)]))).toEqual({
      standalone: 'claude update',
      npm: 'npm install -g @anthropic-ai/claude-code@latest',
      pnpm: 'pnpm add -g @anthropic-ai/claude-code@latest',
      bun: 'bun add -g @anthropic-ai/claude-code@latest',
      brew: 'brew upgrade claude-code',
      winget: undefined,
      unknown: undefined
    })
  })

  it('Codex: the package manager that installed it', () => {
    expect(Object.fromEntries(methods.map((owner) => [owner, codex.updateCommand?.(owner)]))).toEqual({
      standalone: undefined,
      npm: 'npm install -g @openai/codex@latest',
      pnpm: 'pnpm add -g @openai/codex@latest',
      bun: 'bun add -g @openai/codex@latest',
      brew: 'brew upgrade codex',
      winget: undefined,
      unknown: undefined
    })
  })
})

describe('the update offered, and the tested range', () => {
  const at = (version: string, owner: InstallOwner, extra: Partial<InstanceBinary> = {}): InstanceBinary => ({ path: '/x/claude', version, source: 'path', owner, ...extra })
  const offer = (binary: InstanceBinary, latest: string, driver: HarnessDriver = claude) => updateAffordance(driver, binary, compatibilityOf(driver, binary.version), latest)

  it('marks a version newer than tested, and still offers it', () => {
    expect(claude.testedVersions?.max).toBe('2.1.999')
    expect(offer(at('2.1.300', 'standalone'), '2.1.320')).toEqual({ kind: 'advisory', command: 'claude update', latestVersion: '2.1.320' })
    expect(offer(at('2.1.300', 'standalone'), '2.2.0')).toEqual({ kind: 'advisory', command: 'claude update', latestVersion: '2.2.0', untested: true })
  })

  it('shows the command to copy when updating needs administrator rights', () => {
    expect(offer(at('0.160.0', 'npm', { needsElevation: true }), '0.165.0', codex))
      .toEqual({ kind: 'advisory', command: 'npm install -g @openai/codex@latest', latestVersion: '0.165.0', manual: true })
  })
})

describe('where the newest version is read', () => {
  it('Homebrew copies ask Homebrew; everything else asks the driver source', () => {
    expect(latestSourceFor(claude, at('/opt/homebrew/bin/claude', 'brew'))).toMatchObject({ kind: 'brew', name: 'claude-code' })
    expect(latestSourceFor(codex, at('/usr/local/lib/node_modules/.bin/codex', 'npm'))).toEqual({ kind: 'npm', package: '@openai/codex' })
    expect(latestSourceFor(claude, at('/Users/me/.local/bin/claude', 'standalone'))).toEqual({ kind: 'npm', package: '@anthropic-ai/claude-code' })
  })

  it('reads the stable version of a formula or a cask from brew info', () => {
    expect(brewInfoVersion(JSON.stringify({ formulae: [{ versions: { stable: '0.165.0' } }], casks: [] }))).toBe('0.165.0')
    expect(brewInfoVersion(JSON.stringify({ formulae: [], casks: [{ version: '2.1.320,abc123' }] }))).toBe('2.1.320')
    expect(brewInfoVersion('not json')).toBeUndefined()
    expect(brewInfoVersion(JSON.stringify({ formulae: [], casks: [{ version: 'latest' }] }))).toBeUndefined()
  })

  it('caches the Homebrew answer, and keeps quiet when brew fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-brew-latest-'))
    homes.push(dir)
    let now = Date.parse('2026-11-12T00:00:00Z')
    const brewInfo = vi.fn(async (_brew: string, name: string) => JSON.stringify({ casks: [{ version: name === 'claude-code' ? '2.1.320' : 'x' }] }))
    const cache = new LatestVersionCache(dir, { brewInfo, now: () => now, fetchImpl: () => Promise.reject(new Error('no network')) })
    const source = { kind: 'brew' as const, name: 'claude-code', brew: '/opt/homebrew/bin/brew' }
    expect(await cache.refresh(source)).toBe(true)
    expect(cache.get(source)).toBe('2.1.320')
    expect(brewInfo).toHaveBeenCalledWith('/opt/homebrew/bin/brew', 'claude-code', undefined)
    // Within the time to live, no second lookup.
    now += 60_000
    expect(await cache.refresh(source)).toBe(false)
    expect(brewInfo).toHaveBeenCalledTimes(1)
    // A failing brew keeps the last version.
    const failing = new LatestVersionCache(dir, { brewInfo: () => Promise.reject(new Error('brew: command not found')), now: () => now + 7 * 60 * 60_000 })
    expect(await failing.refresh(source)).toBe(false)
    expect(failing.get(source)).toBe('2.1.320')
  })
})

function at(path: string, owner: InstallOwner): InstanceBinary {
  return { path, version: '1.0.0', source: 'path', owner }
}
