import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, ResourceLifecycleStore } from './ResourceLifecycleStore'
import type { RepositoryLeaseHandle } from '../git/RepositoryLease'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { assertHeldThreadLease } from '../actions/GitOperationCoordinator'
import { PROCESS_INSTANCE_ID } from '../queue/processLiveness'
import { AgentEpisodeStore } from '../agents/AgentEpisodeStore'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export function lifecycleGit(cwd: string, args: string[], input?: string, maxBuffer = 32 * 1024 * 1024): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd()
}
/** Never treat an unreadable reference as absent, and never dereference an owned symbolic ref. */
export function readDirectLifecycleRef(cwd: string, ref: string): string | undefined {
  try { lifecycleGit(cwd, ['symbolic-ref', '-q', ref]); throw new Error(`Symbolic resource reference is not cleanup authority: ${ref}`) }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error }
  const listing = spawnSync('git', ['for-each-ref', '--format=%(refname)%00%(objectname)', ref], { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
  // Git may warn about a corrupt loose ref while exiting successfully and omitting it.
  if (listing.error || listing.status !== 0 || listing.stderr.trim()) throw new Error(`Resource reference inventory is unreadable: ${ref}`)
  const rows = listing.stdout.split(/\r?\n/)
  const row = rows.find((entry) => entry.split('\0')[0] === ref)
  if (!row) return undefined
  const sha = row?.split('\0')[1]
  if (!sha || !/^[a-f0-9]{40,64}$/.test(sha) || /^0+$/.test(sha)) throw new Error(`Existing resource reference is malformed or unreadable: ${ref}`)
  return sha
}
function same(a: string, b: string): boolean { return (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)) }
export interface ContentEntry { path: string; kind: 'file' | 'directory' | 'link'; digest: string; bytes: number; mode: number }
export function assertFrozenContentEntry(root: string, entry: ContentEntry): void {
  const path = join(root, entry.path)
  assertLifecyclePath(dirname(root), root)
  if (entry.path) assertLifecyclePath(root, dirname(path))
  const stat = lstatSync(path)
  const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'unknown'
  if (kind !== entry.kind || stat.mode !== entry.mode || kind !== 'directory' && stat.size !== entry.bytes || kind === 'file' && stat.nlink > 1) throw new Error('Frozen content was replaced before mutation')
  const current = kind === 'link' ? hash(readlinkSync(path)) : kind === 'file' ? hash(readFileSync(path)) : ''
  if (current !== entry.digest) throw new Error('Frozen content changed before mutation')
}
/** A bounded walk that never follows links, crosses devices or enters Git administration. */
export function walkOwnedContent(root: string, skipRootGit = false): ContentEntry[] {
  assertLifecyclePath(dirname(root), root)
  const rootStat = lstatSync(root)
  const entries: ContentEntry[] = []
  let bytes = 0
  const walk = (path: string, depth: number): void => {
    if (depth > 64 || entries.length >= 100_000) throw new Error('Owned content exceeds bounded inventory limits')
    const stat = lstatSync(path)
    if (stat.dev !== rootStat.dev) throw new Error('Owned content crosses a filesystem boundary')
    const rel = relative(root, path).split('\\').join('/')
    if (stat.isSymbolicLink()) { entries.push({ path: rel, kind: 'link', digest: hash(readlinkSync(path)), bytes: stat.size, mode: stat.mode }); return }
    if (stat.isDirectory()) {
      entries.push({ path: rel, kind: 'directory', digest: '', bytes: 0, mode: stat.mode })
      for (const name of readdirSync(path).sort()) {
        if (skipRootGit && !rel && name === '.git') continue
        if (skipRootGit && name === '.git') throw new Error('Nested repository requires explicit retention')
        walk(join(path, name), depth + 1)
      }
      return
    }
    if (!stat.isFile() || stat.nlink > 1) throw new Error('Special or multiply linked content requires explicit retention')
    bytes += stat.size
    if (stat.size > 64 * 1024 * 1024 || bytes > 512 * 1024 * 1024) throw new Error('Owned content exceeds bounded byte limits')
    entries.push({ path: rel, kind: 'file', digest: hash(readFileSync(path)), bytes: stat.size, mode: stat.mode })
  }
  walk(root, 0)
  return entries
}

