/**
 * Mousse's refs (`refs/mousse/`, two per change receipt) are written loose and gathered by the thousand. Once enough are
 * loose they are packed into `packed-refs`, and only they: the person's branches and tags stay as they were, every ref
 * keeps its value, and nothing is packed while a Mousse ref transaction holds the repository's lease.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { LOOSE_MOUSSE_REFS_TO_PACK, packMousseRefs } from '../src/mms/actions/packMousseRefs'
import { acquireRepositoryLease } from '../src/mms/git/RepositoryLease'
import { resolveRepositoryIdentityAsync } from '../src/mms/git/RepositoryIdentity'
import { git, gitFoundationFixture } from './fixtures/gitFoundation'

let f: ReturnType<typeof gitFoundationFixture>
beforeEach(() => { f = gitFoundationFixture() })
afterEach(() => f.dispose())

/** Every ref with its value, and what HEAD names: what a pack must leave exactly as it was. */
const refs = (): string => `${git(f.repo, 'for-each-ref', '--format=%(refname) %(objectname)')}\n${git(f.repo, 'symbolic-ref', 'HEAD')}`
function looseFiles(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
}
const looseMousse = (): string[] => looseFiles(join(f.repo, '.git', 'refs', 'mousse'))

/** `receipts` change receipts' refs, a kept-files ref, and the person's own loose branch and tag, in one transaction. */
function seedRefs(receipts: number): void {
  const lines = ['start']
  for (let index = 0; index < receipts; index++) lines.push(`create refs/mousse/changes/receipt-${index}/before ${f.baseSha}`, `create refs/mousse/changes/receipt-${index}/after ${f.baseSha}`)
  lines.push(`create refs/mousse/preserved/kept ${f.baseSha}`, `create refs/heads/feature ${f.baseSha}`, `create refs/tags/v1 ${f.baseSha}`, 'prepare', 'commit', '')
  execFileSync('git', ['update-ref', '--stdin'], { cwd: f.repo, input: lines.join('\n'), stdio: ['pipe', 'pipe', 'pipe'] })
}

it('packs the loose Mousse refs once there are enough, and leaves every other ref and every value as it was', async () => {
  seedRefs(LOOSE_MOUSSE_REFS_TO_PACK / 2)
  const before = refs()
  expect(looseMousse()).toHaveLength(LOOSE_MOUSSE_REFS_TO_PACK + 1)

  expect(await packMousseRefs(f.repo)).toBe('packed')

  expect(refs()).toBe(before)
  expect(looseMousse()).toEqual([])
  expect(readFileSync(join(f.repo, '.git', 'packed-refs'), 'utf8')).toContain('refs/mousse/changes/receipt-0/before')
  // The person's own refs are not Mousse's to pack.
  expect(existsSync(join(f.repo, '.git', 'refs', 'heads', 'feature'))).toBe(true)
  expect(existsSync(join(f.repo, '.git', 'refs', 'tags', 'v1'))).toBe(true)
})

it('leaves a few loose refs alone', async () => {
  seedRefs(4)
  expect(await packMousseRefs(f.repo)).toBe('few')
  expect(looseMousse()).toHaveLength(9)
  expect(existsSync(join(f.repo, '.git', 'packed-refs'))).toBe(false)
})

it('does not pack while a Mousse ref transaction holds the repository lease, and packs once it is free', async () => {
  seedRefs(LOOSE_MOUSSE_REFS_TO_PACK)
  const lease = await acquireRepositoryLease(await resolveRepositoryIdentityAsync(f.repo, { requireMutationCapability: true }))
  try {
    expect(await packMousseRefs(f.repo)).toBe('busy')
    expect(looseMousse()).toHaveLength(LOOSE_MOUSSE_REFS_TO_PACK * 2 + 1)
  } finally { lease.release() }
  expect(await packMousseRefs(f.repo)).toBe('packed')
  expect(looseMousse()).toEqual([])
})
