import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { LocalMmsClient } from '../../src/mms/protocol/client'

export function qualificationGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function createQualificationRepository(root: string): string {
  const repo = join(root, 'repository')
  mkdirSync(repo, { recursive: true })
  qualificationGit(repo, 'init', '-q')
  qualificationGit(repo, 'config', 'user.name', 'Lifecycle Qualification')
  qualificationGit(repo, 'config', 'user.email', 'lifecycle@example.test')
  qualificationGit(repo, 'config', 'core.longpaths', 'true')
  writeFileSync(join(repo, 'PRIMARY.txt'), 'primary checkout must remain unchanged\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored-result/\n')
  qualificationGit(repo, 'add', '.')
  qualificationGit(repo, 'commit', '-qm', 'qualification base')
  return repo
}

export interface MeasuredTree {
  files: number
  bytes: number
  links: string[]
  /** Hashes make sole-copy protection assertions sensitive to silent edits. */
  content: Record<string, string>
}

/** Does not follow symlinks/junctions or count their targets as owned bytes. */
export function measureTree(root: string, exclude: ReadonlySet<string> = new Set()): MeasuredTree {
  const result: MeasuredTree = { files: 0, bytes: 0, links: [], content: {} }
  if (!existsSync(root)) return result
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const key = relative(root, path).replaceAll('\\', '/')
      if (exclude.has(key)) continue
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) { result.links.push(key); continue }
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) {
        result.files++
        result.bytes += stat.size
        result.content[key] = createHash('sha256').update(readFileSync(path)).digest('hex')
      }
    }
  }
  visit(root)
  return result
}

export function primaryCheckoutSnapshot(repo: string) {
  return {
    head: qualificationGit(repo, 'rev-parse', 'HEAD'),
    branch: qualificationGit(repo, 'symbolic-ref', '-q', 'HEAD'),
    status: qualificationGit(repo, 'status', '--porcelain=v1', '--untracked-files=all', '--ignored'),
    files: measureTree(repo, new Set(['.git'])),
    // Private Mousse refs are expected to change; user branches are not.
    userRefs: qualificationGit(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags', 'refs/remotes')
      .split('\n').filter((line) => !line.startsWith('refs/heads/mousse/')).join('\n')
  }
}

export function checkoutStorageSnapshot(repo: string) {
  const worktrees = qualificationGit(repo, 'worktree', 'list', '--porcelain').split('\n\n').filter(Boolean).map((block) => {
    const path = block.split('\n').find((line) => line.startsWith('worktree '))!.slice(9)
    return { path: resolve(path), exists: existsSync(path), ...measureTree(path, new Set(['.git'])) }
  })
  const primary = realpathSync(repo)
  const owned = worktrees.filter((entry) => !entry.exists || realpathSync(entry.path) !== primary)
  return { totalWorktrees: worktrees.length, materializedCheckouts: owned.filter((entry) => entry.exists).length,
    materializedBytes: owned.reduce((sum, entry) => sum + entry.bytes, 0), worktrees }
}

export async function awaitQualification<T>(probe: () => T | Promise<T>, ready: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  do {
    const value = await probe()
    if (ready(value)) return value
    await new Promise((done) => setTimeout(done, 40))
  } while (Date.now() < deadline)
  throw new Error('Qualification condition did not arrive before its deadline')
}

export async function stopQualificationChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((done) => child.once('exit', () => done()))
  child.kill('SIGKILL')
  await exited
}

/** Real built daemon. Credentials stay in this closure and are never returned or logged. */
export async function startQualificationDaemon(home: string, repoRoot: string, options: { preload?: string; env?: NodeJS.ProcessEnv } = {}) {
  const cli = resolve('out/cli/index.js')
  if (!existsSync(cli)) throw new Error('Build the CLI before running built-daemon qualification')
  const args = [...(options.preload ? ['--import', options.preload] : []), cli, '--home', home, 'service', 'run']
  const child = spawn(process.execPath, args, { cwd: process.cwd(), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ...options.env, MOUSSE_HOME: home, MOUSSE_REPO_ROOT: repoRoot, NO_COLOR: '1' } })
  let rpc: LocalMmsClient | undefined
  try {
    const owner = await awaitQualification(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Built qualification daemon exited before admission')
      try {
        const runtime = JSON.parse(readFileSync(join(home, 'mms.runtime.json'), 'utf8'))
        const record = JSON.parse(readFileSync(join(home, 'mms.owner.json'), 'utf8'))
        return runtime.pid === child.pid && record.pid === child.pid ? record : undefined
      } catch { return undefined }
    }, Boolean, 40_000)
    rpc = new LocalMmsClient({ homeDir: home, endpoint: owner.endpoint, ownerToken: owner.token,
      clientType: 'gui', requestedCapabilities: ['profiles-v1', 'workflows.definitions.v1', 'workflowRuns.v1'] })
    await rpc.connect()
    const { defaultProfileId } = await rpc.request<{ defaultProfileId: string }>('profiles.list', {})
    await rpc.request('profiles.bind', { profile: defaultProfileId })
    return { child, rpc, profileId: defaultProfileId,
      async close() { await rpc!.close(); await stopQualificationChild(child) } }
  } catch (error) { await rpc?.close(); await stopQualificationChild(child); throw error }
}
