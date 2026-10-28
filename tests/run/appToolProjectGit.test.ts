/**
 * PR 4 §6: `git_status` and `git_diff` are app tools, so a definition granted them keeps them over
 * the Mousse MCP server on a runtime with its own loop. Its grants decide each call; other turns use
 * them in Build mode.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DefinitionAuthority } from '../../src/mms/agentDefinitions/definitionGate'
import { FileService } from '../../src/mms/files/FileService'
import { GitService } from '../../src/mms/git/GitService'
import { ProjectGitTools } from '../../src/mms/workflows/tools/ProjectGitTools'
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
  const fake = fakeAppToolHost({ projectGit: true })
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

  describe('a read never starts a program the repository configures', () => {
    const marker = (dir: string, name: string) => join(dir, `${name}.marker`).split('\\').join('/')
    /** A repo whose fsmonitor hook and file filters each append to a marker when Git runs them. */
    function hostile(): { top: string; allowed: string; markers: string[] } {
      const { top, allowed } = parentRepo()
      const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-project-git-markers-')))
      dirs.push(outside)
      const markers = ['fsmonitor', 'clean', 'smudge', 'process'].map((name) => marker(outside, name))
      const git = (...args: string[]) => execFileSync('git', args, { cwd: top, stdio: 'pipe' })
      git('config', 'core.fsmonitor', `echo ran >> '${markers[0]}'`)
      git('config', 'filter.review.clean', `echo ran >> '${markers[1]}'; cat`)
      git('config', 'filter.review.smudge', `echo ran >> '${markers[2]}'; cat`)
      git('config', 'filter.Other.process', `echo ran >> '${markers[3]}'`)
      writeFileSync(join(top, '.gitattributes'), '*.txt filter=review\n*.md filter=Other\n')
      writeFileSync(join(allowed, 'b.md'), 'note\n')
      return { top, allowed, markers }
    }

    it('fsmonitor and clean, smudge and process filters stay off for both tools, under a read-only, scripts-off definition', async () => {
      const { top, allowed, markers } = hostile()
      // The probe is real: plain Git runs the hook and the filter.
      execFileSync('git', ['status', '--porcelain'], { cwd: top, stdio: 'pipe' })
      expect(existsSync(markers[0]!) && existsSync(markers[1]!)).toBe(true)
      for (const file of markers) rmSync(file, { force: true })
      const readOnly = { ...policy(allowed), workspace: { mode: 'read_only' as const, canonicalRoots: [allowed] } }
      const s = await setup({ projectPath: allowed, definition: { policy: readOnly, grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
      expect((await s.call('git_status', {})).isError).toBe(false)
      expect(await s.call('git_diff', { path: 'a.txt' })).toMatchObject({ isError: false, text: expect.stringContaining('+two') })
      expect((await s.call('git_diff', { path: 'a.txt', staged: true })).isError).toBe(false)
      expect((await s.call('git_diff', { path: 'b.md' })).isError).toBe(false)
      expect(markers.filter((file) => existsSync(file))).toEqual([])
    })
  })

  describe('real paths, submodules and the repository that owns the folder', () => {
    it('a junction or symlink inside the folder never shows what it points at, in a diff or the status', async () => {
      const { top, allowed } = parentRepo()
      const git = (...args: string[]) => execFileSync('git', args, { cwd: top, stdio: 'pipe' })
      mkdirSync(join(allowed, 'nested'))
      writeFileSync(join(allowed, 'nested', 'data.txt'), 'inside\n')
      git('add', '.')
      git('commit', '-q', '-m', 'nested')
      const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-project-git-outside-')))
      dirs.push(outside)
      writeFileSync(join(outside, 'data.txt'), 'SECRET THROUGH JUNCTION\n')
      writeFileSync(join(outside, 'untracked-secret-name.txt'), 'x\n')
      rmSync(join(allowed, 'nested'), { recursive: true, force: true })
      symlinkSync(outside, join(allowed, 'nested'), 'junction')
      const s = await setup({ projectPath: allowed, definition: { policy: policy(allowed), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
      for (const path of ['.', 'nested', 'nested/data.txt']) {
        const result = await s.call('git_diff', { path })
        expect(result.isError, path).toBe(true)
        expect(result.text, path).not.toContain('SECRET')
      }
      const status = await s.call('git_status', {})
      expect(status.isError).toBe(false)
      expect(status.text).not.toContain('untracked-secret-name')
      expect(status.text).not.toContain('nested')
    })

    it('a submodule is never read, even with diff.submodule=diff', async () => {
      const { top, allowed } = parentRepo()
      const inner = repo()
      const git = (...args: string[]) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd: top, stdio: 'pipe' })
      git('submodule', 'add', '-q', inner, 'allowed/sub')
      git('commit', '-q', '-m', 'sub')
      git('config', 'diff.submodule', 'diff')
      writeFileSync(join(allowed, 'sub', 'a.txt'), 'SUBMODULE SECRET\n')
      const s = await setup({ projectPath: allowed, definition: { policy: policy(allowed), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
      for (const path of ['.', 'sub']) expect((await s.call('git_diff', { path })).isError, path).toBe(true)
      const status = await s.call('git_status', {})
      expect(status.text).not.toContain('sub')
      expect(status.text).not.toContain('SECRET')
    })

    it('a .git file pointing at an unrelated repository is refused; a registered linked worktree is read', async () => {
      const foreign = repo()
      mkdirSync(join(foreign, 'allowed'))
      writeFileSync(join(foreign, 'allowed', 'a.txt'), 'SECRET FROM UNRELATED REPO\n')
      execFileSync('git', ['add', '.'], { cwd: foreign, stdio: 'pipe' })
      execFileSync('git', ['commit', '-q', '-m', 'foreign'], { cwd: foreign, stdio: 'pipe' })
      const pointed = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-project-git-pointed-')))
      dirs.push(pointed)
      mkdirSync(join(pointed, 'allowed'))
      writeFileSync(join(pointed, 'allowed', 'a.txt'), 'visible file\n')
      writeFileSync(join(pointed, '.git'), `gitdir: ${join(foreign, '.git')}\n`)
      const allowed = join(pointed, 'allowed')
      const s = await setup({ projectPath: allowed, definition: { policy: policy(allowed), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
      for (const staged of [false, true]) {
        const result = await s.call('git_diff', { path: 'a.txt', staged })
        expect(result).toMatchObject({ isError: true, text: expect.stringContaining('does not belong') })
        expect(result.text).not.toContain('SECRET')
      }
      expect((await s.call('git_status', {})).text).not.toContain('a.txt')
      // A worktree `git worktree add` registered is the same repository's, and is read.
      fx?.dispose()
      const main = repo()
      const linkedParent = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-project-git-linked-')))
      dirs.push(linkedParent)
      const linked = join(linkedParent, 'wt')
      execFileSync('git', ['worktree', 'add', '-q', linked], { cwd: main, stdio: 'pipe' })
      writeFileSync(join(linked, 'a.txt'), 'linked change\n')
      const w = await setup({ projectPath: linked, definition: { policy: policy(linked), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
      expect(await w.call('git_diff', { path: 'a.txt' })).toMatchObject({ isError: false, text: expect.stringContaining('+linked change') })
    })

    it('an untracked file inside the folder diffs as new', async () => {
      const { allowed } = parentRepo()
      writeFileSync(join(allowed, 'fresh.txt'), 'fresh content\n')
      const s = await setup({ projectPath: allowed, definition: { policy: policy(allowed), grants: grants('git_diff') } as DefinitionAuthority })
      expect(await s.call('git_diff', { path: 'fresh.txt' })).toMatchObject({ isError: false, text: expect.stringContaining('+fresh content') })
    })
  })

  describe('Git metadata the agent could have written is never trusted', () => {
    const definitionTurn = (allowed: string) => ({ projectPath: allowed, definition: { policy: policy(allowed), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
    async function expectNothingRead(allowed: string, secret: string, names: string[]) {
      const s = await setup(definitionTurn(allowed))
      for (const path of names) {
        for (const staged of [false, true]) {
          const result = await s.call('git_diff', { path, staged })
          expect(result.text, `${path} ${staged}`).not.toContain(secret)
          expect(result.isError, `${path} ${staged}`).toBe(true)
        }
      }
      const status = await s.call('git_status', {})
      expect(status.isError).toBe(true)
      for (const path of names) expect(status.text).not.toContain(path)
    }
    const commit = (top: string): string => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: top, encoding: 'utf8' }).trim()

    it("a .git folder planted in the roots with a commondir pointing at the parent repository (Opus's repro)", async () => {
      const { top, allowed } = parentRepo()
      execFileSync('git', ['add', 'secret.txt'], { cwd: top, stdio: 'pipe' })
      mkdirSync(join(allowed, '.git'))
      writeFileSync(join(allowed, '.git', 'HEAD'), 'ref: refs/heads/main\n')
      writeFileSync(join(allowed, '.git', 'commondir'), '../../.git\n')
      await expectNothingRead(allowed, SECRET, ['secret.txt'])
    })

    for (const variant of ['a gitdir back-pointer', 'core.worktree'] as const) {
      it(`a .git file pointing at a git dir it wrote, with a commondir into another repository and ${variant} (Grok's repro)`, async () => {
        const foreign = repo()
        mkdirSync(join(foreign, 'allowed'))
        writeFileSync(join(foreign, 'allowed', 'a.txt'), 'SECRET FROM UNRELATED REPO\n')
        writeFileSync(join(foreign, 'allowed', 'hidden-secret-name.txt'), 'SECRET FROM UNRELATED REPO\n')
        execFileSync('git', ['add', '.'], { cwd: foreign, stdio: 'pipe' })
        execFileSync('git', ['commit', '-q', '-m', 'foreign'], { cwd: foreign, stdio: 'pipe' })
        const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: foreign, encoding: 'utf8' }).trim()
        const pointed = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-project-git-pointed-')))
        dirs.push(pointed)
        mkdirSync(join(pointed, 'allowed'))
        writeFileSync(join(pointed, 'allowed', 'a.txt'), 'visible file\n')
        const fake = join(pointed, 'fake-git')
        mkdirSync(fake)
        writeFileSync(join(pointed, '.git'), `gitdir: ${fake}\n`)
        writeFileSync(join(fake, 'commondir'), `${join(foreign, '.git')}\n`)
        writeFileSync(join(fake, 'HEAD'), `ref: refs/heads/${branch}\n`)
        if (variant === 'core.worktree') writeFileSync(join(fake, 'config'), `[core]\n\tworktree = ${pointed.split('\\').join('/')}\n`)
        else writeFileSync(join(fake, 'gitdir'), `${join(pointed, '.git')}\n`)
        await expectNothingRead(join(pointed, 'allowed'), 'SECRET FROM UNRELATED REPO', ['a.txt', 'hidden-secret-name.txt'])
      })
    }
  })

  describe('hooks, required filters and line endings', () => {
    for (const source of ['the hooks folder', "the repository's core.hooksPath", 'a hook defined in config'] as const) {
      it(`the index refresh of git_diff never runs a post-index-change hook from ${source}`, async () => {
        const root = repo()
        const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-project-git-hook-')))
        dirs.push(outside)
        const marker = join(outside, 'hook.marker').split('\\').join('/')
        const script = `#!/bin/sh\necho ran >> '${marker}'\n`
        const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
        if (source === 'the hooks folder') {
          writeFileSync(join(root, '.git', 'hooks', 'post-index-change'), script)
          chmodSync(join(root, '.git', 'hooks', 'post-index-change'), 0o755)
        } else if (source === "the repository's core.hooksPath") {
          mkdirSync(join(outside, 'hooks'))
          writeFileSync(join(outside, 'hooks', 'post-index-change'), script)
          chmodSync(join(outside, 'hooks', 'post-index-change'), 0o755)
          git('config', 'core.hooksPath', join(outside, 'hooks').split('\\').join('/'))
        } else {
          git('config', 'hook.evil.command', `echo ran >> '${marker}'`)
          git('config', 'hook.evil.event', 'post-index-change')
        }
        let stamp = Math.floor(Date.now() / 1000) + 100
        const statDirty = () => {
          git('checkout', '-q', '--', 'a.txt')
          rmSync(marker, { force: true })
          writeFileSync(join(root, 'a.txt'), 'one\n')
          stamp += 10
          utimesSync(join(root, 'a.txt'), stamp, stamp)
        }
        statDirty()
        const s = await setup({ projectPath: root, definition: { policy: policy(root), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
        expect((await s.call('git_diff', { path: 'a.txt' })).isError).toBe(false)
        expect((await s.call('git_status', {})).isError).toBe(false)
        expect(existsSync(marker)).toBe(false)
        // The probe is real: in the same state again, plain `git diff` refreshes the index and runs the hook.
        statDirty()
        git('diff')
        expect(existsSync(marker)).toBe(true)
      })
    }

    it('a required filter (as Git LFS sets) neither runs nor fails the read: files are compared as stored', async () => {
      const root = repo()
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
      writeFileSync(join(root, 'big.bin'), 'version pointer one\n')
      git('add', 'big.bin')
      git('commit', '-q', '-m', 'bin')
      writeFileSync(join(root, '.gitattributes'), '*.bin filter=lfsish\n')
      git('config', 'filter.lfsish.clean', 'false')
      git('config', 'filter.lfsish.smudge', 'false')
      git('config', 'filter.lfsish.required', 'true')
      writeFileSync(join(root, 'big.bin'), 'version pointer two\n')
      const s = await setup({ projectPath: root, modeFacts: { readOnly: false, agent: false, build: true } })
      const status = await s.call('git_status', {})
      expect(status.isError).toBe(false)
      expect(status.text).toContain('big.bin')
      expect(await s.call('git_diff', { path: 'big.bin' })).toMatchObject({ isError: false, text: expect.stringContaining('+version pointer two') })
    })

    it("Git for Windows' system core.autocrlf still applies: a CRLF file shows only its real change", async () => {
      const configs = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-project-git-config-')))
      dirs.push(configs)
      writeFileSync(join(configs, 'system'), '[core]\n\tautocrlf = true\n')
      writeFileSync(join(configs, 'global'), '')
      const saved = { system: process.env.GIT_CONFIG_SYSTEM, global: process.env.GIT_CONFIG_GLOBAL }
      process.env.GIT_CONFIG_SYSTEM = join(configs, 'system')
      process.env.GIT_CONFIG_GLOBAL = join(configs, 'global')
      try {
        const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mousse-project-git-crlf-')))
        dirs.push(root)
        const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' })
        git('init', '-q')
        writeFileSync(join(root, 'crlf.txt'), 'l1\r\nl2\r\nl3\r\n')
        writeFileSync(join(root, 'same.txt'), 'x\r\ny\r\n')
        git('add', '.')
        git('commit', '-q', '-m', 'crlf')
        writeFileSync(join(root, 'crlf.txt'), 'l1\r\nCHANGED\r\nl3\r\n')
        utimesSync(join(root, 'same.txt'), new Date(Date.now() + 5_000), new Date(Date.now() + 5_000))
        const s = await setup({ projectPath: root, modeFacts: { readOnly: false, agent: false, build: true } })
        const diff = await s.call('git_diff', { path: 'crlf.txt' })
        expect(diff.isError).toBe(false)
        expect(diff.text).toContain('+CHANGED')
        expect(diff.text).not.toContain('-l1')
        expect(diff.text).not.toContain('-l3')
        const status = JSON.parse((await s.call('git_status', {})).text) as { changes: Array<{ path: string }> }
        expect(status.changes.map((change) => change.path)).toEqual(['crlf.txt'])
      } finally {
        for (const [key, value] of [['GIT_CONFIG_SYSTEM', saved.system], ['GIT_CONFIG_GLOBAL', saved.global]] as const) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      }
    })
  })

  describe('a definition that can write, in a repository inside another one', () => {
    it('a thread worktree under a repository (as Mousse keeps them) is read', async () => {
      const top = repo()
      const worktree = join(top, '.mousse', 'worktrees', 'agents', 'x')
      execFileSync('git', ['worktree', 'add', '-q', worktree], { cwd: top, stdio: 'pipe' })
      writeFileSync(join(worktree, 'a.txt'), 'worktree change\n')
      const s = await setup({ projectPath: worktree, definition: { policy: policy(worktree), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
      expect(await s.call('git_diff', { path: 'a.txt' })).toMatchObject({ isError: false, text: expect.stringContaining('+worktree change') })
      expect(JSON.parse((await s.call('git_status', {})).text)).toMatchObject({ isRepo: true, changes: [expect.objectContaining({ path: 'a.txt' })] })
    })

    it('a submodule checkout opened as the project is read', async () => {
      const { top } = parentRepo()
      const inner = repo()
      execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'mod'], { cwd: top, stdio: 'pipe' })
      const sub = join(top, 'mod')
      writeFileSync(join(sub, 'a.txt'), 'submodule change\n')
      const s = await setup({ projectPath: sub, definition: { policy: policy(sub), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
      expect(await s.call('git_diff', { path: 'a.txt' })).toMatchObject({ isError: false, text: expect.stringContaining('+submodule change') })
      const status = await s.call('git_status', {})
      expect(status.isError).toBe(false)
      expect(JSON.parse(status.text).changes.map((change: { path: string }) => change.path)).toEqual(['a.txt'])
      expect(status.text).not.toContain('secret')
    })

    it('a project inside a folder that is itself a repository (a home folder kept in Git) is read', async () => {
      const home = repo()
      const project = join(home, 'code', 'proj')
      mkdirSync(project, { recursive: true })
      const git = (...args: string[]) => execFileSync('git', args, { cwd: project, stdio: 'pipe' })
      git('init', '-q')
      git('config', 'user.email', 'test@example.invalid')
      git('config', 'user.name', 'Test')
      git('config', 'commit.gpgsign', 'false')
      writeFileSync(join(project, 'p.txt'), 'one\n')
      git('add', 'p.txt')
      git('commit', '-q', '-m', 'p')
      writeFileSync(join(project, 'p.txt'), 'two\n')
      const s = await setup({ projectPath: project, definition: { policy: policy(project), grants: grants('git_status', 'git_diff') } as DefinitionAuthority })
      expect(await s.call('git_diff', { path: 'p.txt' })).toMatchObject({ isError: false, text: expect.stringContaining('+two') })
      expect(JSON.parse((await s.call('git_status', {})).text).changes.map((change: { path: string }) => change.path)).toEqual(['p.txt'])
    })
  })

  describe('the workflow tools run the same scoped read (ProjectGitTools.execute)', () => {
    it("Sol's repros: a magic pathspec and the parent repository stay out, for a definition's roots and a Build turn", async () => {
      const { allowed } = parentRepo()
      const tools = new ProjectGitTools(new FileService(), new GitService())
      for (const roots of [[allowed], undefined]) {
        for (const staged of [false, true]) {
          const diff = await tools.execute('git_diff', { path: ':(top)secret.txt', staged }, allowed, roots)
          expect(diff.text).not.toContain(SECRET)
        }
        const status = await tools.execute('git_status', {}, allowed, roots)
        expect(status.isError).toBe(false)
        expect(status.text).not.toContain('secret')
        expect(JSON.parse(status.text).changes.map((change: { path: string }) => change.path)).toEqual(['a.txt'])
        expect(await tools.execute('git_diff', { path: 'a.txt' }, allowed, roots)).toMatchObject({ isError: false, text: expect.stringContaining('+two') })
      }
    })
  })

  it('a host that does not read the repository registers none', () => {
    const { registry, families } = createAppToolRegistry({ host: fakeAppToolHost().host })
    expect(families.projectGit).toEqual([])
    expect(registry.get('git_status')).toBeUndefined()
  })
})
