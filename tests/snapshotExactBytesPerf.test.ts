/**
 * What recording exact bytes costs a snapshot of 20,000 files, with and without conversions (`core.autocrlf=true`, as
 * Git for Windows sets it), against snapshots without exact trees. Prints the times; run it on purpose with
 * `MOUSSE_SNAPSHOT_PERF=1 npx vitest run tests/snapshotExactBytesPerf.test.ts`. A last case puts 2,000 of the files under a
 * filter, half of which loses bytes, and times the snapshots that check them.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { recordExactTrees, takeSnapshotAsync } from '../src/mms/actions/snapshots'
import { trustRepositoryPrograms } from '../src/mms/git/repoPrograms'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { UndoService } from '../src/mms/actions/UndoService'
import { actionOptions, git, gitFoundationFixture } from './fixtures/gitFoundation'
import { pressed } from './support/userRequest'

const FILES = 20_000
const path = (index: number) => `packages/module-${String(index % 200).padStart(3, '0')}/src/file-${String(index).padStart(5, '0')}.ts`

let f: ReturnType<typeof gitFoundationFixture>
beforeAll(() => {
  f = gitFoundationFixture()
  // Every file its own blob, so a snapshot that reads them all hashes 20,000 files.
  for (let index = 0; index < FILES; index++) {
    const file = join(f.repo, path(index))
    if (index < 200) mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `export const value${index} = ${index}\nexport const next${index} = ${index + 1}\n`)
  }
  git(f.repo, 'add', '-A')
  git(f.repo, 'commit', '-qm', 'many files')
}, 600_000)
afterAll(() => f.dispose())

async function timed<T>(work: () => Promise<T>): Promise<number> {
  const start = performance.now()
  await work()
  return Math.round(performance.now() - start)
}

describe.skipIf(!process.env.MOUSSE_SNAPSHOT_PERF)('snapshot time, 20,000 files', () => {
  const results: string[] = []
  afterAll(() => { process.stderr.write(`\n${results.join("\n")}\n`) })
  for (const autocrlf of ['false', 'true']) {
    for (const exact of [false, true]) {
      it(`autocrlf=${autocrlf}, exact trees ${exact ? 'on' : 'off'}`, async () => {
        git(f.repo, 'config', 'core.autocrlf', autocrlf)
        const worktree = join(f.root, `wt-${autocrlf}-${exact}`)
        git(f.repo, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
        recordExactTrees(exact)
        try {
          const cold = await timed(() => takeSnapshotAsync(worktree, { reason: 'cold' }))
          const warm: number[] = []
          for (let round = 0; round < 3; round++) {
            writeFileSync(join(worktree, path(round * 7)), `changed ${round}\n`)
            warm.push(await timed(() => takeSnapshotAsync(worktree, { reason: `warm ${round}` })))
          }
          warm.sort((a, b) => a - b)
          // A turn that changes one file, then its Undo: two snapshots and the restore.
          const thread = join(f.root, `thread-${autocrlf}-${exact}`)
          mkdirSync(thread)
          await new ThreadActionService(thread).runCheckpointedAction(actionOptions(worktree), () => writeFileSync(join(worktree, path(11)), 'the turn\n'))
          const undo = await timed(() => pressed('Undo', () => new UndoService(thread).undoLatest('main', worktree)))
          results.push(`autocrlf=${autocrlf} exact=${exact ? 'on ' : 'off'}: first snapshot ${cold} ms, next (one file changed, median of 3) ${warm[1]} ms, Undo of one file ${undo} ms`)
          expect(cold).toBeGreaterThan(0)
        } finally {
          recordExactTrees(true)
        }
      }, 600_000)
    }
  }

  it('autocrlf=input, 2,000 files under a filter, 1,000 of them losing bytes', async () => {
    git(f.repo, 'config', 'core.autocrlf', 'input')
    git(f.repo, 'config', 'filter.strip.clean', "sed 's/ *$//'"); git(f.repo, 'config', 'filter.strip.smudge', 'cat')
    const worktree = join(f.root, 'wt-filtered')
    git(f.repo, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
    trustRepositoryPrograms(worktree)
    // module-000 to module-019: 2,000 files, every other one with trailing spaces the clean filter drops.
    writeFileSync(join(worktree, '.gitattributes'), 'packages/module-0[01][0-9]/** filter=strip\n')
    for (let index = 0; index < FILES; index++) if (index % 200 < 20 && index % 2) appendFileSync(join(worktree, path(index)), '// spaces   \n')
    const checking: number[] = []
    for (let round = 0; round < 6; round++) {
      let named = 0
      checking.push(await timed(async () => { named = (await takeSnapshotAsync(worktree, { reason: `check ${round}` })).coverageGaps?.length ?? 0 }))
      if (!named) break
    }
    const warm: number[] = []
    for (let round = 0; round < 3; round++) {
      writeFileSync(join(worktree, path(round * 7 + 200)), `changed ${round}\n`)
      warm.push(await timed(() => takeSnapshotAsync(worktree, { reason: `warm ${round}` })))
    }
    warm.sort((a, b) => a - b)
    const unchanged = await timed(() => takeSnapshotAsync(worktree, { reason: 'unchanged' }))
    results.push(`autocrlf=input, 2,000 filtered: snapshots until all are checked ${checking.join(', ')} ms, next (one file changed, median of 3) ${warm[1]} ms, unchanged ${unchanged} ms`)
    expect(checking.length).toBeLessThan(6)
  }, 600_000)
})
