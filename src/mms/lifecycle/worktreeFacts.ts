import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { realpath as realpathCallback } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitDirectoryEnvAsync } from '../git/gitEnv'
import { runGitProcess } from '../git/runGitProcess'
import { lifecycleReadAsync, readDirectLifecycleRefAsync } from './lifecycleGit'
import { assertLifecyclePathAsync } from './ResourceLifecycleStore'
import { comparablePath } from './canonicalPath'
import type { WorktreeReconstructionManifest } from './WorktreeRetirementService'

/** `realpathSync` without blocking, spelled as the repository ids Mousse records are spelled (`RepositoryIdentity`). */
const realpathLike = promisify(realpathCallback)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

/** A small regular file's text (never through a link), or undefined when it is missing, too big or unreadable. */
async function smallText(path: string, limit = 64 * 1024): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > limit) return undefined
    return await readFile(path, 'utf8')
  } catch { return undefined }
}

/** Whether `path` is a real folder, not a link, junction or other reparse point Node reports as one. */
async function plainFolder(path: string): Promise<boolean> {
  try { const info = await lstat(path); return info.isDirectory() && !info.isSymbolicLink() } catch { return false }
}

type ConfigValues = Map<string, string[]>

/**
 * A Git config file read only when it is plainly written: `[section]` or `[section "sub"]` headers, `key = value`
 * lines, comments. Undefined for anything this cannot read exactly as Git would (a continued line, a stray character,
 * an `include` or `includeIf` that could bring in more): the caller then asks Git. Keys are `section.key`, lower case;
 * subsections are kept out of the keys this module looks at.
 */
