import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FULL_RUN_TRIGGERS, classifyChanges, loadManifest, moduleId, runSpecifications } from '../scripts/test-select.mjs'

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

  it('runs every test that reads a renderer source or stylesheet from disk when the renderer changes', async () => {
    // Reading a file is not an import, so the graph cannot link the test to it; only the rule can.
    const { globSync, readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const root = resolve(import.meta.dirname, '..')
    const posix = (file: string) => file.replaceAll('\\', '/')
    const plan = classifyChanges(['src/renderer/styles/app.css'], manifest)
    const selected = new Set(plan.runGlobs.flatMap((glob: string) => globSync(glob, { cwd: root })).map(posix))
    const readsFiles = /\b(readFileSync|readFile|readdirSync)\b/
    const namesRendererFile = /src\/renderer|renderer\/styles|['"`][^'"`\n]*\.css['"`]/
    // Module specifiers are not reads: drop whole import statements (they can span lines), re-exports and vi.mock paths.
    const withoutImports = (source: string) =>
      source
        .replace(/\bimport\b[^;'"]*?\bfrom\s*['"][^'"\n]+['"]/g, '')
        .replace(/\bimport\s*['"][^'"\n]+['"]/g, '')
        .split('\n')
        .filter((line) => !/^\s*(export .* from|vi\.mock\()/.test(line))
        .join('\n')
    // This file is exempt because it only names paths as data.
    const missed = globSync('tests/**/*.test.ts', { cwd: root })
      .map(posix)
      .filter((file) => !file.startsWith('tests/renderer/') && file !== 'tests/testSelect.test.ts')
      .filter((file) => {
        const code = withoutImports(readFileSync(resolve(root, file), 'utf8'))
        return readsFiles.test(code) && namesRendererFile.test(code)
      })
      .filter((file) => !selected.has(file))
    expect(missed, 'add these tests to the renderer rule in tests/test-dependencies.json').toEqual([])
  })

  it('maps the example workflow to the workflow tests that read it from disk', () => {
    const plan = classifyChanges(['examples/workflows/summarize-files/workflow.json'], manifest)
    expect(plan.mode).toBe('select')
    expect(plan.runGlobs).toEqual(
      expect.arrayContaining(['tests/platformWorkflowCompiler.test.ts', 'tests/platformWorkflowRegistry.test.ts', 'tests/platformWorkflowRuntime.test.ts'])
    )
  })

  it('maps development launchers to the tests of their helpers instead of a full run', () => {
    for (const path of ['scripts/dev.mjs', 'scripts/dev-mms.mjs', 'scripts/gui-launch.mjs']) {
      const plan = classifyChanges([path], manifest)
      expect(plan.mode, path).toBe('select')
      expect(plan.runGlobs, path).toContain('tests/platformDevelopmentRuntime.test.ts')
    }
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

  it('initializes the reporters before running the selected files', async () => {
    // createVitest never calls the reporters' onInit; running without standalone() leaves their
    // ctx undefined and the summary crashes with "Cannot read properties of undefined (reading 'logger')".
    let reporterCtx: object | undefined
    const calls: string[] = []
    const vitest = {
      async standalone() {
        calls.push('standalone')
        reporterCtx = {}
      },
      async runTestSpecifications(specs: unknown[]) {
        calls.push('run')
        if (!reporterCtx) throw new TypeError("Cannot read properties of undefined (reading 'logger')")
        return { testModules: specs.map(() => ({ ok: () => true })), unhandledErrors: [] }
      }
    }
    await expect(runSpecifications(vitest, [{}, {}])).resolves.toBe(false)
    expect(calls).toEqual(['standalone', 'run'])
  })

  it('reports a failed test module or an unhandled error as a failed run', async () => {
    const run = (result: object) => ({ standalone: async () => undefined, runTestSpecifications: async () => result })
    expect(await runSpecifications(run({ testModules: [{ ok: () => false }], unhandledErrors: [] }), [{}])).toBe(true)
    expect(await runSpecifications(run({ testModules: [{ ok: () => true }], unhandledErrors: [new Error('x')] }), [{}])).toBe(true)
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
