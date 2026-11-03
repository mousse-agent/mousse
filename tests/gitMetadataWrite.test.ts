/**
 * A write by an agent's file tool into Git's own files counts as a command for the permission mode: Ask asks,
 * Auto-accept edits and Auto now ask too, Full access writes. Judged on the real path the write lands on.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { permissionActionForWrite } from '../src/mms/files/gitMetadataWrite'
import { writeWorkspaceFile } from '../src/mms/harness/acp/permissions'
import { UserQuestionService } from '../src/mms/orchestrator/UserQuestionService'
import type { PermissionMode } from '../src/shared/permissionMode'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'git-metadata-write-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  }).trim()

let count = 0
function repo(): string {
  const cwd = join(base, `repo-${count++}`)
  mkdirSync(cwd)
  git(cwd, 'init', '-q', '-b', 'main')
  writeFileSync(join(cwd, 'base.txt'), 'base\n')
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-q', '-m', 'base')
  git(cwd, 'branch', 'other')
  return cwd
}

function writeAs(mode: PermissionMode, cwd: string, path: string, content: string, answer?: 'allow' | 'reject') {
  const questions = new UserQuestionService()
  const asked: Array<{ prompt: string; action: unknown }> = []
  // The action the approval carries decides who may answer it (a device or agent limited to edits may not).
  const pending = (questions as unknown as { pending: Map<string, { approval?: { action: unknown } }> }).pending
  questions.on('pending', (event: { requestId: string; questions: Array<{ prompt: string }> }) => {
    asked.push({ prompt: event.questions[0]!.prompt, action: pending.get(event.requestId)?.approval?.action })
    if (answer) questions.submitAnswers(event.requestId, { write: answer }, { kind: 'user' })
  })
  const scope = { threadId: 'thread', cwd, permissionMode: mode, aborted: () => false, throwIfAborted: () => {} }
  const done = writeWorkspaceFile(questions, scope, { sessionId: 's', path: join(cwd, path), content }, 'Antigravity')
  return { asked, done }
}

describe('ACP writes into Git metadata', () => {
  it('asks once under Auto-accept edits and Auto, naming the file; a rejection leaves HEAD byte for byte', async () => {
    for (const mode of ['accept_edits', 'auto'] as const) {
      const cwd = repo()
      const before = readFileSync(join(cwd, '.git', 'HEAD'))
      const { asked, done } = writeAs(mode, cwd, '.git/HEAD', 'ref: refs/heads/other\n', 'reject')
      await expect(done).rejects.toThrow('rejected')
      expect(asked).toEqual([{ prompt: "Allow Antigravity to change Git's own files (.git/HEAD)?", action: 'command' }])
      expect(readFileSync(join(cwd, '.git', 'HEAD')).equals(before)).toBe(true)
      expect(git(cwd, 'branch', '--show-current')).toBe('main')
    }
  })

  it('writes once the person allows it', async () => {
    const cwd = repo()
    const { asked, done } = writeAs('accept_edits', cwd, '.git/HEAD', 'ref: refs/heads/other\n', 'allow')
    await done
    expect(asked).toHaveLength(1)
    expect(git(cwd, 'branch', '--show-current')).toBe('other')
  })

  it('writes without asking under Full access, as the same command in the shell would', async () => {
    const cwd = repo()
    const { asked, done } = writeAs('full', cwd, '.git/HEAD', 'ref: refs/heads/other\n')
    await done
    expect(asked).toEqual([])
    expect(git(cwd, 'branch', '--show-current')).toBe('other')
  })

  it('asks through a link that leads into .git, and names where it lands', async () => {
    const cwd = repo()
    symlinkSync(join(cwd, '.git', 'HEAD'), join(cwd, 'head-link'))
    const before = readFileSync(join(cwd, '.git', 'HEAD'))
    const { asked, done } = writeAs('accept_edits', cwd, 'head-link', 'ref: refs/heads/other\n', 'reject')
    await expect(done).rejects.toThrow('rejected')
    expect(asked.map((entry) => entry.prompt)).toEqual(["Allow Antigravity to change Git's own files (.git/HEAD, written as head-link)?"])
    expect(readFileSync(join(cwd, '.git', 'HEAD')).equals(before)).toBe(true)
  })

  it('leaves ordinary files, .gitignore and .github/ as edits', async () => {
    const cwd = repo()
    for (const path of ['.gitignore', '.github/workflows/ci.yml', 'src/a.ts']) {
      const { asked, done } = writeAs('accept_edits', cwd, path, 'x\n')
      await done
      expect(asked).toEqual([])
      expect(readFileSync(join(cwd, path), 'utf8')).toBe('x\n')
    }
  })
})

describe('permissionActionForWrite', () => {
  it('classes Git folder spellings, links and aliases as commands', async () => {
    const cwd = repo()
    symlinkSync(join(cwd, '.git'), join(cwd, 'meta-link'))
    for (const path of ['.git/HEAD', 'GIT~1/HEAD', '.GIT/config', 'meta-link/config', 'sub/.git', 'nested/.git/hooks/pre-commit'])
      expect(await permissionActionForWrite(cwd, path), path).toMatchObject({ action: 'command' })
    // Without a folder, only the name decides.
    expect(await permissionActionForWrite(undefined, '.git/config')).toEqual({ action: 'command', gitFile: '.git/config' })
    expect(await permissionActionForWrite(undefined, 'notes.md')).toEqual({ action: 'edit' })
  })

  it("classes a linked worktree's common folder and its own Git folder as commands", async () => {
    const main = repo()
    const worktree = join(base, `linked-${count++}`)
    git(main, 'worktree', 'add', '-q', '-b', 'linked', worktree)
    const gitDir = git(worktree, 'rev-parse', '--absolute-git-dir')
    for (const path of [join(main, '.git', 'config'), join(gitDir, 'HEAD'), '.git'])
      expect(await permissionActionForWrite(worktree, path), path).toMatchObject({ action: 'command' })
    expect(await permissionActionForWrite(worktree, 'base.txt')).toEqual({ action: 'edit' })
  })

  it('finds a Git folder by what Git says, whatever it is called', async () => {
    const cwd = join(base, `separate-${count++}`)
    mkdirSync(cwd)
    git(cwd, 'init', '-q', '-b', 'main', `--separate-git-dir=${join(cwd, 'store')}`)
    expect(await permissionActionForWrite(cwd, 'store/HEAD')).toEqual({ action: 'command', gitFile: 'store/HEAD' })
    expect(await permissionActionForWrite(cwd, 'storefront/index.html')).toEqual({ action: 'edit' })
  })

  it('classes the hooks folder and included configuration as commands', async () => {
    const cwd = repo()
    git(cwd, 'config', 'core.hooksPath', '.githooks')
    git(cwd, 'config', 'include.path', '../shared.gitconfig')
    writeFileSync(join(cwd, 'shared.gitconfig'), '')
    expect(await permissionActionForWrite(cwd, '.githooks/pre-commit')).toMatchObject({ action: 'command' })
    expect(await permissionActionForWrite(cwd, 'shared.gitconfig')).toMatchObject({ action: 'command' })
    expect(await permissionActionForWrite(cwd, '.gitignore')).toEqual({ action: 'edit' })
    expect(await permissionActionForWrite(cwd, '.github/CODEOWNERS')).toEqual({ action: 'edit' })
  })
})
