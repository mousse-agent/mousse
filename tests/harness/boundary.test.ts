import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// The harness boundary (provider abstraction plan §1): app code reaches agents and providers only
// through the harness gateway. Two rules, each with an explicit, owned allowlist.

const repoRoot = resolve(__dirname, '..', '..')

function files(root: string): string[] {
  return readdirSync(join(repoRoot, root), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name))
    .map((entry) => relative(repoRoot, join(entry.parentPath, entry.name)).split(sep).join('/'))
}

/** Every module specifier a file imports (static, dynamic, type-only and re-exports). */
function specifiers(source: string): string[] {
  const found: string[] = []
  for (const pattern of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s+['"]([^'"]+)['"]/gm])
    for (const match of source.matchAll(pattern)) found.push(match[1])
  return found
}

/** A specifier as a repo path (`src/...`) when relative, else the package name. */
function target(file: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier
  return posix.normalize(posix.join(posix.dirname(file), specifier))
}

// -- Rule 1: forbidden modules ---------------------------------------------------------------------

/**
 * Vendor SDKs, vendor protocols and the code that wraps them. Driver modules themselves
 * (`harness/drivers/<kind>.ts`, `harness/drivers/pi/**`) are the gateway's registration seam and
 * stay importable: the orchestrator builds its unbound gateway with the pi driver, and
 * `ProviderAuthService` reads the pi driver's retirement table and one-shot API check.
 */
const FORBIDDEN = [
  /^@anthropic-ai\/claude-agent-sdk/,
  /^@agentclientprotocol\/sdk/,
  // Vendor services and vendor-specific code: Claude Code, Codex (with the managed runtime), the
  // ACP client and its presets (with Antigravity's service), the Cursor host, ChatGPT sign-in, Grok.
  /^src\/mms\/harness\/(vendors|acp|hosts|chatgpt|claude|cursor|grok)\//,
  // The adapters the drivers wrap.
  /^src\/mms\/harness\/drivers\/[^/]+\/adapter$/,
  // Pi's agent as a process: the launcher, the RPC client and Mousse's extension.
  /^src\/mms\/harness\/pi\//
]