export interface WorktreeReconstructionManifest {
  schemaVersion: 1
  profileId: string
  taskId: string
  worktreePath: string
  branch: string
  repositoryId: string
  commonDir: string
  gitDirectory: string
  rootIdentity: { dev: number; ino: number; birthtimeMs: number }
  sourcePath: string
  baseSha: string
  resultSha: string
  treeSha: string
  checkoutFingerprint: string
  baseRef: string
  resultRef: string
  sparse?: { patterns: string; cone: boolean }
  auxiliary: Array<{ path: string; content: string }>
  content: ContentEntry[]
  state: 'prepared' | 'retired' | 'materialized'
}
export interface RetirementInput { taskId: string; worktreePath: string; branch: string; sourcePath: string; repositoryId?: string; baseSha?: string; resultSha?: string }
export interface RetirementOwnership { repositoryLease: RepositoryLeaseHandle; taskLease?: ThreadLeaseHandle; cleanupTaskId?: string; cleanupToken?: string; cleanupGeneration?: number }

/** Call under task execution ownership followed by repository mutation ownership. */
export class WorktreeRetirementService {
  constructor(readonly store: ResourceLifecycleStore, private readonly ownership?: RetirementOwnership) {}
  pathFor(taskId: string, worktreePath: string): string { return join(this.store.root, 'workspaces', taskId, `${hash(resolve(worktreePath))}.json`) }
  inspectForDiscard(input: RetirementInput) {
    this.verifySource(input)
    const identity = this.inspectIdentity(input.worktreePath, input.branch, input.repositoryId)
    return { ...identity, resultSha: lifecycleGit(input.worktreePath, ['rev-parse', 'HEAD']), indexDigest: hash(lifecycleGit(input.worktreePath, ['ls-files', '--stage', '-v', '-z'])), content: walkOwnedContent(input.worktreePath, true) }
  }
  load(path: string): WorktreeReconstructionManifest {
    assertLifecyclePath(this.store.root, path)
    const value = JSON.parse(readFileSync(path, 'utf8')) as WorktreeReconstructionManifest
    if (value.schemaVersion !== 1 || value.profileId !== this.store.profileId || !same(path, this.pathFor(value.taskId, value.worktreePath)) || !/^mousse\/(thread|agent|workflow)\//.test(value.branch)) throw new Error('Invalid workspace reconstruction authority')
    const prefix = `refs/mousse/lifecycle/${this.store.profileId}/${value.taskId}/${hash(value.worktreePath).slice(0, 32)}`
    if (value.baseRef !== `${prefix}/base` || value.resultRef !== `${prefix}/result` || ![value.worktreePath, value.commonDir, value.gitDirectory, value.sourcePath].every(isAbsolute) || ![value.baseSha, value.resultSha, value.treeSha].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)) || !/^[a-f0-9]{32}$/.test(value.repositoryId) || !Array.isArray(value.content) || !Array.isArray(value.auxiliary) || !['prepared', 'retired', 'materialized'].includes(value.state)) throw new Error('Malformed workspace reconstruction manifest')
    for (const entry of value.content) if (isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..') || !['file', 'directory', 'link'].includes(entry.kind) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Manifest content path is invalid')
    for (const entry of value.auxiliary) if (!['.mousse/materialized-inputs.exclude', '.mousse/task-progress.json'].includes(entry.path) || typeof entry.content !== 'string' || entry.content.length > 2 * 1024 * 1024) throw new Error('Manifest auxiliary payload is invalid')
    if (!/^[a-f0-9]{64}$/.test(value.checkoutFingerprint) || !value.rootIdentity || !Object.values(value.rootIdentity).every(Number.isFinite) || value.sparse && (typeof value.sparse.patterns !== 'string' || typeof value.sparse.cone !== 'boolean')) throw new Error('Manifest reconstruction state is invalid')
    return value
  }
  prepare(input: RetirementInput): WorktreeReconstructionManifest {
    return this.store.withGate(input.taskId, () => {
      const source = this.verifySource(input)
      const identity = this.inspectIdentity(input.worktreePath, input.branch, input.repositoryId)
      this.assertOwnership(input.taskId, identity.commonDir, identity.repositoryId)
      this.store.enableCleanupWriter()
      const resultSha = lifecycleGit(input.worktreePath, ['rev-parse', 'HEAD'])
      if ((input.resultSha && input.resultSha !== resultSha) || (source.resultSha && source.resultSha !== resultSha)) throw new Error('Workspace result changed before retirement')
      if (input.baseSha && source.baseSha && input.baseSha !== source.baseSha) throw new Error('Workspace base changed before retirement')
      const baseSha = input.baseSha ?? source.baseSha ?? resultSha
      lifecycleGit(input.worktreePath, ['cat-file', '-e', `${baseSha}^{commit}`])
      const contents = this.inspectContent(input.worktreePath)
      const key = hash(input.worktreePath).slice(0, 32)
      const prefix = `refs/mousse/lifecycle/${this.store.profileId}/${input.taskId}/${key}`
      const manifest: WorktreeReconstructionManifest = { schemaVersion: 1, profileId: this.store.profileId, ...input, ...identity, baseSha, resultSha, treeSha: lifecycleGit(input.worktreePath, ['rev-parse', 'HEAD^{tree}']), checkoutFingerprint: this.checkoutFingerprint(input.worktreePath), baseRef: `${prefix}/base`, resultRef: `${prefix}/result`, ...contents, state: 'prepared' }
      const manifestPath = this.pathFor(input.taskId, input.worktreePath)
      // Intent precedes pins. Recovery can distinguish an incomplete preparation from retirement.
      if (!existsSync(manifestPath) || JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== JSON.stringify(manifest)) atomicWriteJsonSync(manifestPath, manifest)
      for (const [ref, sha] of [[manifest.baseRef, baseSha], [manifest.resultRef, resultSha]]) {
        const old = readDirectLifecycleRef(input.worktreePath, ref) ?? '0'.repeat(sha.length)
        lifecycleGit(input.worktreePath, ['update-ref', '--no-deref', ref, sha, old])
      }
      this.verifyPins(manifest)
      return manifest
    })
  }
  retire(manifestPath: string, options: { purging?: boolean } = {}): WorktreeReconstructionManifest {
    const manifest = this.load(manifestPath)
    return this.store.withGate(manifest.taskId, () => {
      this.assertOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId)
      this.verifyPins(manifest)
      if (!existsSync(manifest.worktreePath)) {
        if (this.registered(manifest)) throw new Error('Missing worktree remains registered; recovery is required')
        manifest.state = 'retired'; if (!options.purging) atomicWriteJsonSync(manifestPath, manifest); return manifest
      }
      this.verifySource(manifest, options.purging)
      const identity = this.inspectIdentity(manifest.worktreePath, manifest.branch, manifest.repositoryId)
      if (JSON.stringify(identity.rootIdentity) !== JSON.stringify(manifest.rootIdentity) || identity.gitDirectory !== manifest.gitDirectory || identity.commonDir !== manifest.commonDir) throw new Error('Workspace directory was replaced')
      if (lifecycleGit(manifest.worktreePath, ['rev-parse', 'HEAD']) !== manifest.resultSha) throw new Error('Workspace HEAD changed')
      if (JSON.stringify(this.inspectContent(manifest.worktreePath)) !== JSON.stringify({ content: manifest.content, auxiliary: manifest.auxiliary, ...(manifest.sparse ? { sparse: manifest.sparse } : {}) })) throw new Error('Workspace content changed after retirement preview')
      this.verifyPins(manifest)
      lifecycleGit(manifest.commonDir, ['worktree', 'remove', manifest.worktreePath])
      if (existsSync(manifest.worktreePath) || this.registered(manifest)) throw new Error('Git did not retire the exact workspace')
      manifest.state = 'retired'; if (!options.purging) atomicWriteJsonSync(manifestPath, manifest)
      return manifest
    })
  }
  reconstruct(manifestPath: string): WorktreeReconstructionManifest {
    const manifest = this.load(manifestPath)
    return this.store.withGate(manifest.taskId, () => {
      this.assertOwnership(manifest.taskId, manifest.commonDir, manifest.repositoryId)
      this.verifySource(manifest); this.verifyPins(manifest)
      if (!existsSync(manifest.worktreePath)) {
        assertLifecyclePath(dirname(manifest.worktreePath), manifest.worktreePath)
        if (this.registered(manifest)) throw new Error('Absent worktree has a stale registration')
        if (lifecycleGit(manifest.commonDir, ['rev-parse', `refs/heads/${manifest.branch}`]) !== manifest.resultSha) throw new Error('Retired branch moved; explicit rebase or current-code recall is required')
        mkdirSync(dirname(manifest.worktreePath), { recursive: true })
        lifecycleGit(manifest.commonDir, ['worktree', 'add', '--no-checkout', manifest.worktreePath, manifest.branch])
        if (this.checkoutFingerprint(manifest.worktreePath) !== manifest.checkoutFingerprint) throw new Error('Checkout conversion policy changed; reconstruction requires recovery')
        if (manifest.sparse) lifecycleGit(manifest.worktreePath, ['sparse-checkout', 'set', manifest.sparse.cone ? '--cone' : '--no-cone', '--stdin'], manifest.sparse.patterns)
        lifecycleGit(manifest.worktreePath, ['checkout', 'HEAD'])
        for (const auxiliary of manifest.auxiliary) {
          const target = join(manifest.worktreePath, auxiliary.path)
          assertLifecyclePath(manifest.worktreePath, target); mkdirSync(dirname(target), { recursive: true })
          writeFileSync(target, Buffer.from(auxiliary.content, 'base64'))
        }
        if (manifest.auxiliary.some((entry) => entry.path === '.mousse/materialized-inputs.exclude')) lifecycleGit(manifest.worktreePath, ['config', '--worktree', 'core.excludesFile', join(manifest.worktreePath, '.mousse', 'materialized-inputs.exclude')])
        for (const entry of manifest.content) {
          const target = join(manifest.worktreePath, entry.path)
          if (entry.kind === 'directory') { assertLifecyclePath(manifest.worktreePath, target); mkdirSync(target, { recursive: true }) }
          if (entry.kind !== 'link') { assertLifecyclePath(manifest.worktreePath, target); chmodSync(target, entry.mode & 0o777) }
        }
      }
      const identity = this.inspectIdentity(manifest.worktreePath, manifest.branch, manifest.repositoryId)
      if (lifecycleGit(manifest.worktreePath, ['rev-parse', 'HEAD^{tree}']) !== manifest.treeSha || JSON.stringify(this.inspectContent(manifest.worktreePath).content) !== JSON.stringify(manifest.content)) throw new Error('Reconstructed workspace does not match retained content')
      this.verifyPins(manifest)
      Object.assign(manifest, identity, { state: 'materialized' }); atomicWriteJsonSync(manifestPath, manifest)
      return manifest
    })
  }
  verifyPins(manifest: WorktreeReconstructionManifest): void {
    assertLifecyclePath(dirname(manifest.commonDir), manifest.commonDir)
    if (hash(realpathSync(manifest.commonDir).toLowerCase()).slice(0, 32) !== manifest.repositoryId) throw new Error('Repository identity is unavailable or changed')
    for (const [ref, sha] of [[manifest.baseRef, manifest.baseSha], [manifest.resultRef, manifest.resultSha]]) if (readDirectLifecycleRef(manifest.commonDir, ref) !== sha) throw new Error('Reconstruction pin changed or is unavailable')
    if (lifecycleGit(manifest.commonDir, ['rev-parse', `${manifest.resultSha}^{tree}`]) !== manifest.treeSha) throw new Error('Retained result tree changed')
  }
  private registered(manifest: WorktreeReconstructionManifest): boolean { return lifecycleGit(manifest.commonDir, ['worktree', 'list', '--porcelain']).split(/\r?\n/).some((line) => line.startsWith('worktree ') && same(line.slice(9), manifest.worktreePath)) }
  private verifySource(input: RetirementInput, purging = false): { baseSha?: string; resultSha?: string } {
    const task = this.store.require(input.taskId)
    if (['purged', 'blocked'].includes(task.state) || task.state === 'purge-started' && (!purging || !task.purge?.items.some((item) => item.kind === 'worktree' && item.identity === input.worktreePath && item.status === 'pending'))) throw new Error('Workspace owner is unavailable for retirement or recall')
    // Locate a moved source by its relative position in the stable owner history.
    let sourcePath = input.sourcePath
    for (const location of task.locations) { const rel = relative(location, sourcePath); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) { sourcePath = join(task.location, rel); break } }
    const insideTask = !relative(task.location, sourcePath).startsWith('..') && !isAbsolute(relative(task.location, sourcePath))
    if (insideTask) assertLifecyclePath(task.location, sourcePath)
    else assertLifecyclePath(this.store.profileHome, sourcePath)
    const value: unknown = JSON.parse(readFileSync(sourcePath, 'utf8'))
    const owns = (row: Record<string, unknown>): boolean => row.worktreePath === input.worktreePath && row.branch === input.branch
    let owned = false
    let baseSha: string | undefined, resultSha: string | undefined
    if (insideTask && dirname(sourcePath) === task.location && basename(sourcePath) === 'workspace.json') {
      const row = value as Record<string, unknown>
      owned = row.schemaVersion === 1 && row.threadId === task.taskId && input.branch.startsWith(`mousse/thread/${task.taskId}/`) && owns(row)
      baseSha = typeof row.baseSha === 'string' ? row.baseSha : undefined
    } else if (insideTask && dirname(sourcePath) === task.location && basename(sourcePath) === 'agent-episodes.json') {
      const state = new AgentEpisodeStore(task.location).read()
      const episode = state.episodes.find((entry) => entry.policy.workspace === 'isolated' && entry.binding.worktreePath === input.worktreePath && entry.binding.branch === input.branch && input.branch === `mousse/agent/${entry.id}`)
      owned = Boolean(episode)
      baseSha = episode?.binding.baseSha
      resultSha = episode?.result?.resultSha
    } else if (insideTask && dirname(sourcePath) === task.location && ['agents.json', 'mousse-agent-sessions.json'].includes(basename(sourcePath)) && Array.isArray(value)) {
      owned = value.some((row) => row && typeof row === 'object' && owns(row) && typeof (row.agentId ?? row.id) === 'string' && input.branch === `mousse/agent/${row.agentId ?? row.id}`)
    } else if (!insideTask && dirname(sourcePath) === join(this.store.profileHome, 'workflow-agent-bindings', 'workspaces') && value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string, unknown>
      const key = typeof row.idempotencyKey === 'string' ? row.idempotencyKey : ''
      const agentId = `wf-${hash(`${this.store.profileId}:${task.taskId}:${key}`).slice(0, 40)}`
      owned = row.version === 1 && row.kind === 'git-worktree' && row.profileId === this.store.profileId && row.threadId === task.taskId && Boolean(key) && basename(sourcePath) === `${/^[a-f0-9]{64}$/i.test(key) ? key.toLowerCase() : hash(key)}.json` && row.retainedRef === `refs/mousse/workflows/${this.store.profileId}/${task.taskId}/${agentId}` && input.branch === `mousse/agent/${agentId}` && owns(row)
      baseSha = typeof row.baseSha === 'string' ? row.baseSha : undefined
      resultSha = typeof row.resultSha === 'string' ? row.resultSha : undefined
    }
    if (!owned) throw new Error('Known source no longer owns the exact task, worktree and branch')
    if ([baseSha, resultSha].some((sha) => sha !== undefined && !/^[a-f0-9]{40,64}$/.test(sha))) throw new Error('Owner source contains an invalid Git boundary')
    return { baseSha, resultSha }
  }
  private inspectIdentity(path: string, branch: string, expectedRepository?: string) {
    assertLifecyclePath(dirname(path), path)
    if (!isAbsolute(path) || !lstatSync(join(path, '.git')).isFile() || !/^mousse\/(thread|agent|workflow)\//.test(branch)) throw new Error('Only owned linked worktrees can retire')
    if (!same(realpathSync(path), lifecycleGit(path, ['rev-parse', '--show-toplevel'])) || lifecycleGit(path, ['branch', '--show-current']) !== branch) throw new Error('Worktree root or branch changed')
    const commonDir = realpathSync(resolve(path, lifecycleGit(path, ['rev-parse', '--git-common-dir'])))
    const repositoryId = hash(commonDir.toLowerCase()).slice(0, 32)
    if (expectedRepository && expectedRepository !== repositoryId) throw new Error('Worktree repository changed')
    const gitDirectory = realpathSync(resolve(path, lifecycleGit(path, ['rev-parse', '--git-dir'])))
    const stat = lstatSync(path)
    const identity = { commonDir, repositoryId, gitDirectory, rootIdentity: { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs } }
    if (!this.registered({ ...identity, worktreePath: path } as WorktreeReconstructionManifest)) throw new Error('Worktree is not registered')
    return identity
  }
  private inspectContent(path: string): Pick<WorktreeReconstructionManifest, 'content' | 'auxiliary' | 'sparse'> {
    if (lifecycleGit(path, ['status', '--porcelain=v1', '--untracked-files=all'])) throw new Error('Dirty, conflicted or untracked content requires retention')
    const entries = walkOwnedContent(path, true)
    const tracked = new Map(lifecycleGit(path, ['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map((line) => { const tab = line.indexOf('\t'), header = line.slice(0, tab).split(' '); return [line.slice(tab + 1), { mode: header[0], sha: header[2] }] }))
    const sparseEnabled = (() => { try { return lifecycleGit(path, ['config', '--bool', 'core.sparseCheckout']) === 'true' } catch { return false } })()
    const sparse = sparseEnabled ? { patterns: readFileSync(resolve(path, lifecycleGit(path, ['rev-parse', '--git-path', 'info/sparse-checkout'])), 'utf8'), cone: (() => { try { return lifecycleGit(path, ['config', '--bool', 'core.sparseCheckoutCone']) === 'true' } catch { return false } })() } : undefined
    const skipped = new Set<string>()
    for (const flag of lifecycleGit(path, ['ls-files', '-v', '-z']).split('\0').filter(Boolean)) {
      if (/^[a-z]/.test(flag) || (flag.startsWith('S ') && (!sparse || existsSync(join(path, flag.slice(2)))))) throw new Error('Hidden index flags require explicit retention')
      if (flag.startsWith('S ')) skipped.add(flag.slice(2))
    }
    for (const name of tracked.keys()) if (!entries.some((entry) => entry.path === name) && !skipped.has(name)) throw new Error('Missing tracked content is not explained by sparse checkout')
    const auxiliary: Array<{ path: string; content: string }> = []
    const files = entries.filter((entry) => entry.kind === 'file' && tracked.has(entry.path))
    if (files.length) {
      const attributes = lifecycleGit(path, ['check-attr', '-z', '--stdin', 'filter'], files.map((entry) => entry.path).join('\0') + '\0').split('\0')
      for (let index = 2; index < attributes.length; index += 3) if (!['unspecified', 'unset'].includes(attributes[index])) throw new Error('External checkout filters require retained auxiliary payloads')
      const materialized = execFileSync('git', ['cat-file', '--batch', '--filters', '-Z'], { cwd: path, input: files.map((entry) => `${tracked.get(entry.path)!.sha} ${entry.path}\0`).join(''), windowsHide: true, timeout: 30_000, maxBuffer: 600 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] })
      let offset = 0
      for (const entry of files) {
        const headerEnd = materialized.indexOf(0, offset)
        const header = materialized.subarray(offset, headerEnd).toString('utf8').split(' ')
        if (headerEnd < offset || header[0] !== tracked.get(entry.path)!.sha || header[1] !== 'blob') throw new Error('Incomplete materialized-content proof')
        offset = headerEnd + 1
        // Git reports the raw object size even with --filters. The expected actual byte count
        // safely delimits the proof: every digest, terminator, next header and final length must match.
        if (hash(materialized.subarray(offset, offset + entry.bytes)) !== entry.digest || materialized[offset + entry.bytes] !== 0) throw new Error('Tracked bytes cannot be reconstructed exactly from the retained result')
        offset += entry.bytes + 1
      }
      if (offset !== materialized.length) throw new Error('Materialized result has unexpected bytes')
    }
    for (const entry of entries) {
      if (entry.kind === 'directory') continue
      if (tracked.has(entry.path)) {
        const expected = tracked.get(entry.path)!
        if (expected.mode === '160000') throw new Error('Nested repository cannot be retired')
        if (entry.kind === 'link' && expected.mode !== '120000') throw new Error('Unexpected link in workspace')
        if (entry.kind === 'link' && lifecycleGit(path, ['hash-object', '--stdin'], readlinkSync(join(path, entry.path))) !== expected.sha) throw new Error('Tracked link differs from the durable result tree')
        continue
      }
      if (!['.mousse/materialized-inputs.exclude', '.mousse/task-progress.json'].includes(entry.path) || entry.kind !== 'file' || entry.bytes > 1024 * 1024) throw new Error(`Uncaptured ignored or untracked content requires retention: ${entry.path}`)
      auxiliary.push({ path: entry.path, content: readFileSync(join(path, entry.path)).toString('base64') })
    }
    // Modes contain platform type bits; reconstruction uses the same platform and Git checkout policy.
    return { content: entries, auxiliary, ...(sparse ? { sparse } : {}) }
  }
  private checkoutFingerprint(path: string): string {
    const read = (key: string): string => { try { return lifecycleGit(path, ['config', '--get', key]) } catch (error) { if ((error as { status?: number }).status !== 1) throw error; return '' } }
    const common = resolve(path, lifecycleGit(path, ['rev-parse', '--git-common-dir']))
    const infoAttributes = join(common, 'info', 'attributes')
    const externalAttributes = read('core.attributesFile')
    return hash(JSON.stringify({ autocrlf: read('core.autocrlf'), eol: read('core.eol'), symlinks: read('core.symlinks'), infoAttributes: existsSync(infoAttributes) ? hash(readFileSync(infoAttributes)) : '', externalAttributes, externalDigest: externalAttributes ? hash(readFileSync(externalAttributes)) : '' }))
  }
  private assertOwnership(taskId: string, commonDir: string, repositoryId: string): void {
    const ownership = this.ownership, lease = ownership?.repositoryLease
    if (!lease || lease.owner.pid !== process.pid || lease.owner.processInstanceId !== PROCESS_INSTANCE_ID || lease.identity.key !== repositoryId || !same(lease.identity.commonDir, commonDir) || !same(lease.path, join(lease.identity.metadataDir, 'repository-mutation.lease'))) throw new Error('Retirement requires the exact held repository lease')
    const current = JSON.parse(readFileSync(lease.path, 'utf8')) as { token?: string; processInstanceId?: string }
    if (current.token !== lease.owner.token || current.processInstanceId !== PROCESS_INSTANCE_ID) throw new Error('Retirement repository ownership was lost')
    const task = this.store.require(taskId)
    if (ownership.taskLease) {
      assertHeldThreadLease(task.location, ownership.taskLease)
      this.store.captureAdmission(taskId, task.location)
      return
    }
    if (!ownership.cleanupTaskId) throw new Error('Retirement requires task execution ownership or an exact cleanup reservation')
    const cleanup = this.store.require(ownership.cleanupTaskId)
    if (!['trashed', 'purge-started'].includes(cleanup.state) || cleanup.generation !== ownership.cleanupGeneration || cleanup.cleanupOwner?.token !== ownership.cleanupToken || cleanup.cleanupOwner?.pid !== process.pid || cleanup.cleanupOwner?.processInstanceId !== PROCESS_INSTANCE_ID) throw new Error('Retirement cleanup ownership was lost')
    let owner = task
    const seen = new Set<string>()
    while (owner.taskId !== cleanup.taskId) {
      if (seen.has(owner.taskId) || !owner.parentTaskId || owner.state !== 'active') throw new Error('Cleanup reservation does not own this workspace')
      seen.add(owner.taskId); owner = this.store.require(owner.parentTaskId)
    }
  }
}