function plainConfig(text: string): ConfigValues | undefined {
  const values: ConfigValues = new Map()
  let section = ''
  if (/[^\x09\x0a\x0d\x20-\x7e]|\r(?!\n)/.test(text)) return undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.endsWith('\\')) return undefined
    if (line.startsWith('[')) {
      const header = /^\[([A-Za-z0-9-]+)([ \t]+"[^"\\]*")?\][ \t]*([#;].*)?$/.exec(line)
      if (!header) return undefined
      section = header[2] ? `${header[1]!.toLowerCase()} "sub"` : header[1]!.toLowerCase()
      if (header[1]!.toLowerCase() === 'include' || header[1]!.toLowerCase() === 'includeif') return undefined
      continue
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*?))?\s*$/.exec(line)
    if (!entry || !section) return undefined
    const key = `${section}.${entry[1]!.toLowerCase()}`
    const value = (entry[2] ?? 'true').replace(/\s*[#;].*$/, '')
    if (/["\\]/.test(value)) return undefined
    values.set(key, [...values.get(key) ?? [], value])
  }
  return values
}

const FALSE_WORDS = new Set(['false', 'no', 'off', '0'])
const BOOLEAN_WORDS = new Set(['true', 'yes', 'on', '1', ...FALSE_WORDS])
/**
 * Repository extensions that change nothing about where a worktree is or whether Git opens it: `worktreeConfig` (a
 * worktree's own `config.worktree`, read here too), `objectFormat`, and `relativeWorktrees` (set once any worktree is
 * added with relative paths; each worktree's own files still say which kind it is, and only absolute ones are read).
 */
const EXTENSION_GIT_MINOR = new Map([['worktreeconfig', 20], ['objectformat', 29], ['relativeworktrees', 48]])

/**
 * The repository's own `config`, when Git would open a linked worktree of it exactly as laid out: format version 0 or
 * 1, `core.bare` absent or false, no key named `worktree` anywhere, and no extension but
 * {@link EXTENSION_GIT_MINOR} with a value Git knows. The object format, or undefined to leave it to Git.
 */
function repositoryConfig(text: string): { objectFormat: 'sha1' | 'sha256'; extensionGitMinor: number } | undefined {
  const values = plainConfig(text)
  if (!values) return undefined
  let objectFormat: 'sha1' | 'sha256' = 'sha1'
  let extensionGitMinor = 0
  for (const [key, list] of values) {
    const [section, name] = [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)]
    if (name === 'worktree') return undefined
    if (key === 'core.bare' && !list.every((value) => FALSE_WORDS.has(value.toLowerCase()))) return undefined
    if (key === 'core.repositoryformatversion' && !list.every((value) => value === '0' || value === '1')) return undefined
    if (section === 'extensions') {
      const minimum = EXTENSION_GIT_MINOR.get(name)
      if (!minimum) return undefined
      extensionGitMinor = Math.max(extensionGitMinor, minimum)
      if (name === 'objectformat') {
        if (list.length !== 1 || !['sha1', 'sha256'].includes(list[0]!.toLowerCase())) return undefined
        objectFormat = list[0]!.toLowerCase() as 'sha1' | 'sha256'
      } else if (!list.every((value) => BOOLEAN_WORDS.has(value.toLowerCase()))) return undefined
    }
    if (section.startsWith('extensions ')) return undefined
  }
  return { objectFormat, extensionGitMinor }
}

/** A worktree's own `config.worktree`, when it changes nothing Git uses to open it: no `bare`, `worktree`, format version or extension. */
function worktreeConfigKeepsLayout(text: string): boolean {
  const values = plainConfig(text)
  if (!values) return false
  for (const key of values.keys()) {
    const name = key.slice(key.lastIndexOf('.') + 1)
    if (name === 'worktree' || name === 'bare' || name === 'repositoryformatversion' || key.startsWith('extensions')) return false
  }
  return true
}

/** A worktree's `HEAD` as Git accepts it: `ref: refs/...`, or a commit id of the repository's object format. */
function validHead(text: string, objectFormat: 'sha1' | 'sha256'): boolean {
  const line = text.replace(/\n$/, '')
  if (/^ref: refs\/[^\s\0]+$/.test(line)) return true
  return new RegExp(`^[0-9a-f]{${objectFormat === 'sha256' ? 64 : 40}}$`).test(line)
}

/** A linked worktree in the standard layout: the real common directory, and the worktree's own Git folder. */
export interface StandardWorktree { commonDir: string; gitDir: string }

/** Version of the Git we would ask to open a worktree with a newer repository extension. */
export async function worktreeGitVersion(cwd: string): Promise<number> {
  const git = await runGitProcess(['--version'], { cwd, env: repoProgramEnv(), timeout: 5_000 })
  const version = /^git version (\d+)\.(\d+)\./.exec(git.stdout)
  return !git.error && git.status === 0 && version ? Number(version[1]) * 1_000 + Number(version[2]) : 0
}

/**
 * The linked worktree at `path`, read from the files Git itself reads, with no Git process, when it has exactly the
 * layout `git worktree add` writes and Git would open it as laid out. Every part must match:
 * - `.git` is a regular file holding one line, `gitdir: <absolute path>`;
 * - that folder is `<common>/worktrees/<id>`, reached without a link, junction or other reparse point anywhere on its
 *   path, and the folders `<common>`, `worktrees` and `<id>` are plain folders;
 * - its `HEAD` is a regular file Git accepts, its `commondir` is exactly `../..`, and its back-pointer `gitdir` names
 *   this worktree's `.git`, absolutely;
 * - its `config.worktree`, if any, sets nothing Git uses to open it (`worktreeConfigKeepsLayout`), and the repository's
 *   `config` is readable and plain (`repositoryConfig`).
 *
 * Undefined for anything else, unreadable files included: the caller asks Git, every time. This reader may only be
 * more careful than Git, never less: whatever Git would or might refuse goes to Git. Whether Git trusts the checkout's
 * owner (`safe.directory`) is a separate question, answered by {@link trustedCheckoutsAsync} before this is relied on.
 * Git started by Mousse never inherits `GIT_DIR`, `GIT_COMMON_DIR` or `GIT_WORK_TREE` (`gitEnv`), so those cannot make
 * Git's answer differ.
 */
export async function standardLinkedWorktreeAsync(path: string, gitVersion: () => Promise<number>): Promise<StandardWorktree | undefined> {
  const pointer = await smallText(join(path, '.git'), 4096)
  const named = pointer === undefined ? undefined : /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointer)?.[1]
  if (!named || !isAbsolute(named)) return undefined
  let gitDir: string
  try { gitDir = await realpathLike(named) } catch { return undefined }
  // A link or junction anywhere on the way makes the real path differ from the written one.
  if (comparablePath(gitDir) !== comparablePath(resolve(named))) return undefined
  const common = dirname(dirname(gitDir))
  if (basename(dirname(gitDir)) !== 'worktrees') return undefined
  const folders = await Promise.all([gitDir, dirname(gitDir), common].map(plainFolder))
  if (!folders.every(Boolean)) return undefined
  const [head, commondir, back, worktreeConfig, config, mainHead] = await Promise.all([
    smallText(join(gitDir, 'HEAD'), 4096),
    smallText(join(gitDir, 'commondir'), 4096),
    smallText(join(gitDir, 'gitdir'), 4096),
    lstat(join(gitDir, 'config.worktree')).then(() => smallText(join(gitDir, 'config.worktree')).then((text) => text ?? null), (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? undefined : null),
    smallText(join(common, 'config')),
    smallText(join(common, 'HEAD'), 4096)
  ])
  const repository = config === undefined ? undefined : repositoryConfig(config)
  if (!repository || head === undefined || mainHead === undefined || !validHead(head, repository.objectFormat) || !validHead(mainHead, repository.objectFormat)) return undefined
  if (commondir?.replace(/\r?\n$/, '') !== '../..') return undefined
  const backPath = back?.replace(/\s+$/, '')
  if (!backPath || !isAbsolute(backPath) || comparablePath(resolve(backPath)) !== comparablePath(resolve(path, '.git'))) return undefined
  if (worktreeConfig === null || worktreeConfig !== undefined && !worktreeConfigKeepsLayout(worktreeConfig)) return undefined
  if (repository.extensionGitMinor && await gitVersion() < 2_000 + repository.extensionGitMinor) return undefined
  return { commonDir: common, gitDir }
}

/** The paths Git checks the owner of for a linked worktree: its folder, its `.git` file and its Git folder. */
const ownedPaths = (checkout: { path: string; gitDir: string }): string[] => [checkout.path, join(checkout.path, '.git'), checkout.gitDir]

/** Which of `paths` are owned by the user this process runs as, read in one step; unreadable ones are not. */
async function ownedByMeAsync(paths: readonly string[]): Promise<Set<string>> {
  const owned = new Set<string>()
  if (!paths.length) return owned
  if (process.platform !== 'win32') {
    const uid = process.getuid?.()
    if (uid === undefined) return owned
    await Promise.all(paths.map(async (path) => { try { if ((await lstat(path)).uid === uid) owned.add(path) } catch { /* unreadable: not proven */ } }))
    return owned
  }
  // Windows: one PowerShell for every path, comparing each owner's SID with this process's user's.
  const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = '[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; foreach ($p in $input) { try { $acl=if ([IO.Directory]::Exists($p)) { [IO.Directory]::GetAccessControl($p) } else { [IO.File]::GetAccessControl($p) }; if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $u) { "1`t$p" } } catch { } }'
  const output = await new Promise<string>((done) => {
    let text = ''
    try {
      const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
      const timer = setTimeout(() => child.kill(), 30_000)
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { text += chunk })
      child.on('error', () => { clearTimeout(timer); done('') })
      child.on('close', (code) => { clearTimeout(timer); done(code === 0 ? text : '') })
      child.stdin.on('error', () => { /* If the shell cannot read the input, its result proves no ownership. */ })
      child.stdin.end(paths.join('\n') + '\n', 'utf8')
    } catch { done('') }
  })
  for (const line of output.split(/\r?\n/)) if (line.startsWith('1\t')) owned.add(line.slice(2))
  return owned
}

