/**
 * The checkpoint path asks Git less (`snapshots.ts`, `ThreadActionService.ts`): the settings are read once for both the
 * conversion check and the exact tree, and a start the snapshot just made or found is not checked again. What a person
 * gets must not change: the exact bytes Undo restores, and the start a turn begins from.
 *
 * Settings (one row each): none; `core.autocrlf` false, true, input, a bare key (Git reads it as true), and a key
 * spelled in capitals in the config file (Git's keys are case-insensitive). Then the scopes, where the last value Git
 * reads wins: `true` system-wide (as Git for Windows sets it) alone, and turned off by a global or repository `false`;
 * a global `false` turned on again by the repository. And `core.eol`, which converts only files with a `text`
 * attribute: alone, and with `* text=auto`. Each row runs with its own system and global config files.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { takeSnapshotAsync } from '../src/mms/actions/snapshots'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'

const roots: string[] = []
const scopes = { system: process.env.GIT_CONFIG_SYSTEM, global: process.env.GIT_CONFIG_GLOBAL }
afterEach(() => {
  for (const [key, value] of [['GIT_CONFIG_SYSTEM', scopes.system], ['GIT_CONFIG_GLOBAL', scopes.global]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

function repository(configure: (repo: string) => void): { base: string; repo: string } {
  const base = mkdtempSync(join(tmpdir(), 'mousse-trims-')); roots.push(base)
  // The row's own system and global config, empty unless it writes them: never this computer's.
  process.env.GIT_CONFIG_SYSTEM = join(base, 'system.gitconfig'); writeFileSync(process.env.GIT_CONFIG_SYSTEM, '')
  process.env.GIT_CONFIG_GLOBAL = join(base, 'global.gitconfig'); writeFileSync(process.env.GIT_CONFIG_GLOBAL, '')
  const repo = join(base, 'repo'); mkdirSync(repo)
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test')
  git(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'value.txt'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'config', '--unset', 'core.autocrlf')
  configure(repo)
  return { base, repo }
}

const SETTINGS: Array<[string, (repo: string) => void, boolean]> = [
  ['no setting', () => undefined, false],
  ['autocrlf false', (repo) => git(repo, 'config', 'core.autocrlf', 'false'), false],
  ['autocrlf true', (repo) => git(repo, 'config', 'core.autocrlf', 'true'), true],
  ['autocrlf input', (repo) => git(repo, 'config', 'core.autocrlf', 'input'), true],
  ['a bare autocrlf key', (repo) => appendFileSync(join(repo, '.git', 'config'), '[core]\n\tautocrlf\n'), true],
  ['AutoCRLF in capitals', (repo) => appendFileSync(join(repo, '.git', 'config'), '[Core]\n\tAutoCRLF = true\n'), true],
  ['autocrlf true system-wide', () => scope('system', 'core.autocrlf', 'true'), true],
  ['autocrlf true system-wide, false globally', () => { scope('system', 'core.autocrlf', 'true'); scope('global', 'core.autocrlf', 'false') }, false],
  ['autocrlf true system-wide, false in the repository', (repo) => { scope('system', 'core.autocrlf', 'true'); git(repo, 'config', 'core.autocrlf', 'false') }, false],
  ['autocrlf false globally, true in the repository', (repo) => { scope('global', 'core.autocrlf', 'false'); git(repo, 'config', 'core.autocrlf', 'true') }, true],
  ['eol crlf alone', () => scope('global', 'core.eol', 'crlf'), false],
  ['eol crlf with text=auto', (repo) => { scope('global', 'core.eol', 'crlf'); writeFileSync(join(repo, '.gitattributes'), '* text=auto\n') }, true]
]

/** Sets `key` in the row's system or global config file. */
function scope(level: 'system' | 'global', key: string, value: string): void {
  execFileSync('git', ['config', '--file', process.env[level === 'system' ? 'GIT_CONFIG_SYSTEM' : 'GIT_CONFIG_GLOBAL']!, key, value])
}

describe('the settings read once for a snapshot', () => {
  it.each(SETTINGS)('%s: a CRLF file keeps its exact bytes only when Git converts it', async (_name, configure, converts) => {
    const { repo } = repository(configure)
    writeFileSync(join(repo, 'value.txt'), 'line one\r\nline two\r\n')
    const snapshot = await takeSnapshotAsync(repo, { reason: 'test' })
    // Converted, Git stores LF and the exact tree keeps the CRLF bytes on disk; not converted, the two are one tree.
    expect(snapshot.exactTree !== snapshot.tree).toBe(converts)
    expect(execFileSync('git', ['cat-file', 'blob', `${snapshot.exactTree ?? snapshot.tree}:value.txt`], { cwd: repo }).toString()).toBe('line one\r\nline two\r\n')
    // The second index, which reads every file again with conversions off, is built only where Git converts.
    expect(existsSync(resolve(repo, git(repo, 'rev-parse', '--git-path', 'mousse/snapshot-exact-index')))).toBe(converts)
  })
})

describe('the start a turn begins from', () => {
  const outside = (repo: string) => ({ threadId: 'thread', conversationBranchId: 'main', workspacePath: repo, presentationMessageStart: 0, nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' } })
  const turn = (repo: string, turnId: string) => ({
    threadId: 'thread', turnId, conversationBranchId: 'main', workspacePath: repo, presentationMessageStart: 0, presentationMessageEnd: 1,
    nativeContextStartBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' },
    nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }
  })

  it.each([
    ['nothing changed outside Mousse', (_repo: string) => undefined],
    ['the person edited a file', (repo: string) => writeFileSync(join(repo, 'value.txt'), 'edited by the person\n')]
  ])('%s: the snapshot hands over the check, and the turn begins where checking it again would have', async (_name, change) => {
    const { base, repo } = repository(() => undefined)
    const thread = join(base, 'thread'); mkdirSync(thread)
    const actions = new ThreadActionService(thread)
    change(repo)
    const recorded = await actions.recordOutsideChanges(outside(repo))
    expect(recorded.startCheck).toEqual({ workspacePath: repo, startSha: recorded.startSha })
    expect(recorded.startCheck).toEqual(await actions.checkTurnStart(repo, recorded.startSha))
    expect(git(repo, 'cat-file', '-t', recorded.startSha)).toBe('commit')
    const begun = actions.beginTurn(turn(repo, 'turn'), recorded.startSha, recorded.startCheck)
    expect(begun.startSha).toBe(recorded.startSha)
  })
})
