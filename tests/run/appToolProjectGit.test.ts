/**
 * PR 4 §6: `git_status` and `git_diff` are app tools, so a definition granted them keeps them over
 * the Mousse MCP server on a runtime with its own loop. Its grants decide each call; other turns use
 * them in Build mode, as in the pi loop, which keeps its own copies.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { GitService } from '../../src/mms/git/GitService'
import { createAppToolRegistry } from '../../src/mms/run/mcp/appTools'
import type { AgentRuntimePolicy } from '../../src/shared/agents/execution'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

let fx: DelegationFixture | undefined
const dirs: string[] = []
afterEach(() => {
  fx?.dispose()
  fx = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A repository with one committed file changed in the working tree. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-project-git-'))
  dirs.push(dir)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'a.txt'), 'two\n')
  return dir
}

const SECRET = 'TOP SECRET OUTSIDE ROOT'

/**
 * A repository whose agent may use only its `allowed` folder: `secret.txt` beside it and
 * `allowed/a.txt` are both committed and both changed, and an untracked file sits beside them too.
 */
function parentRepo(): { top: string; allowed: string } {
  const top = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-project-git-parent-')))
  dirs.push(top)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: top, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  const allowed = join(top, 'allowed')
  mkdirSync(allowed)
  writeFileSync(join(top, 'secret.txt'), 'old secret\n')
  writeFileSync(join(allowed, 'a.txt'), 'one\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(top, 'secret.txt'), `${SECRET}\n`)
  writeFileSync(join(top, 'other-new.txt'), `${SECRET}\n`)
  writeFileSync(join(allowed, 'a.txt'), 'two\n')
  return { top, allowed }
}

function policy(root: string): AgentRuntimePolicy {
  return {
    profileId: 'default', threadId: 'thread-a', runId: 'r', definitionId: 'def-1', definitionRevision: 'rev-1', source: 'editor',
    workspace: { mode: 'thread_worktree', canonicalRoots: [root] },
    script: { enabled: false, allowFilesystem: false, allowNetwork: false, executionMode: 'workspace', interpreters: [] },
    approval: { askUser: true, policy: 'inherit', unattendedBehavior: 'pause' },
    memoryScope: 'off', includeCurrentThread: false, includeProjectInstructions: false, attachmentPolicy: 'none',
    fallbacks: { enabled: false, retryOn: [], allowHigherCost: false, retryCount: 0, backoffMs: 0 },
    fallbackModels: []
  }
}

const grants = (...ids: string[]) => ({ skills: [], mcpTools: [], builtinTools: ids.map((id) => ({ id, source: 'definition' as never })), denied: [] })

async function setup(turn: Partial<Parameters<typeof appTurn>[0]>) {
  fx = delegationFixture()
  const run = await fx.runningRun('thread-a')
  const fake = fakeAppToolHost({ projectGit: new GitService() })
  const { registry, families, turns, request } = appToolRegistry(fx.engine, fake.host)
  turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, ...turn }))
  return { registry, families, call: (name: string, args: Record<string, unknown>) => registry.call(name, args, request({ threadId: 'thread-a', runId: run.runId })) }
}

