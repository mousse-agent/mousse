import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { git, gitAsync } from '../actions/git'
import { assertUndoRefMayBeClaimed } from '../actions/undoRefClaims'
import { expiredReceiptIdsFromJournal } from '../actions/UndoRetentionService'
import { AgentEpisodeStore } from '../agents/AgentEpisodeStore'
import { namedEpisodeClaims } from '../agents/namedEpisodeClaims'
import { ThreadJournal } from '../data/ThreadJournal'
import { resolveRepositoryIdentity, resolveRepositoryIdentityAsync, type RepositoryIdentity } from '../git/RepositoryIdentity'
import { acquireRepositoryLease, RepositoryLeaseBusyError, tryAcquireRepositoryLease } from '../git/RepositoryLease'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { assertLifecyclePath } from './ResourceLifecycleStore'

const RECEIPT_REF = /^refs\/mousse\/changes\/([0-9a-f-]{36})\/(before|after)$/i
const REF_LIST = ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/mousse/changes/']

/** Missing metadata is optional. Malformed or inaccessible metadata may hide a live claim. */
function readJson(root: string, ...names: string[]): unknown {
  const path = join(root, ...names)
  assertLifecyclePath(root, path)
  try {
    if (!lstatSync(path).isFile()) throw new Error('Cannot read Undo claim authority: ' + path)
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** A pre-existing thread folder's live repository claims, even when every recorded checkout is unavailable. */
function threadUndoClaims(location: string) {
  const workspace = (readJson(location, 'workspace.json') ?? readJson(location, 'project-folder.json')) as { worktreePath?: string; repositoryId?: string; integrationTarget?: { checkoutPath?: string } } | undefined
  // Snapshot-only repositories are private stores and use their own retention and ownership protocol.
  if (!workspace && readJson(location, 'snapshot-workspace.json')) return undefined
  const journal = new ThreadJournal(location, { readOnly: true })
  const expired = expiredReceiptIdsFromJournal(journal.ofTypes('undo-retention'))
  const receipts = journal.receipts()
  const agents = new AgentEpisodeStore(location)
  assertLifecyclePath(location, agents.path)
  const named = agents.read()
  const recalled = new Set(namedEpisodeClaims(named, receipts, (agentId, episodeId) => readJson(location, 'agent-contexts', agentId, episodeId + '.json'))
    .flatMap(({ episode, recall, pending }) => (recall || pending) && episode.result?.receiptId ? [episode.result.receiptId] : []))
  const refs = new Map<string, string | undefined>()
  const add = (receipt: (typeof receipts)[number]): void => {
    for (const ref of receipt.retainedRefs ?? []) {
      const match = RECEIPT_REF.exec(ref)
      if (match?.[1] === receipt.id) refs.set(ref, match[2] === 'before' ? receipt.beforeSha : receipt.afterSha)
    }
  }
  for (const receipt of receipts) if (!expired.has(receipt.id) || recalled.has(receipt.id)) add(receipt)
  for (const { id } of named.identities) {
    if (!/^[a-z0-9][a-z0-9_-]{2,127}$/i.test(id)) throw new Error('Invalid named agent journal identity')
    const agentDir = join(location, 'agent-changes', id)
    assertLifecyclePath(location, join(agentDir, 'journal'))
    for (const receipt of new ThreadJournal(agentDir, { readOnly: true }).receipts()) if (recalled.has(receipt.id)) add(receipt)
  }
  const branches = readJson(location, 'conversation-branches.json') as Array<{ retainedRef?: string }> | undefined
  for (const { retainedRef } of branches ?? []) {
    if (retainedRef && RECEIPT_REF.test(retainedRef) && !refs.has(retainedRef)) refs.set(retainedRef, undefined)
  }
  if (!refs.size) return undefined
  const paths = [...new Set([workspace?.worktreePath, workspace?.integrationTarget?.checkoutPath])]
    .filter((path): path is string => typeof path === 'string' && isAbsolute(path))
  return { paths, repositoryId: workspace?.repositoryId, refs }
}

type Claims = NonNullable<ReturnType<typeof threadUndoClaims>>

function matches(repository: RepositoryIdentity, claims: Claims): boolean {
  return repository.capability.allowed && (!claims.repositoryId || repository.key === claims.repositoryId)
}

function assertUnreserved(repository: RepositoryIdentity, claims: Claims): void {
  for (const ref of claims.refs.keys()) assertUndoRefMayBeClaimed(repository, RECEIPT_REF.exec(ref)![1]!)
}

function assertRefsPresent(claims: Claims, listing: string): void {
  const direct = new Map(listing.split(/\r?\n/).map((row) => row.split('\0')).filter(([name, oid, symref]) => name && oid && !symref).map(([name, oid]) => [name!, oid!]))
  for (const [ref, expected] of claims.refs) {
    const oid = direct.get(ref)
    if (!oid || expected !== undefined && expected !== oid) throw new Error('Cannot publish unavailable Undo reference: ' + ref)
  }
}

/** Registration and legacy copies publish pre-existing Undo claims under the same lease as release. */
export function withCopiedUndoClaims<T>(location: string, publish: () => T): T {
  const claims = threadUndoClaims(location)
  if (!claims) return publish()
  for (const cwd of claims.paths) {
    const repository = resolveRepositoryIdentity(cwd)
    if (!matches(repository, claims)) continue
    const lease = tryAcquireRepositoryLease(repository)
    if (!lease) throw new RepositoryLeaseBusyError()
    try {
      assertUnreserved(repository, claims)
      assertRefsPresent(claims, git(repository.commonDir, REF_LIST, READ_ONLY_GIT_ENV))
      return publish()
    } finally { lease.release() }
  }
  throw new Error('Cannot verify the repository of the copied Undo history.')
}

/** Keep a registered claim visible throughout a rename by sharing the release lease. */
export async function withMovingUndoClaims<T>(location: string, move: () => T, restore: boolean): Promise<T> {
  const claims = threadUndoClaims(location)
  if (!claims) return move()
  for (const cwd of claims.paths) {
    const repository = await resolveRepositoryIdentityAsync(cwd)
    if (!matches(repository, claims)) continue
    const lease = await acquireRepositoryLease(repository, { maxWaitMs: 30_000 })
    try {
      if (restore) {
        assertUnreserved(repository, claims)
        assertRefsPresent(claims, await gitAsync(repository.commonDir, REF_LIST, READ_ONLY_GIT_ENV))
      }
      return move()
    } finally { lease.release() }
  }
  if (restore) throw new Error('Cannot verify the repository of the restored Undo history.')
  // Trash does not publish an owner. Its lifecycle record continues to associate the claims with the thread.
  return move()
}
