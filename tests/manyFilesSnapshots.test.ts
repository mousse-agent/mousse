import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { gitAsync, LISTING, tryGitAsync } from '../src/mms/actions/git'
import { restoreChangeAsync, takeSnapshotAsync } from '../src/mms/actions/snapshots'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { GitService } from '../src/mms/git/GitService'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'

/** Enough files that `ls-files -s -z` and `ls-tree -r -z` print well over the 1 MiB an ordinary Git command may. */
const FILES = 20_000
const path = (index: number) => `packages/module-${String(index % 200).padStart(3, '0')}/src/components/file-${String(index).padStart(5, '0')}.ts`
const SHARED = 'export const shared = true\n'
/** Files with contents of their own; every other file shares one blob, so the fixture is written in a second or two. */
const sample = [0, 1, 4_999, 12_345, FILES - 1]
const content = (index: number) => sample.includes(index) ? `export const value${index} = ${index}\n` : SHARED

let f: ReturnType<typeof gitFoundationFixture>
let cwd: string
beforeAll(async () => {
  f = gitFoundationFixture()
  // The index is written directly (no file is hashed one by one), then the thread's worktree checks it out.
  const blob = (text: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.repo, input: text, encoding: 'utf8' }).trim()
  const shared = blob(SHARED)
  const lines = Array.from({ length: FILES }, (_, index) => `100644 ${sample.includes(index) ? blob(content(index)) : shared}\t${path(index)}`)
  execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: f.repo, input: lines.join('\n') + '\n' })
  git(f.repo, 'commit', '-qm', 'many files')
  cwd = (await new ThreadWorkspaceManager(f.thread).provision('task', 'main', f.repo)).worktreePath
}, 60_000)
afterAll(() => f.dispose())

describe('a repository with many files', () => {
  it('lists its index and trees in full', async () => {
    const index = await gitAsync(cwd, ['ls-files', '-s', '-z'], undefined, undefined, LISTING)
    expect(Buffer.byteLength(index)).toBeGreaterThan(1024 * 1024)
    expect(index.split('\0').filter(Boolean)).toHaveLength(FILES + 1)
    const tree = await tryGitAsync(cwd, ['ls-tree', '-r', '-z', 'HEAD'], undefined, LISTING)
    expect(tree.ok).toBe(true)
    expect(tree.stdout.split('\0').filter(Boolean)).toHaveLength(FILES + 1)
  })

  it('a Git panel read returns the whole listing', async () => {
    const service = new GitService() as unknown as { read(cwd: string, args: readonly string[]): Promise<string | null> }
    expect((await service.read(cwd, ['ls-files', '-s', '-z']))?.split('\0').filter(Boolean)).toHaveLength(FILES + 1)
  })

  it('an ordinary command still fails, rather than returning part of the output, past the ordinary limit', async () => {
    await expect(gitAsync(cwd, ['ls-files', '-s', '-z'])).rejects.toThrow(/Command failed: git .*ls-files/)
    expect((await tryGitAsync(cwd, ['ls-tree', '-r', '-z', 'HEAD'])).ok).toBe(false)
  })

  it('records a turn as a snapshot, and Undo brings the files back byte for byte', async () => {
    const actions = new ThreadActionService(f.thread)
    const { action } = await actions.runCheckpointedAction(actionOptions(cwd), () => {
      for (const index of sample) writeFileSync(join(cwd, path(index)), `changed by the turn ${index}\n`)
      writeFileSync(join(cwd, 'added.txt'), 'added\n')
    })
    expect(action.reversible).not.toBe(false)
    expect(git(cwd, 'show', `${action.endSha}:${path(12_345)}`)).toBe('changed by the turn 12345')
    expect(git(cwd, 'ls-tree', '-r', '--name-only', action.endSha).split('\n')).toHaveLength(FILES + 2)

    const ours = await takeSnapshotAsync(cwd, { reason: 'before undo' })
    const restored = await restoreChangeAsync(cwd, { reason: 'undo', base: action.endSha, ours: ours.sha, theirs: action.startSha })
    expect('conflicts' in restored).toBe(false)
    for (const index of [...sample, 2, 19_998]) expect(readFileSync(join(cwd, path(index)))).toEqual(Buffer.from(content(index)))
    expect(() => readFileSync(join(cwd, 'added.txt'))).toThrow()
  }, 60_000)
})