/** Who may import them. */
const ALLOWED_IMPORTERS = [/^src\/mms\/harness\//, /^src\/mms\/run\/testkit\//, /^src\/mms\/MmsProfileServices\.ts$/]

describe('harness import boundary', () => {
  const sources = files('src').map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') }))

  it('scans the application sources', () => {
    expect(sources.some(({ path }) => path === 'src/mms/orchestrator/OrchestratorService.ts')).toBe(true)
    expect(sources.some(({ path }) => path.startsWith('src/renderer/'))).toBe(true)
  })

  it('no application code imports vendor SDKs, vendor services or adapters', () => {
    const violations: string[] = []
    for (const { path, source } of sources) {
      if (ALLOWED_IMPORTERS.some((rule) => rule.test(path))) continue
      for (const specifier of specifiers(source)) {
        const resolved = target(path, specifier)
        if (FORBIDDEN.some((rule) => rule.test(resolved))) violations.push(`${path} → ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('the orchestrator imports no vendor service or adapter', () => {
    const orchestrator = sources.find(({ path }) => path === 'src/mms/orchestrator/OrchestratorService.ts')!
    const vendor = specifiers(orchestrator.source).filter((specifier) => /harness\/(vendors|acp)\/|harness\/drivers\/[^/]+\/adapter$/.test(specifier))
    expect(vendor).toEqual([])
  })

  it('only the Cursor host loads the Cursor SDK', () => {
    const violations: string[] = []
    for (const { path, source } of sources) {
      if (CURSOR_SDK_IMPORTERS.some((rule) => rule.test(path))) continue
      for (const specifier of specifiers(source)) if (CURSOR_SDK.test(specifier)) violations.push(`${path} → ${specifier}`)
    }
    expect(violations).toEqual([])
  })

  it('nothing imports the deleted in-process Pi loop', () => {
    const violations: string[] = []
    for (const { path, source } of sources)
      for (const specifier of specifiers(source)) if (/(^|\/)orchestrator\/LlmClient$/.test(target(path, specifier))) violations.push(`${path} → ${specifier}`)
    expect(violations).toEqual([])
  })
})

/**
 * The Cursor SDK keeps process-wide state and leaves rejections nobody awaits: it runs only in
 * the host process (agent CLIs plan §2 "Boundary"). Type-only imports count too.
 */
const CURSOR_SDK = /^(@cursor\/sdk|pi-cursor-sdk)(\/|$)/
const CURSOR_SDK_IMPORTERS = [/^src\/mms\/harness\/hosts\//]

// -- Rule 2: driver-name literals at branch sites --------------------------------------------------

/** Where application branches live. Declarations and data tables are out of scope (plan v3). */
const BRANCH_SCOPES = ['src/renderer/', 'src/mms/orchestrator/', 'src/mms/protocol/', 'src/mms/providers/', 'src/cli/']

const DRIVER_NAMES = ['antigravity', 'claude-subscription', 'codex', 'pi', 'claude', 'acp', 'cursor', 'grok', 'xai']
const NAME = `['"\`](${DRIVER_NAMES.join('|')})['"\`]`
const BRANCH_SITES = [
  new RegExp(`(===|!==|==|!=)\\s*${NAME}`),
  new RegExp(`${NAME}\\s*(===|!==|==|!=)`),
  new RegExp(`\\bcase\\s+${NAME}\\s*:`),
  new RegExp(`\\.(includes|startsWith)\\(\\s*${NAME}\\s*\\)`)
]

/**
 * Files allowed to compare driver names, with the reason or the PR that removes the entry:
 * icons and settings keywords show the vendor.
 */
const LITERAL_ALLOWLIST: Record<string, string> = {
  'src/renderer/lib/providerIcons.tsx': 'icons'
}

function codeLines(source: string): Array<{ line: string; number: number }> {
  return source.split('\n').map((line, index) => ({ line, number: index + 1 })).filter(({ line }) => {
    const trimmed = line.trim()
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
  })
}

/** Every branch site in the branch scopes, as `path:line: code`. */
function branchViolations(sources: Array<{ path: string; source: string }>): string[] {
  const violations: string[] = []
  for (const { path, source } of sources) {
    if (LITERAL_ALLOWLIST[path] || !BRANCH_SCOPES.some((scope) => path.startsWith(scope))) continue
    for (const { line, number } of codeLines(source))
      if (BRANCH_SITES.some((site) => site.test(line))) violations.push(`${path}:${number}: ${line.trim()}`)
  }
  return violations
}

describe('driver-name literals', () => {
  const sources = BRANCH_SCOPES.flatMap((scope) => files(scope)).map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') }))

  it('scans the branch scopes', () => {
    expect(sources.some(({ path }) => path.startsWith('src/mms/protocol/'))).toBe(true)
    expect(sources.some(({ path }) => path.startsWith('src/renderer/'))).toBe(true)
    expect(sources.some(({ path }) => path === 'src/mms/providers/ProviderAuthService.ts')).toBe(true)
  })

  it('no application branch compares a driver or legacy provider name', () => {
    expect(branchViolations(sources)).toEqual([])
  })

  it('fails on a provider-name comparison planted in the vendor-neutral provider code', () => {
    const planted = { path: 'src/mms/providers/planted.ts', source: `export const isPi = (driver: string) => driver === 'pi'\n` }
    expect(branchViolations([...sources, planted])).toEqual([`src/mms/providers/planted.ts:1: export const isPi = (driver: string) => driver === 'pi'`])
  })

  it('catches the shapes it is meant to catch', () => {
    const hit = (line: string) => BRANCH_SITES.some((site) => site.test(line))
    expect(hit(`if (providerId === 'claude-subscription') return`)).toBe(true)
    expect(hit(`case 'antigravity':`)).toBe(true)
    expect(hit(`if (['x'].includes('codex'))`)).toBe(true)
    expect(hit(`instanceId.startsWith('pi')`)).toBe(true)
    expect(hit(`const LABELS = { codex: 'Codex' }`)).toBe(false)
    expect(hit(`if (caps.planMode) return`)).toBe(false)
  })

  it('every allowlisted file still exists', () => {
    for (const path of Object.keys(LITERAL_ALLOWLIST)) expect(readdirSync(join(repoRoot, dirname(path))).includes(path.split('/').at(-1)!), path).toBe(true)
  })
})