/**
 * Which checkouts Git would trust, proven without opening each with Git: the worktree folder, its `.git` file and its
 * Git folder are all owned by the user Mousse runs as. Git checks every other checkout itself, including its
 * protected `safe.directory` configuration and its owner-testing override.
 */
export async function trustedCheckoutsAsync(checkouts: ReadonlyArray<{ path: string; gitDir: string }>): Promise<Set<string>> {
  const trusted = new Set<string>()
  if (!checkouts.length || process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER !== undefined) return trusted
  const owned = await ownedByMeAsync(checkouts.flatMap(ownedPaths))
  for (const checkout of checkouts) {
    if (ownedPaths(checkout).every((path) => owned.has(path))) trusted.add(checkout.path)
  }
  return trusted
}

/** What reading one ref found: its commit, absent (`sha` unset), or why it can't be read. */
export type DirectRef = { sha?: string; error?: undefined } | { error: string; sha?: undefined }

/**
 * Bytes of ref names per Git process. Windows limits a whole command line to 32,767 characters, and the central check
 * adds its own options (`withoutRepoProgramsAsync`), so a long list is read in parts well below that.
 */
const REF_ARGUMENT_BYTES = 12_000

/**
 * The commits `refs` point at in the repository at `cwd`, for comparing with values Mousse recorded, one Git process
 * per part of the list instead of two per ref (`readDirectLifecycleRefAsync`). Names are matched exactly (Git's patterns
 * match whole folders too). A symbolic ref reads as an error, never as its target. A ref Git leaves out of the listing
 * reads as absent; that includes a symbolic ref whose target is missing, which Git skips without a word, so the answer
 * is only for comparing with an expected commit, where absent and unreadable both differ.
 *
 * When Git warns or fails (a corrupt loose ref makes it warn and leave that ref out), that part is read again ref by
 * ref, so one broken ref is an error for that ref alone and not for every pin in the repository.
 */
