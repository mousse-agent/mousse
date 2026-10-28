/**
 * Mousse itself collects no usage data (Settings → General → Privacy). The guard: no analytics or
 * crash-reporting package, every internet address in the code listed in `OUTBOUND` (what Mousse
 * contacts and what it sends, or a link it never contacts), and no listed service whose code is gone.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { OUTBOUND } from '../../src/shared/privacy/outbound'

const ROOT = join(__dirname, '..', '..')

/** Analytics and crash-reporting packages: a trailing `*` matches a prefix. */
const TELEMETRY_PACKAGES = ['posthog-*', '@sentry/*', 'analytics-node', '@segment/*', 'mixpanel*', '@amplitude/*', 'applicationinsights', '@bugsnag/*']

function telemetryDependencies(pkg: Record<string, unknown>): string[] {
  const names = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].flatMap((field) => Object.keys((pkg[field] as Record<string, string> | undefined) ?? {}))
  return names.filter((name) => TELEMETRY_PACKAGES.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern)))
}

const URL = /https?:\/\/([A-Za-z0-9.-]+)/g

/** The hosts named by the strings of one source file (its string literals, template parts and JSX text; all of an HTML file). */
function hostsIn(path: string, text: string): string[] {
  const strings: string[] = []
  if (path.endsWith('.html')) strings.push(text)
  else {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, path.endsWith('.tsx') ? ts.ScriptKind.TSX : undefined)
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || node.kind === ts.SyntaxKind.JsxText) strings.push((node as ts.LiteralLikeNode).text)
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  // A regular expression's escaped dot (`huggingface\.co`) names the same host.
  return strings.flatMap((value) => [...value.replace(/\\\./g, '.').matchAll(URL)].map((match) => match[1]!.toLowerCase().replace(/\.$/, '')).filter(Boolean))
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js|mjs|cjs|html)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
  })
}

const listed = new Set(OUTBOUND.flatMap((entry) => entry.hosts))

/** Hosts in `files` (path → text) that `OUTBOUND` does not list, with where each is. */
function unlistedHosts(files: Array<[string, string]>): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const [path, text] of files) for (const host of hostsIn(path, text)) if (!listed.has(host)) (found[host] ??= []).push(path)
  return found
}

const files: Array<[string, string]> = sourceFiles(join(ROOT, 'src')).map((path) => [relative(ROOT, path).split(sep).join('/'), readFileSync(path, 'utf8')])

describe('Mousse collects no usage data', () => {
  it('ships no analytics or crash-reporting package', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(telemetryDependencies(pkg)).toEqual([])
    // A planted one is caught.
    expect(telemetryDependencies({ dependencies: { 'posthog-node': '1' }, devDependencies: { '@sentry/electron': '1', react: '19' } })).toEqual(['posthog-node', '@sentry/electron'])
  })

  it('lists every internet address in the code as contacted, a link or this computer', () => {
    expect(unlistedHosts(files)).toEqual({})
    // A planted address is caught, in code and in shown text.
    expect(unlistedHosts([['src/x.ts', "const u = `https://collect.example.net/${id}`"], ['src/y.tsx', 'const p = <p>See https://stats.example.org</p>']])).toEqual({
      'collect.example.net': ['src/x.ts'],
      'stats.example.org': ['src/y.tsx']
    })
    // A comment is not a request.
    expect(unlistedHosts([['src/z.ts', '// from https://collect.example.net\nconst a = 1']])).toEqual({})
  })

  it('names, for every service it contacts, when, what is sent and a source file that still names it', () => {
    const texts = new Map(files)
    for (const entry of OUTBOUND) {
      expect(entry.hosts.length, entry.label).toBeGreaterThan(0)
      if (entry.kind !== 'contacted') continue
      expect(entry.when && entry.sends, entry.label).toBeTruthy()
      expect(entry.sources?.length, entry.label).toBeGreaterThan(0)
      for (const source of entry.sources!) expect(existsSync(join(ROOT, source)), `${entry.label}: ${source}`).toBe(true)
      const named = entry.sources!.some((source) => hostsIn(source, texts.get(source) ?? '').some((host) => entry.hosts.includes(host)))
      expect(named, `${entry.label}: no source names ${entry.hosts.join(', ')}`).toBe(true)
    }
  })

  it('lists each host under one kind', () => {
    const kinds = new Map<string, Set<string>>()
    for (const entry of OUTBOUND) for (const host of entry.hosts) (kinds.get(host) ?? kinds.set(host, new Set()).get(host)!).add(entry.kind)
    expect([...kinds].filter(([, set]) => set.size > 1).map(([host]) => host)).toEqual([])
  })
})
