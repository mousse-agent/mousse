import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FULL_RUN_TRIGGERS, classifyChanges, loadManifest, moduleId } from '../scripts/test-select.mjs'

const manifest = loadManifest()

describe('change-based test selection plan', () => {
  it('runs everything when a shared fixture, setup file, config or lockfile changes', () => {
    for (const path of [
      'tests/setup/mousseHome.ts',
      'tests/support/build.ts',
      'tests/fixtures/agent-platform/migration-crash/child.ts',
      'tests/test-dependencies.json',
      'tests/test-lanes.json',
      'vitest.config.ts',
      'electron.vite.config.ts',
      'package.json',
      'package-lock.json',
      'tsconfig.node.json',
      'scripts/test-select.mjs'
    ]) {
      const plan = classifyChanges(['src/mms/net/sync/codec.ts', path], manifest)
      expect(plan.mode, path).toBe('full')
      expect(plan.reason).toContain(path)
    }
  })

  it('runs nothing for documentation and repository metadata', () => {
    const plan = classifyChanges(['docs/GLOSSARY.md', 'README.md', '.github/workflows/ci.yml', '.gitignore'], manifest)
    expect(plan.mode).toBe('none')
  })

  it('selects the spawned-process project for CLI, main, preload and build inputs', () => {
    for (const path of ['src/cli/index.ts', 'src/main/index.ts', 'src/preload/index.ts', 'scripts/build-cli.mjs', 'electron-builder.yml']) {
      const plan = classifyChanges([path], manifest)
      expect(plan.mode, path).toBe('select')
      expect(plan.projects, path).toEqual(['process', 'heavy'])
    }
  })

  it('maps bundled-daemon sources to the net tests the graph cannot reach', () => {
    const plan = classifyChanges(['src/mms/net/sync/session.ts'], manifest)
    expect(plan.mode).toBe('select')
    expect(plan.runGlobs).toContain('tests/net/**/*.test.ts')
    expect(plan.graph).toEqual(['src/mms/net/sync/session.ts'])
  })

  it('maps renderer sources and assets to the Electron fixture tests', () => {
    const plan = classifyChanges(['src/renderer/styles/global.css'], manifest)
    expect(plan.mode).toBe('select')
    expect(plan.runGlobs).toContain('tests/renderer/**/*.test.ts')
    expect(plan.runGlobs).toContain('tests/platformEditorCrossFeature.test.ts')
  })

  it('maps protocol test vectors to the files that read them from disk', () => {
    const plan = classifyChanges(['test-vectors/net/protocol/envelope.json'], manifest)
    expect(plan.mode).toBe('select')
    expect(plan.runGlobs).toContain('tests/net/protocol/codec.test.ts')
    // Data files pass through to the graph check harmlessly; only src/ and scripts/ can be uncovered.
    expect(plan.graph).toEqual(['test-vectors/net/protocol/envelope.json'])
  })

  it('leaves an ordinary module to the import graph and records inert companions', () => {
    const plan = classifyChanges(['src/shared/chatMode.ts', 'docs/notes.md'], manifest)
    expect(plan.mode).toBe('select')
    expect(plan.graph).toEqual(['src/shared/chatMode.ts'])
    expect(plan.inert).toEqual(['docs/notes.md'])
    expect(plan.rules).toEqual([])
  })

  it('treats a deleted or renamed test as its own change', () => {
    const plan = classifyChanges(['tests/old-name.test.ts', 'tests/new-name.test.ts'], manifest)
    expect(plan.mode).toBe('select')
    expect(plan.graph).toEqual(['tests/new-name.test.ts', 'tests/old-name.test.ts'])
  })

  it('names modules the way Vite does, with forward slashes, on Windows paths too', () => {
    // Vite ids look like `E:/repo/src/a.ts`; a native Windows path never matches the module graph.
    expect(win32.resolve('E:\\repo', 'src/shared/chatMode.ts')).toBe('E:\\repo\\src\\shared\\chatMode.ts')
    expect(moduleId('src/shared/chatMode.ts', 'E:\\repo', win32)).toBe('E:/repo/src/shared/chatMode.ts')
    expect(moduleId('src\\shared\\chatMode.ts', 'E:\\repo', win32)).toBe('E:/repo/src/shared/chatMode.ts')
    expect(moduleId('src/shared/chatMode.ts', 'e:\\repo', win32)).toBe('e:/repo/src/shared/chatMode.ts')
    expect(moduleId('src/shared/chatMode.ts', '/repo', posix)).toBe('/repo/src/shared/chatMode.ts')
  })

  it('keeps the trigger list in step with the vitest configuration', async () => {
    const config = await import('../vitest.config')
    const configured = (config.default as { test?: { forceRerunTriggers?: string[] } }).test?.forceRerunTriggers ?? []
    expect(configured.map((glob) => glob.replace(/^\*\*\//, '')).sort()).toEqual([...FULL_RUN_TRIGGERS].sort())
  })

  it('keeps explicit resource lanes disjoint and names only existing tests', async () => {
    const { readFileSync, globSync } = await import('node:fs')
    const lanes = JSON.parse(readFileSync(new URL('./test-lanes.json', import.meta.url), 'utf8'))
    const entries = ['process', 'serviceTls', 'daemon', 'browser'].flatMap((lane) => lanes[lane] as string[])
    expect(new Set(entries).size).toBe(entries.length)
    const files = new Set(globSync('tests/**/*.test.ts').map((file) => file.replaceAll('\\', '/')))
    for (const file of entries) expect(files.has(file), file).toBe(true)
  })

  it('every manifest rule names at least one existing test file or project', async () => {
    const { globSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const root = resolve(import.meta.dirname, '..')
    for (const rule of manifest.rules as Array<{ name: string; run?: string[]; projects?: string[] }>) {
      if (rule.projects?.length) {
        for (const project of rule.projects) expect(['unit', 'process', 'heavy'], rule.name).toContain(project)
        continue
      }
      const matches = rule.run!.flatMap((glob) => globSync(glob, { cwd: root }))
      expect(matches.length, `${rule.name}: ${rule.run!.join(', ')}`).toBeGreaterThan(0)
    }
  })
})