export async function readDirectRefsAsync(cwd: string, refs: readonly string[]): Promise<Map<string, DirectRef>> {
  const result = new Map<string, DirectRef>()
  const wanted = [...new Set(refs)]
  const parts: string[][] = []
  for (let part: string[] = [], bytes = 0, index = 0; index < wanted.length; index++) {
    const ref = wanted[index]!
    if (part.length && bytes + ref.length + 1 > REF_ARGUMENT_BYTES) { parts.push(part); part = []; bytes = 0 }
    part.push(ref); bytes += ref.length + 1
    if (index === wanted.length - 1) parts.push(part)
  }
  for (const part of parts) {
    const args = ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', ...part]
    const listing = await runGitProcess(await withoutRepoProgramsAsync(cwd, args), { cwd, env: repoProgramEnv({ ...process.env, ...await gitDirectoryEnvAsync(cwd), ...READ_ONLY_GIT_ENV }), timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
    if (listing.error || listing.status !== 0 || listing.stderr.trim()) {
      for (const ref of part) {
        try { result.set(ref, { sha: await readDirectLifecycleRefAsync(cwd, ref) }) }
        catch (error) { result.set(ref, { error: (error as Error).message }) }
      }
      continue
    }
    const inPart = new Set(part)
    for (const row of listing.stdout.split(/\r?\n/)) {
      const [name, sha, symref] = row.split('\0')
      if (!name || !inPart.has(name)) continue
      if (symref) result.set(name, { error: `Symbolic resource reference is not cleanup authority: ${name}` })
      else if (!sha || !/^[a-f0-9]{40,64}$/.test(sha) || /^0+$/.test(sha)) result.set(name, { error: `Existing resource reference is malformed or unreadable: ${name}` })
      else result.set(name, { sha })
    }
    for (const ref of part) if (!result.has(ref)) result.set(ref, {})
  }
  return result
}

/**
 * The tree of each commit in `commits`, from one `cat-file --batch-check` (no lazy fetch), or an error per commit.
 * When that fails as a whole, each commit is read on its own, as before.
 */
export async function commitTreesAsync(cwd: string, commits: readonly string[]): Promise<Map<string, { tree?: string; error?: string }>> {
  const wanted = [...new Set(commits)]
  const result = new Map<string, { tree?: string; error?: string }>()
  if (!wanted.length) return result
  try {
    const lines = (await lifecycleReadAsync(cwd, ['cat-file', '--batch-check'], wanted.map((sha) => `${sha}^{tree}\n`).join(''))).split(/\r?\n/)
    if (lines.length !== wanted.length) throw new Error('Git answered a different number of objects')
    wanted.forEach((sha, index) => {
      const [tree, type] = lines[index]!.split(' ')
      result.set(sha, type === 'tree' && /^[a-f0-9]{40,64}$/.test(tree ?? '') ? { tree } : { error: `${sha}^{tree} is ${type ?? 'unreadable'}` })
    })
  } catch {
    for (const sha of wanted) {
      try { result.set(sha, { tree: await lifecycleReadAsync(cwd, ['rev-parse', `${sha}^{tree}`]) }) }
      catch (error) { result.set(sha, { error: (error as Error).message }) }
    }
  }
  return result
}

/** The refs a reconstruction manifest pins, each with the commit it must point at. */
function pinnedRefs(manifest: WorktreeReconstructionManifest): Array<{ ref: string; sha: string; kept?: true }> {
  const prefix = manifest.resultRef.slice(0, -'/result'.length)
  return [
    { ref: manifest.baseRef, sha: manifest.baseSha },
    { ref: manifest.resultRef, sha: manifest.resultSha },
    ...(manifest.snapshotRef ? [{ ref: manifest.snapshotRef, sha: manifest.snapshotSha! }] : []),
    ...(manifest.adminRef ? [{ ref: manifest.adminRef, sha: manifest.adminCommit! }] : []),
    ...(manifest.keptFiles ?? []).flatMap((layer) => layer.sha ? [{ ref: `${prefix}/kept/${layer.sha}`, sha: layer.sha, kept: true as const }] : [])
  ]
}

/**
 * Whether each manifest's pins still hold: its repository is the one it recorded, every pinned ref points at its
 * commit, and the retained commits have their recorded trees. Manifests of one repository are read together, with one
 * ref listing and one object read for all of them, so a check costs Git per repository and not per retired worktree.
 * The error for each manifest whose pins do not hold, undefined for each that does.
 */
export async function verifyPinsAsync(manifests: readonly WorktreeReconstructionManifest[]): Promise<Map<WorktreeReconstructionManifest, Error | undefined>> {
  const result = new Map<WorktreeReconstructionManifest, Error | undefined>()
  const byRepository = new Map<string, WorktreeReconstructionManifest[]>()
  for (const manifest of manifests) {
    const list = byRepository.get(manifest.commonDir)
    if (list) list.push(manifest)
    else byRepository.set(manifest.commonDir, [manifest])
  }
  for (const [commonDir, group] of byRepository) {
    let real: string
    try {
      await assertLifecyclePathAsync(dirname(commonDir), commonDir)
      real = await realpathLike(commonDir)
    } catch (error) {
      for (const manifest of group) result.set(manifest, error as Error)
      continue
    }
    const live = group.filter((manifest) => {
      if (hash(real.toLowerCase()).slice(0, 32) === manifest.repositoryId) return true
      result.set(manifest, new Error('Repository identity is unavailable or changed'))
      return false
    })
    if (!live.length) continue
    let refs: Map<string, DirectRef>
    let trees: Map<string, { tree?: string; error?: string }>
    try {
      refs = await readDirectRefsAsync(commonDir, live.flatMap((manifest) => pinnedRefs(manifest).map((pin) => pin.ref)))
      trees = await commitTreesAsync(commonDir, live.flatMap((manifest) => [manifest.adminCommit, manifest.resultSha, manifest.snapshotSha].filter((sha): sha is string => Boolean(sha))))
    } catch (error) {
      for (const manifest of live) result.set(manifest, error as Error)
      continue
    }
    const treeOf = (sha: string): string => {
      const found = trees.get(sha)
      if (!found?.tree) throw new Error(found?.error ?? `${sha}^{tree} is unreadable`)
      return found.tree
    }
    for (const manifest of live) {
      try {
        // In the order the checks have always run, so the reason given is the same one.
        for (const pin of pinnedRefs(manifest).filter((entry) => !entry.kept)) {
          const found = refs.get(pin.ref)
          if (found?.error) throw new Error(found.error)
          if (found?.sha !== pin.sha) throw new Error('Reconstruction pin changed or is unavailable')
        }
        if (manifest.adminCommit && treeOf(manifest.adminCommit) !== manifest.adminTree) throw new Error('Retained Git data of the worktree changed')
        for (const pin of pinnedRefs(manifest).filter((entry) => entry.kept)) {
          const found = refs.get(pin.ref)
          if (found?.error) throw new Error(found.error)
          if (found?.sha !== pin.sha) throw new Error('A pin of the kept files changed or is unavailable')
        }
        if (treeOf(manifest.resultSha) !== manifest.treeSha) throw new Error('Retained result tree changed')
        if (manifest.snapshotSha && treeOf(manifest.snapshotSha) !== manifest.snapshotTree) throw new Error('Retained snapshot tree changed')
        result.set(manifest, undefined)
      } catch (error) { result.set(manifest, error as Error) }
    }
  }
  return result
}
