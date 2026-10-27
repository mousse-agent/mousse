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

/** Vendor SDKs, vendor protocols and the code that wraps them. */
const FORBIDDEN = [
  /^@anthropic-ai\/claude-agent-sdk/,
  /^@agentclientprotocol\/sdk/,
  /^src\/mms\/providers\/(claudeSubscription|codex|antigravity)\//,
  // The adapters the drivers wrap. `run/adapters/shared/*` is the vendor-neutral context-overflow
  // retry the orchestrator still uses.
  /^src\/mms\/run\/adapters\/(?!shared\/)/,
  // Pi's agent as a process: the launcher, the RPC client and Mousse's extension.
  /^src\/mms\/harness\/pi\//
]

/** Who may import them. */
const ALLOWED_IMPORTERS = [
  /^src\/mms\/harness\//,
  /^src\/mms\/run\/adapters\//,
  /^src\/mms\/providers\//,
  /^src\/mms\/run\/testkit\//,
  /^src\/mms\/MmsProfileServices\.ts$/
]

/** Listed exceptions, each with the PR that removes it. */
const IMPORT_EXCEPTIONS: Record<string, string> = {
  // Headless CLI-agent path: spawns claude/codex outside spawnHarness (PR 4).
  'src/mms/macros/headlessCommand.ts': 'PR 4',
  'src/mms/integrations/agents/AgentConfigManager.ts': 'PR 4',
  'src/mms/platform/MmsAgentExecutionService.ts': 'PR 4'
}

function isMacroProvider(path: string): boolean {
  return /^src\/mms\/macros\/providers\/\w+MacroProvider\.ts$/.test(path)
}

describe('harness import boundary', () => {
  const sources = files('src').map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') }))

  it('scans the application sources', () => {
    expect(sources.some(({ path }) => path === 'src/mms/orchestrator/OrchestratorService.ts')).toBe(true)
    expect(sources.some(({ path }) => path.startsWith('src/renderer/'))).toBe(true)
  })

  it('no application code imports vendor SDKs, vendor services or adapters', () => {
    const violations: string[] = []
    for (const { path, source } of sources) {
      if (ALLOWED_IMPORTERS.some((rule) => rule.test(path)) || IMPORT_EXCEPTIONS[path] || isMacroProvider(path)) continue
      for (const specifier of specifiers(source)) {
        const resolved = target(path, specifier)
        if (FORBIDDEN.some((rule) => rule.test(resolved))) violations.push(`${path} → ${specifier}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('the orchestrator imports no vendor service or adapter', () => {
    const orchestrator = sources.find(({ path }) => path === 'src/mms/orchestrator/OrchestratorService.ts')!
    const vendor = specifiers(orchestrator.source).filter((specifier) => /providers\/(claudeSubscription|codex|antigravity)|run\/adapters\/(?!shared\/)/.test(specifier))
    expect(vendor).toEqual([])
  })

  it('every listed exception still exists', () => {
    for (const path of Object.keys(IMPORT_EXCEPTIONS)) expect(sources.some((entry) => entry.path === path), path).toBe(true)
  })

  it('only the Cursor host loads the Cursor SDK', () => {
    const violations: string[] = []
    for (const { path, source } of sources) {
      if (CURSOR_SDK_IMPORTERS.some((rule) => rule.test(path)) || CURSOR_SDK_TRANSITIONAL[path]) continue
      for (const specifier of specifiers(source)) if (CURSOR_SDK.test(specifier)) violations.push(`${path} → ${specifier}`)
    }
    expect(violations).toEqual([])
    for (const path of Object.keys(CURSOR_SDK_TRANSITIONAL)) expect(sources.some((entry) => entry.path === path), path).toBe(true)
  })
})

/**
 * The Cursor SDK keeps process-wide state and leaves rejections nobody awaits: it runs only in
 * the host process (agent CLIs plan §2 "Boundary"). Type-only imports count too.
 */
const CURSOR_SDK = /^(@cursor\/sdk|pi-cursor-sdk)(\/|$)/
const CURSOR_SDK_IMPORTERS = [/^src\/mms\/harness\/hosts\//]
/** The legacy `pi:cursor` model API, removed with the pi loop. */
const CURSOR_SDK_TRANSITIONAL: Record<string, string> = {
  'src/mms/providers/cursorPiProvider.ts': 'PR 4',
  'src/mms/providers/ProviderAuthService.ts': 'PR 4'
}

// -- Rule 2: driver-name literals at branch sites --------------------------------------------------

/** Where application branches live. Declarations and data tables are out of scope (plan v3). */
const BRANCH_SCOPES = ['src/renderer/', 'src/mms/orchestrator/', 'src/mms/protocol/', 'src/mms/channels/', 'src/cli/']

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
 * icons and settings keywords show the vendor; the headless CLI-agent files are PR 4's.
 */
const LITERAL_ALLOWLIST: Record<string, string> = {
  'src/renderer/lib/providerIcons.tsx': 'icons',
  'src/cli/commands/agents.ts': 'PR 4 (headless CLI agents)',
  // The pi loop's prompt for the legacy `pi:cursor` model API (`providerId` is a pi-ai provider).
  'src/mms/orchestrator/systemPrompt.ts': 'PR 4 (goes with the pi loop)'
}

/**
 * Transitional allowlist (plan v3): driver declarations and vendor-service internals that PR 1
 * keeps unchanged. These directories are outside the branch scopes above; listed so the scope
 * stays honest if they move.
 */
const TRANSITIONAL: Record<string, string> = {
  'src/mms/run/adapters/': 'PR 2–4 (adapters retired by drivers)',
  'src/mms/providers/claudeSubscription/': 'PR 5',
  'src/mms/providers/codex/': 'PR 5',
  'src/mms/providers/antigravity/': 'PR 5'
}

function codeLines(source: string): Array<{ line: string; number: number }> {
  return source.split('\n').map((line, index) => ({ line, number: index + 1 })).filter(({ line }) => {
    const trimmed = line.trim()
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*')
  })
}

describe('driver-name literals', () => {
  const sources = BRANCH_SCOPES.flatMap((scope) => files(scope)).map((path) => ({ path, source: readFileSync(join(repoRoot, path), 'utf8') }))

  it('scans the branch scopes', () => {
    expect(sources.some(({ path }) => path.startsWith('src/mms/protocol/'))).toBe(true)
    expect(sources.some(({ path }) => path.startsWith('src/renderer/'))).toBe(true)
    for (const dir of Object.keys(TRANSITIONAL)) expect(BRANCH_SCOPES.some((scope) => dir.startsWith(scope)), dir).toBe(false)
  })

  it('no application branch compares a driver or legacy provider name', () => {
    const violations: string[] = []
    for (const { path, source } of sources) {
      if (LITERAL_ALLOWLIST[path]) continue
      for (const { line, number } of codeLines(source))
        if (BRANCH_SITES.some((site) => site.test(line))) violations.push(`${path}:${number}: ${line.trim()}`)
    }
    expect(violations).toEqual([])
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
