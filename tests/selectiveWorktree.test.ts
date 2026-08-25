import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import simpleGit from 'simple-git'
import { BlastRadiusAnalyzer, extractRelativeSpecifiers } from '../src/mms/worktree/BlastRadiusAnalyzer'
import { WorktreeManager } from '../src/mms/worktree/WorktreeManager'

const roots: string[] = []
const originalMousseHome = process.env.MOUSSE_HOME

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-selective-repo-'))
  const mousseHome = mkdtempSync(join(tmpdir(), 'mousse-selective-home-'))
  roots.push(root, mousseHome)
  process.env.MOUSSE_HOME = mousseHome
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'tests'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'shared-package'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(root, 'package.json'), '{"scripts":{"test":"vitest"}}\n')
  writeFileSync(join(root, 'tsconfig.json'), '{}\n')
  writeFileSync(join(root, 'src', 'math.ts'), 'export const add = (a: number, b: number) => a + b\n')
  writeFileSync(join(root, 'src', 'feature.ts'), "import { add } from './math'\nexport const answer = add(20, 22)\n")
  writeFileSync(join(root, 'src', 'app.ts'), "import { answer } from './feature'\nconsole.log(answer)\n")
  writeFileSync(join(root, 'tests', 'feature.test.ts'), "import { answer } from '../src/feature'\nvoid answer\n")
  writeFileSync(join(root, 'docs', 'unrelated.md'), 'large unrelated documentation\n')
  writeFileSync(join(root, 'node_modules', 'shared-package', 'index.js'), 'module.exports = {}\n')
  const git = simpleGit(root)
  await git.init()
  await git.addConfig('user.name', 'Mousse Test')
  await git.addConfig('user.email', 'mousse@test.invalid')
  await git.add(['.'])
  await git.commit('base')
  mkdirSync(join(root, 'reference'), { recursive: true })
  writeFileSync(join(root, 'reference', 'local-input.mp4'), 'untracked media input\n')
  return { root, git }
}

afterEach(() => {
  process.env.MOUSSE_HOME = originalMousseHome
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('selective worktrees', () => {
  it('extracts static, dynamic, CommonJS, and stylesheet-relative dependencies', () => {
    const content = `
      import x from './x'
      export { y } from "../y.js"
      const z = require('./z')
      import('./lazy')
      @use './theme';
    `
    expect(extractRelativeSpecifiers(content).sort()).toEqual(
      ['../y.js', './lazy', './theme', './x', './z'].sort()
    )
  })

  it('computes transitive dependencies and reverse dependents while rejecting escapes', async () => {
    const { root, git } = await fixture()
    const result = await new BlastRadiusAnalyzer(root, git).analyze([
      'src/feature.ts', '../secret.txt', 'missing.ts'
    ])
    expect(result.declaredFiles).toEqual(['missing.ts', 'src/feature.ts'])
    expect(result.includedFiles).toEqual(expect.arrayContaining([
      'src/math.ts', 'src/feature.ts', 'src/app.ts', 'tests/feature.test.ts',
      'package.json', 'tsconfig.json'
    ]))
    expect(result.includedFiles).not.toContain('docs/unrelated.md')
    expect(result.prospectiveFiles).toEqual(['missing.ts'])
    expect(result.rejectedFiles).toHaveLength(1)
  })

  it('materializes only the blast radius, preserves paths, and shares dependencies', async () => {
    const { root } = await fixture()
    const manager = new WorktreeManager(root)
    await manager.init()
    const worktree = await manager.createSelectiveWorktree('selective-agent-id', ['src/feature.ts', 'src/new-helper.ts'])

    expect(readFileSync(join(worktree.path, 'src', 'feature.ts'), 'utf8')).toContain("'./math'")
    expect(existsSync(join(worktree.path, 'src', 'math.ts'))).toBe(true)
    expect(existsSync(join(worktree.path, 'src', 'app.ts'))).toBe(true)
    expect(existsSync(join(worktree.path, 'tests', 'feature.test.ts'))).toBe(true)
    expect(existsSync(join(worktree.path, 'docs', 'unrelated.md'))).toBe(false)
    expect(lstatSync(join(worktree.path, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(worktree.sharedDependencyPaths).toEqual([join(worktree.path, 'node_modules')])
    mkdirSync(join(worktree.path, '.mousse'), { recursive: true })
    writeFileSync(join(worktree.path, '.mousse', 'task-progress.json'), '{"status":"working"}\n')
    expect((await simpleGit(worktree.path).status()).isClean()).toBe(true)
    writeFileSync(join(worktree.path, 'src', 'new-helper.ts'), 'export const created = true\n')
    await simpleGit(worktree.path).add(['src/new-helper.ts'])
    await simpleGit(worktree.path).commit('add declared file')
    expect((await manager.validateAgentReadiness(worktree)).changedFiles).toContain('src/new-helper.ts')

    const cleanup = await manager.cleanupValidatedAgentWorktree(worktree)
    expect(cleanup.success).toBe(true)
  })

  it('materializes an explicitly selected untracked input without unrelated files', async () => {
    const { root } = await fixture()
    const manager = new WorktreeManager(root)
    await manager.init()
    const worktree = await manager.createSelectiveWorktree(
      'untracked-input-agent',
      ['docs/report.md', 'reference/local-input.mp4']
    )

    expect(readFileSync(join(worktree.path, 'reference', 'local-input.mp4'), 'utf8'))
      .toBe('untracked media input\n')
    expect(existsSync(join(worktree.path, 'docs', 'unrelated.md'))).toBe(false)

    const cleanup = await manager.cleanupValidatedAgentWorktree(worktree)
    expect(cleanup.success).toBe(true)
  })
})