describe('git_status and git_diff as app tools', () => {
  it('a definition granted them reads the project repository over MCP', async () => {
    const root = repo()
    const s = await setup({ projectPath: root, definition: { policy: policy(root), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
    expect(s.families.projectGit).toEqual(['git_status', 'git_diff'])
    const status = await s.call('git_status', {})
    expect(status.isError).toBe(false)
    expect(JSON.parse(status.text)).toMatchObject({ isRepo: true, changes: [expect.objectContaining({ path: 'a.txt' })] })
    const diff = await s.call('git_diff', { path: 'a.txt' })
    expect(diff.isError).toBe(false)
    expect(diff.text).toContain('-one')
    expect(diff.text).toContain('+two')
  })

  it('a definition without the grant is refused before the tool runs', async () => {
    const root = repo()
    const s = await setup({ projectPath: root, definition: { policy: policy(root), grants: grants('git_status') } as DefinitionAuthority })
    expect(await s.call('git_diff', { path: 'a.txt' })).toEqual({ text: 'Tool "git_diff" is not granted to this agent definition.', isError: true })
  })

  it('a path outside the project is refused', async () => {
    const root = repo()
    const s = await setup({ projectPath: root, modeFacts: { readOnly: false, agent: false, build: true } })
    expect(await s.call('git_diff', { path: '../elsewhere.txt' })).toMatchObject({ isError: true, text: expect.stringContaining('outside the project') })
  })

  it('other turns use them in Build mode only, and Settings can turn them off', async () => {
    const root = repo()
    const agent = await setup({ projectPath: root })
    expect(await agent.call('git_status', {})).toMatchObject({ isError: true, text: expect.stringContaining('Build mode') })
    fx?.dispose()
    const off = await setup({ projectPath: root, modeFacts: { readOnly: false, agent: false, build: true }, settingsEnabled: (name) => name !== 'git_status' })
    expect(await off.call('git_status', {})).toMatchObject({ isError: true, text: expect.stringContaining('disabled in Settings') })
    expect((await off.call('git_diff', { path: 'a.txt' })).isError).toBe(false)
  })

  describe('a project that is a folder of a larger repository', () => {
    const turns = (allowed: string) => [
      ['a definition held to the folder', { projectPath: allowed, definition: { policy: policy(allowed), grants: grants('git_status', 'git_diff') } as DefinitionAuthority }],
      ['a Build turn in the folder', { projectPath: allowed, modeFacts: { readOnly: false, agent: false, build: true } }]
    ] as const

    it('git_diff reads a name as a file, never as a pathspec, so nothing outside the folder is shown', async () => {
      const { allowed } = parentRepo()
      for (const [, turn] of turns(allowed)) {
        fx?.dispose()
        const s = await setup(turn)
        // Magic pathspecs, globs and parent paths that Git would resolve outside the folder.
        for (const path of [':(top)secret.txt', ':/secret.txt', ':(top,glob)*.txt', ':(icase)../SECRET.TXT', '*.txt', '../*.txt', '../secret.txt', '../other-new.txt', `${allowed}/../secret.txt`]) {
          const result = await s.call('git_diff', { path })
          expect(result.text, path).not.toContain(SECRET)
          expect(result.isError || result.text === '(no diff)', path).toBe(true)
          expect((await s.call('git_diff', { path, staged: true })).text, path).not.toContain(SECRET)
        }
        const own = await s.call('git_diff', { path: 'a.txt' })
        expect(own).toMatchObject({ isError: false, text: expect.stringContaining('+two') })
        expect(own.text).not.toContain(SECRET)
      }
    })

    it("git_status shows only the folder's files, never the rest of the repository", async () => {
      const { top, allowed } = parentRepo()
      // A rename from outside into the folder shows as an added file, without its source.
      execFileSync('git', ['mv', 'secret.txt', 'allowed/moved.txt'], { cwd: top, stdio: 'pipe' })
      writeFileSync(join(allowed, 'new.txt'), 'new\n')
      for (const [, turn] of turns(allowed)) {
        fx?.dispose()
        const s = await setup(turn)
        const status = await s.call('git_status', {})
        expect(status.isError).toBe(false)
        expect(status.text).not.toContain('secret')
        expect(status.text).not.toContain('other-new')
        const parsed = JSON.parse(status.text) as { isRepo: boolean; changes: Array<{ path: string; status: string; staged: boolean; originalPath?: string }> }
        expect(parsed.isRepo).toBe(true)
        // The moved file was also changed after the move: a staged and an unstaged change.
        expect([...new Set(parsed.changes.map((change) => change.path))].sort()).toEqual(['a.txt', 'moved.txt', 'new.txt'])
        expect(parsed.changes.find((change) => change.path === 'moved.txt' && change.staged)).toMatchObject({ status: 'added' })
        expect(parsed.changes.every((change) => change.originalPath === undefined)).toBe(true)
        expect(parsed).not.toHaveProperty('upstream')
      }
    })
  })

  it('a host that does not read the repository (the pi loop) registers none', () => {
    const { registry, families } = createAppToolRegistry({ host: fakeAppToolHost().host })
    expect(families.projectGit).toEqual([])
    expect(registry.get('git_status')).toBeUndefined()
  })
})
