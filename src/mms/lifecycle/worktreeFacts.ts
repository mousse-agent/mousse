import { createHash } from 'node:crypto'
import { lstat, readFile, stat } from 'node:fs/promises'
import { realpath as realpathCallback } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitDirectoryEnvAsync } from '../git/gitEnv'
import { runGitProcess } from '../git/runGitProcess'
import { lifecycleReadAsync, readDirectLifecycleRefAsync } from './lifecycleGit'
import { assertLifecyclePathAsync } from './ResourceLifecycleStore'
import type { WorktreeReconstructionManifest } from './WorktreeRetirementService'

/** `realpathSync` without blocking, spelled as the repository ids Mousse records are spelled (`RepositoryIdentity`). */
const realpathLike = promisify(realpathCallback)
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')

/** A small file's text, or undefined when it is missing, too big or unreadable. */
async function smallText(path: string, limit = 64 * 1024): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > limit) return undefined
    return await readFile(path, 'utf8')
  } catch { return undefined }
}

/**
 * Repository extensions that change nothing about where a worktree is: `worktreeConfig` (a worktree's own
 * `config.worktree`, read separately), `objectFormat`, and `relativeWorktrees` (set once any worktree is added with
 * relative paths; each worktree's own files still say which kind it is, and only absolute ones are read here).
 */
const LAYOUT_NEUTRAL_EXTENSIONS = new Set(['worktreeconfig', 'objectformat', 'relativeworktrees'])

/**
 * Whether a Git config file's text leaves a linked worktree where `git worktree add` puts it: no `core.worktree` (or
 * any key named `worktree`), no `include`/`includeIf` that could add one, and no repository extension other than
 * {@link LAYOUT_NEUTRAL_EXTENSIONS}. Anything else, including text this cannot read, is left to Git.
 */
function configKeepsLayout(text: string): boolean {
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) {
      const header = /^\[\s*([A-Za-z0-9.-]+)(\s+"[^"]*")?\s*\]\s*([#;].*)?$/.exec(line)
      if (!header) return false
      section = header[1]!.toLowerCase()
      if (section === 'include' || section === 'includeif') return false
      continue
    }
    const key = /^([A-Za-z][A-Za-z0-9-]*)\s*(=|$)/.exec(line)?.[1]?.toLowerCase()
    if (!key) return false
    if (key === 'worktree') return false
    if (section === 'extensions' && !LAYOUT_NEUTRAL_EXTENSIONS.has(key)) return false
  }
  return true
}

/**
 * The real Git common directory of the linked worktree at `path`, read from the files Git itself reads, with no Git
 * process: `<path>/.git` names the worktree's Git folder, whose `commondir` leads to the repository. Only the layout
 * `git worktree add` writes by default is recognised, and every part of it must match:
 * - `.git` is a regular file holding one line, `gitdir: <absolute path>`;
 * - that folder is `<common>/worktrees/<id>`, with a `HEAD` file and a `commondir` of exactly `../..`;
 * - no `config.worktree` there, or one that `configKeepsLayout`; and the repository's `config` `configKeepsLayout`.
 *
 * Undefined for anything else (relative paths written by `worktree.useRelativePaths`, a `core.worktree`, an include, an
 * unknown extension, a file this cannot read): the caller asks Git, as before, every time. Git started by Mousse never
 * inherits `GIT_DIR`, `GIT_COMMON_DIR` or `GIT_WORK_TREE` (`gitEnv`), so those cannot make Git's answer differ.
 *
 * One deliberate difference: Git refuses a repository it considers to have dubious ownership (`safe.directory`), and
 * this does not check owners. A worktree there reads as verified here where Git would leave it unverified; every change
 * Mousse makes in that repository runs Git, which refuses it, so no delete there rests on the difference.
 */
export async function standardLinkedWorktreeAsync(path: string): Promise<{ commonDir: string } | undefined> {
  const pointer = await smallText(join(path, '.git'), 4096)
  const named = pointer === undefined ? undefined : /^gitdir: ([^\r\n]+)\r?\n?$/.exec(pointer)?.[1]
  if (!named || !isAbsolute(named)) return undefined
  let gitDir: string
  try { gitDir = await realpathLike(named) } catch { return undefined }
  if (basename(dirname(gitDir)) !== 'worktrees') return undefined
  const [head, commondir, back, worktreeConfig] = await Promise.all([
    stat(join(gitDir, 'HEAD')).catch(() => undefined),
    smallText(join(gitDir, 'commondir'), 4096),
    smallText(join(gitDir, 'gitdir'), 4096),
    lstat(join(gitDir, 'config.worktree')).then(() => smallText(join(gitDir, 'config.worktree')).then((text) => text ?? null), () => undefined)
  ])
  if (!head?.isFile() || commondir?.replace(/\r?\n$/, '') !== '../..') return undefined
  // Git lists the worktree by this back-pointer (`worktreeRegistry`); one written relative goes to Git as a whole.
  if (!back || !isAbsolute(back.trim())) return undefined
  if (worktreeConfig === null || worktreeConfig !== undefined && !configKeepsLayout(worktreeConfig)) return undefined
  const common = dirname(dirname(gitDir))
  const config = await smallText(join(common, 'config'))
  if (config === undefined || !configKeepsLayout(config)) return undefined
  try { return { commonDir: await realpathLike(common) } } catch { return undefined }
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
