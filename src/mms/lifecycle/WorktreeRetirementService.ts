import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { assertLifecyclePath, ResourceLifecycleStore } from './ResourceLifecycleStore'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export function lifecycleGit(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd()
}
function same(a: string, b: string): boolean { return (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)) }
export interface ContentEntry { path: string; kind: 'file' | 'directory' | 'link'; digest: string; bytes: number; mode: number }
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
  baseRef: string
  resultRef: string
  sparse?: { patterns: string; cone: boolean }
  auxiliary: Array<{ path: string; content: string }>
  content: ContentEntry[]
  state: 'prepared' | 'retired' | 'materialized'
}
export interface RetirementInput { taskId: string; worktreePath: string; branch: string; sourcePath: string; repositoryId?: string; baseSha?: string; resultSha?: string }

/** Call under task execution ownership followed by repository mutation ownership. */
export class WorktreeRetirementService {
  constructor(readonly store: ResourceLifecycleStore) {}
  pathFor(taskId: string, worktreePath: string): string { return join(this.store.root, 'workspaces', taskId, `${hash(resolve(worktreePath))}.json`) }
  inspectForDiscard(input: RetirementInput) {
    this.verifySource(input)
    const identity = this.inspectIdentity(input.worktreePath, input.branch, input.repositoryId)
    return { ...identity, resultSha: lifecycleGit(input.worktreePath, ['rev-parse', 'HEAD']), content: walkOwnedContent(input.worktreePath, true) }
  }
  load(path: string): WorktreeReconstructionManifest {
    assertLifecyclePath(this.store.root, path)
    const value = JSON.parse(readFileSync(path, 'utf8')) as WorktreeReconstructionManifest
    if (value.schemaVersion !== 1 || value.profileId !== this.store.profileId || !same(path, this.pathFor(value.taskId, value.worktreePath)) || !/^mousse\/(thread|agent|workflow)\//.test(value.branch)) throw new Error('Invalid workspace reconstruction authority')
    const prefix = `refs/mousse/lifecycle/${this.store.profileId}/${value.taskId}/${hash(value.worktreePath).slice(0, 32)}`
    if (value.baseRef !== `${prefix}/base` || value.resultRef !== `${prefix}/result` || ![value.worktreePath, value.commonDir, value.gitDirectory, value.sourcePath].every(isAbsolute) || ![value.baseSha, value.resultSha, value.treeSha].every((sha) => /^[a-f0-9]{40,64}$/.test(sha)) || !/^[a-f0-9]{32}$/.test(value.repositoryId) || !Array.isArray(value.content) || !Array.isArray(value.auxiliary) || !['prepared', 'retired', 'materialized'].includes(value.state)) throw new Error('Malformed workspace reconstruction manifest')
    for (const entry of value.content) if (isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..') || !['file', 'directory', 'link'].includes(entry.kind) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw new Error('Manifest content path is invalid')
    for (const entry of value.auxiliary) if (!['.mousse/materialized-inputs.exclude', '.mousse/task-progress.json'].includes(entry.path) || typeof entry.content !== 'string' || entry.content.length > 2 * 1024 * 1024) throw new Error('Manifest auxiliary payload is invalid')
    if (!value.rootIdentity || !Object.values(value.rootIdentity).every(Number.isFinite) || value.sparse && (typeof value.sparse.patterns !== 'string' || typeof value.sparse.cone !== 'boolean')) throw new Error('Manifest reconstruction state is invalid')
    return value
  }
  prepare(input: RetirementInput): WorktreeReconstructionManifest {
    return this.store.withGate(input.taskId, () => {
      this.store.enableCleanupWriter()
      this.verifySource(input)
      const identity = this.inspectIdentity(input.worktreePath, input.branch, input.repositoryId)
      const resultSha = lifecycleGit(input.worktreePath, ['rev-parse', 'HEAD'])
      if (input.resultSha && input.resultSha !== resultSha) throw new Error('Workspace result changed before retirement')
      const baseSha = input.baseSha ?? resultSha
      lifecycleGit(input.worktreePath, ['cat-file', '-e', `${baseSha}^{commit}`])
      const contents = this.inspectContent(input.worktreePath)
      const key = hash(input.worktreePath).slice(0, 32)
      const prefix = `refs/mousse/lifecycle/${this.store.profileId}/${input.taskId}/${key}`
      const manifest: WorktreeReconstructionManifest = { schemaVersion: 1, profileId: this.store.profileId, ...input, ...identity, baseSha, resultSha, treeSha: lifecycleGit(input.worktreePath, ['rev-parse', 'HEAD^{tree}']), baseRef: `${prefix}/base`, resultRef: `${prefix}/result`, ...contents, state: 'prepared' }
      const manifestPath = this.pathFor(input.taskId, input.worktreePath)
      // Intent precedes pins. Recovery can distinguish an incomplete preparation from retirement.
      if (!existsSync(manifestPath) || JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== JSON.stringify(manifest)) atomicWriteJsonSync(manifestPath, manifest)
      for (const [ref, sha] of [[manifest.baseRef, baseSha], [manifest.resultRef, resultSha]]) {
        let old = '0'.repeat(sha.length)
        try { old = lifecycleGit(input.worktreePath, ['rev-parse', '--verify', ref]) } catch { /* first pin */ }
        lifecycleGit(input.worktreePath, ['update-ref', ref, sha, old])
      }
      this.verifyPins(manifest)
      return manifest
    })
  }
  retire(manifestPath: string, options: { purging?: boolean } = {}): WorktreeReconstructionManifest {
    const manifest = this.load(manifestPath)
    return this.store.withGate(manifest.taskId, () => {
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
      this.verifySource(manifest); this.verifyPins(manifest)
      if (!existsSync(manifest.worktreePath)) {
        assertLifecyclePath(dirname(manifest.worktreePath), manifest.worktreePath)
        if (this.registered(manifest)) throw new Error('Absent worktree has a stale registration')
        if (lifecycleGit(manifest.commonDir, ['rev-parse', `refs/heads/${manifest.branch}`]) !== manifest.resultSha) throw new Error('Retired branch moved; explicit rebase or current-code recall is required')
        mkdirSync(dirname(manifest.worktreePath), { recursive: true })
        lifecycleGit(manifest.commonDir, ['worktree', 'add', '--no-checkout', manifest.worktreePath, manifest.branch])
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
    for (const [ref, sha] of [[manifest.baseRef, manifest.baseSha], [manifest.resultRef, manifest.resultSha]]) if (lifecycleGit(manifest.commonDir, ['rev-parse', '--verify', ref]) !== sha) throw new Error('Reconstruction pin changed or is unavailable')
    if (lifecycleGit(manifest.commonDir, ['rev-parse', `${manifest.resultSha}^{tree}`]) !== manifest.treeSha) throw new Error('Retained result tree changed')
  }
  private registered(manifest: WorktreeReconstructionManifest): boolean { return lifecycleGit(manifest.commonDir, ['worktree', 'list', '--porcelain']).split(/\r?\n/).some((line) => line.startsWith('worktree ') && same(line.slice(9), manifest.worktreePath)) }
  private verifySource(input: RetirementInput, purging = false): void {
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
    if (insideTask && dirname(sourcePath) === task.location && basename(sourcePath) === 'workspace.json') {
      const row = value as Record<string, unknown>
      owned = row.schemaVersion === 1 && row.threadId === task.taskId && input.branch.startsWith(`mousse/thread/${task.taskId}/`) && owns(row)
    } else if (insideTask && dirname(sourcePath) === task.location && ['agents.json', 'mousse-agent-sessions.json'].includes(basename(sourcePath)) && Array.isArray(value)) {
      owned = value.some((row) => row && typeof row === 'object' && owns(row) && typeof (row.agentId ?? row.id) === 'string' && input.branch === `mousse/agent/${row.agentId ?? row.id}`)
    } else if (!insideTask && sourcePath.includes('workflow') && value && typeof value === 'object' && !Array.isArray(value)) {
      const row = value as Record<string, unknown>
      owned = (row.schemaVersion === 1 || row.version === 1) && row.profileId === this.store.profileId && (row.threadId === task.taskId || row.parentThreadId === task.taskId) && input.branch.startsWith('mousse/workflow/') && owns(row)
    }
    if (!owned) throw new Error('Known source no longer owns the exact task, worktree and branch')
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
    const hashes = files.length ? lifecycleGit(path, ['hash-object', '--stdin-paths'], files.map((entry) => JSON.stringify(join(path, entry.path).replaceAll('\\', '/'))).join('\n') + '\n').split(/\r?\n/) : []
    if (hashes.length !== files.length) throw new Error('Incomplete tracked-content hash inventory')
    const fileHashes = new Map(files.map((entry, index) => [entry.path, hashes[index]]))
    for (const entry of entries) {
      if (entry.kind === 'directory') continue
      if (tracked.has(entry.path)) {
        const expected = tracked.get(entry.path)!
        if (expected.mode === '160000') throw new Error('Nested repository cannot be retired')
        if (entry.kind === 'link' && expected.mode !== '120000') throw new Error('Unexpected link in workspace')
        const actual = entry.kind === 'link' ? lifecycleGit(path, ['hash-object', '--stdin'], readlinkSync(join(path, entry.path))) : fileHashes.get(entry.path)
        if (actual !== expected.sha) throw new Error('Tracked content differs from the durable result tree')
        continue
      }
      if (!['.mousse/materialized-inputs.exclude', '.mousse/task-progress.json'].includes(entry.path) || entry.kind !== 'file' || entry.bytes > 1024 * 1024) throw new Error(`Uncaptured ignored or untracked content requires retention: ${entry.path}`)
      auxiliary.push({ path: entry.path, content: readFileSync(join(path, entry.path)).toString('base64') })
    }
    // Modes contain platform type bits; reconstruction uses the same platform and Git checkout policy.
    return { content: entries, auxiliary, ...(sparse ? { sparse } : {}) }
  }
}
