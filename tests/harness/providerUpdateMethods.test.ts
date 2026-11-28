import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { compareVersions, installOwnerOf, updateNeedsElevation, type HarnessDriver } from '../../src/mms/harness/driver'
import { claudeCodeDriver } from '../../src/mms/harness/drivers/claudeCode'
import { codexDriver, codexUpdateEnv } from '../../src/mms/harness/drivers/codex'
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
    '/usr/local/bin/mystery': '/opt/mystery/mystery',
    '/Users/me/.local/bin/codex': '/Users/me/.codex/packages/standalone/releases/0.170.0-aarch64-apple-darwin/bin/codex'
  }
  const realpath = (path: string) => links[path] ?? path

  it('follows a link on PATH to the package manager that owns its target', () => {
    expect(installOwnerOf('/usr/local/bin/codex', 'path', realpath)).toBe('npm')
    expect(installOwnerOf('/opt/homebrew/bin/claude', 'path', realpath)).toBe('brew')
    expect(installOwnerOf('/Users/me/.local/bin/claude', 'path', realpath)).toBe('standalone')
    expect(installOwnerOf('/Users/me/.local/bin/codex', 'path', realpath)).toBe('standalone')
  })

  it('knows the Codex and agy installers\' own folders, Windows ones too', () => {
    expect(installOwnerOf('/Users/me/.codex/packages/standalone/current/bin/codex', 'path', realpath)).toBe('standalone')
    expect(installOwnerOf('C:\\Users\\Me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe', 'path', realpath)).toBe('standalone')
    expect(installOwnerOf('C:\\Users\\Me\\AppData\\Local\\agy\\bin\\agy.exe', 'path', realpath)).toBe('standalone')
    expect(installOwnerOf('/Users/me/.local/bin/agy', 'path', realpath)).toBe('standalone')
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

  // Every install method Mousse tells apart, with the paths each one leaves: the link on PATH, and
  // the file it leads to where that decides. Order matters where one manager runs another's files.
  const ROWS: Array<[string, string | undefined, InstallOwner]> = [
    ['/Users/me/.nix-profile/bin/codex', '/nix/store/abc-codex-0.170.0/bin/codex', 'nix'],
    // mise's npm backend puts node_modules under its installs: still mise's.
    ['/Users/me/.local/share/mise/shims/codex', undefined, 'mise'],
    ['/Users/me/.local/share/mise/installs/npm-openai-codex/0.170.0/lib/node_modules/@openai/codex/bin/codex.js', undefined, 'mise'],
    // A shim links to mise's own program, which Homebrew or mise's installer owns: still mise's.
    ['/Users/me/.local/share/mise/shims/codex', '/opt/homebrew/Cellar/mise/2026.11.1/bin/mise', 'mise'],
    ['/Users/me/.local/share/mise/shims/codex', '/Users/me/.local/bin/mise', 'mise'],
    ['/Users/me/.volta/bin/codex', '/opt/homebrew/Cellar/volta/2.0.2/bin/volta-shim', 'volta'],
    // npm's global folder under a Node mise installed is npm's.
    ['/Users/me/.local/share/mise/installs/node/22.11.0/bin/codex', '/Users/me/.local/share/mise/installs/node/22.11.0/lib/node_modules/@openai/codex/bin/codex.js', 'npm'],
    ['C:\\Users\\Me\\AppData\\Local\\mise\\installs\\node\\22\\codex.cmd', undefined, 'npm'],
    ['/Users/me/.volta/bin/codex', '/Users/me/.volta/tools/image/packages/@openai/codex/lib/node_modules/@openai/codex/bin/codex.js', 'volta'],
    ['C:\\Users\\Me\\AppData\\Local\\Volta\\bin\\codex.exe', undefined, 'volta'],
    ['/Users/me/.yarn/bin/codex', '/Users/me/.config/yarn/global/node_modules/@openai/codex/bin/codex.js', 'yarn'],
    ['C:\\Users\\Me\\AppData\\Local\\Yarn\\bin\\codex.cmd', undefined, 'yarn'],
    // npm run by Homebrew's Node is npm's; a formula's own node_modules (in the Cellar) is Homebrew's.
    ['/opt/homebrew/bin/codex', '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js', 'npm'],
    ['/opt/homebrew/bin/gemini', '/opt/homebrew/Cellar/gemini-cli/0.9.0/libexec/lib/node_modules/@google/gemini-cli/dist/index.js', 'brew'],
    ['/opt/homebrew/bin/codex', '/opt/homebrew/Caskroom/codex/0.170.0/codex-aarch64-apple-darwin', 'brew'],
    ['C:\\Users\\Me\\scoop\\shims\\codex.exe', undefined, 'scoop'],
    ['C:\\Users\\Me\\scoop\\apps\\codex\\current\\codex.exe', undefined, 'scoop'],
    // npm's global folder under Scoop's Node is npm's.
    ['C:\\Users\\Me\\scoop\\apps\\nodejs\\current\\bin\\codex.cmd', undefined, 'npm'],
    ['C:\\ProgramData\\chocolatey\\bin\\codex.exe', undefined, 'choco'],
    ['C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd', undefined, 'npm'],
    ['C:\\Users\\Me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe\\codex.exe', undefined, 'winget'],
    ['C:\\Program Files\\WinGet\\Links\\codex.exe', undefined, 'winget']
  ]

  it.each(ROWS)('%s is %s', (path, target, owner) => {
    expect(installOwnerOf(path, 'path', (link) => (link === path && target ? target : link))).toBe(owner)
  })

  it('needs elevation when the link folder or the package folder is not writable', () => {
    const rootOwned = (path: string) => !path.startsWith('/usr/local')
    expect(updateNeedsElevation('/usr/local/bin/codex', 'npm', { realpath, canWrite: rootOwned, platform: 'darwin' })).toBe(true)
    expect(updateNeedsElevation('/opt/homebrew/bin/claude', 'brew', { realpath, canWrite: rootOwned, platform: 'darwin' })).toBe(false)
    // The npm package folder is checked, not just the bin folder.
    const checked: string[] = []
    updateNeedsElevation('/usr/local/bin/codex', 'npm', { realpath, canWrite: (path) => (checked.push(path), true), platform: 'linux' })
    expect(checked).toEqual(['/usr/local/bin', '/usr/local/lib/node_modules'])
    // Nothing to run for an unknown owner or Mousse's own install.
    expect(updateNeedsElevation('/usr/local/bin/mystery', 'unknown', { realpath, canWrite: () => false, platform: 'linux' })).toBe(false)
  })

  it('on Windows, needs elevation for a machine-wide install under Program Files or ProgramData, and for Chocolatey', () => {
    const win = (path: string, owner: InstallOwner) => updateNeedsElevation(path, owner, { realpath: (link) => link, canWrite: () => true, platform: 'win32' })
    expect(win('C:\\Program Files\\WinGet\\Links\\codex.exe', 'winget')).toBe(true)
    expect(win('C:\\ProgramData\\scoop\\shims\\codex.exe', 'scoop')).toBe(true)
    expect(win('C:\\tools\\chocolatey\\bin\\codex.exe', 'choco')).toBe(true)
    // A user's own install needs no rights, whatever the folder's access check says.
    const userWinget = 'C:\\Users\\Me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe\\codex.exe'
    expect(updateNeedsElevation(userWinget, 'winget', { realpath: (link) => link, canWrite: () => false, platform: 'win32' })).toBe(false)
    expect(win('C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd', 'npm')).toBe(false)
    // nvm-windows links Program Files\nodejs to the user's own folder: where the files are decides.
    const nvm = (link: string) => (link === 'C:\\Program Files\\nodejs\\codex.cmd' ? 'C:\\Users\\Me\\AppData\\Roaming\\nvm\\v22.11.0\\codex.cmd' : link)
    expect(updateNeedsElevation('C:\\Program Files\\nodejs\\codex.cmd', 'npm', { realpath: nvm, canWrite: () => true, platform: 'win32' })).toBe(false)
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

  it('Codex: its own updater for the standalone install, the package manager otherwise', () => {
    const every: InstallOwner[] = ['standalone', 'npm', 'pnpm', 'yarn', 'bun', 'volta', 'brew', 'winget', 'scoop', 'choco', 'mise', 'nix', 'unknown']
    expect(Object.fromEntries(every.map((owner) => [owner, codex.updateCommand?.(owner, undefined, '/opt/homebrew/bin/codex')]))).toEqual({
      standalone: 'codex update',
      npm: 'npm install -g @openai/codex@latest',
      pnpm: 'pnpm add -g @openai/codex@latest',
      yarn: 'yarn global add @openai/codex@latest',
      bun: 'bun add -g @openai/codex@latest',
      volta: 'volta install @openai/codex@latest',
      brew: 'brew upgrade codex',
      winget: 'winget upgrade --id OpenAI.Codex --exact --source winget --silent --accept-source-agreements --accept-package-agreements --disable-interactivity',
      scoop: 'scoop update codex',
      choco: 'choco upgrade codex -y',
      // Nix and mise pin the version in the user's own configuration.
      mise: undefined,
      nix: undefined,
      unknown: undefined
    })
    // Homebrew's cask and formula share the name: the cask's copy upgrades as a cask.
    expect(codex.updateCommand?.('brew', undefined, '/opt/homebrew/Caskroom/codex/0.170.0/codex-aarch64-apple-darwin')).toBe('brew upgrade --cask codex')
  })

  it("Codex: its own updater runs with the home it was installed under, never the entry's private home", () => {
    expect(codexUpdateEnv('standalone', '/Users/me/.codex/packages/standalone/releases/0.170.0/bin/codex')).toEqual({ CODEX_HOME: '/Users/me/.codex' })
    expect(codexUpdateEnv('standalone', 'C:\\Users\\Me\\.codex\\packages\\standalone\\current\\codex.exe')).toEqual({ CODEX_HOME: 'C:\\Users\\Me\\.codex' })
    expect(codexUpdateEnv('standalone', 'C:\\Users\\Me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe')).toBeUndefined()
    expect(codexUpdateEnv('npm', '/Users/me/.codex/packages/standalone/x/codex')).toBeUndefined()
  })
})

describe('the update offered, and the tested range', () => {
  const at = (version: string, owner: InstallOwner, extra: Partial<InstanceBinary> = {}): InstanceBinary => ({ path: '/x/claude', version, source: 'path', owner, ...extra })
  const offer = (binary: InstanceBinary, latest: string, driver: HarnessDriver = claude) => updateAffordance(driver, binary, compatibilityOf(driver, binary.version), latest)

  it('marks a version newer than tested, and still offers it', () => {
    expect(offer(at('2.1.300', 'standalone'), '2.1.320')).toEqual({ kind: 'advisory', command: 'claude update', owner: 'standalone', latestVersion: '2.1.320' })
    expect(offer(at('2.1.300', 'standalone'), '2.2.0')).toEqual({ kind: 'advisory', command: 'claude update', owner: 'standalone', latestVersion: '2.2.0', untested: true })
  })

  it('shows the command to copy when updating needs administrator rights', () => {
    expect(offer(at('0.160.0', 'npm', { needsElevation: true }), '0.165.0', codex))
      .toEqual({ kind: 'advisory', command: 'npm install -g @openai/codex@latest', owner: 'npm', latestVersion: '0.165.0', manual: true })
  })

  it('names who installed it: with the command, or alone when Mousse has none for that owner', () => {
    expect(offer(at('0.160.0', 'winget'), '0.165.0', codex)).toMatchObject({ kind: 'advisory', owner: 'winget', command: expect.stringMatching(/^winget upgrade /) })
    expect(offer(at('0.160.0', 'nix'), '0.165.0', codex)).toEqual({ kind: 'notice', owner: 'nix', latestVersion: '0.165.0' })
    expect(offer(at('0.160.0', 'unknown'), '0.165.0', codex)).toEqual({ kind: 'notice', latestVersion: '0.165.0' })
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
