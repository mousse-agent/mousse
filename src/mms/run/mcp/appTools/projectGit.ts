import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Type, type Tool } from '@earendil-works/pi-ai'
import type { GitService } from '../../../git/GitService'
import { englishMessagesEnv } from '../../../git/gitProcess'
import type { AppToolHost } from './host'
import { disabledInSettings, plainSchema, truncateForDisplay, type AppToolTurn, type Availability, type MousseTool, type ToolOutcome } from './types'

/**
 * The host reads the project's repository (the MCP server's host), so the git app tools are
 * registered. They read through their own scoped Git calls, never the GUI's unrestricted status and diff.
 */
export type ProjectGit = Pick<GitService, 'getStatus' | 'getDiff'>

/** The pi-ai definitions of the project git tools, as the pi loop has always sent them. */
export function projectGitToolDefinitions(): Tool[] {
  return [
    {
      name: 'git_status',
      description: 'Get git status for the project repository.',
      parameters: Type.Object({})
    },
    {
      name: 'git_diff',
      description: 'Get a git diff for one file.',
      parameters: Type.Object({
        path: Type.String({ description: 'Relative file path.' }),
        staged: Type.Optional(Type.Boolean({ description: 'Whether to diff staged changes.' }))
      })
    }
  ]
}

/** Where a git tool may read: the turn's project, and the roots its reads are held to. */
export interface ProjectGitScope {
  projectPath: string
  /** The definition's canonical roots, else the project path. Nothing outside them is read or shown. */
  roots: readonly string[]
}

interface GitResult { code: number | null; stdout: string; stderr: string }

/** Git for a read: no optional locks, Git's messages in English, never a shell. */
function readGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', [...args], {
      cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...englishMessagesEnv(), GIT_OPTIONAL_LOCKS: '0' }
    }, (error, stdout, stderr) => {
      const exit = error ? (error as { code?: unknown }).code : 0
      if (error && typeof exit !== 'number') reject(error)
      else resolvePromise({ code: typeof exit === 'number' ? exit : null, stdout, stderr })
    })
  })
}

/** The real path of a file, or of its nearest existing parent with the rest appended (a deleted file). */
function canonical(path: string): string {
  const missing: string[] = []
  let current = resolve(path)
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      missing.push(basename(current))
      current = parent
    }
  }
}

const posix = (path: string): string => path.split(sep).join('/')

/** `target` relative to `base` with `/`, or null when it is outside `base` (or is `base` itself, when `strict`). */
function inside(base: string, target: string, strict = false): string | null {
  const rel = relative(base, target)
  if (rel === '') return strict ? null : ''
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
  return posix(rel)
}

/** A repository-relative path inside one of the repository-relative roots (`''` is the whole worktree). */
function underRoots(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => root === '' || path === root || path.startsWith(`${root}/`))
}

/** The worktree holding the project, and the roots inside it as repository-relative paths. */
async function worktree(scope: ProjectGitScope): Promise<{ top: string; roots: string[] } | null> {
  const top = await readGit(scope.projectPath, ['rev-parse', '--show-toplevel'])
  if (top.code !== 0 || !top.stdout.trim()) return null
  const canonicalTop = canonical(top.stdout.trim())
  const roots = scope.roots.map((root) => inside(canonicalTop, canonical(root))).filter((root): root is string => root !== null)
  return { top: canonicalTop, roots: [...new Set(roots)] }
}

const STATUS: Record<string, string> = { M: 'modified', T: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' }

/**
 * `git status` held to the roots: Git reads only the roots (literal pathspecs), and every path shown
 * (a rename's source included) is inside them, relative to the project. Repository-wide facts
 * (upstream, ahead and behind, remotes) are left out.
 */
async function scopedStatus(scope: ProjectGitScope): Promise<Record<string, unknown>> {
  const tree = await worktree(scope)
  if (!tree) return { isRepo: false, changes: [] }
  if (!tree.roots.length) return { isRepo: true, changes: [] }
  const pathspecs = tree.roots.map((root) => root || '.')
  const run = await readGit(tree.top, ['--literal-pathspecs', '-c', 'core.quotepath=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...pathspecs])
  if (run.code !== 0) throw new Error(run.stderr.trim() || 'git status failed')
  const head = await readGit(tree.top, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const branch = head.code === 0 ? head.stdout.trim() || null : null
  const shown = (path: string): string => posix(relative(scope.projectPath, join(tree.top, path)))
  const fields = run.stdout.split('\0')
  const changes: Array<Record<string, unknown>> = []
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!
    if (field.length < 4) continue
    const x = field[0]!
    const y = field[1]!
    const path = field.slice(3)
    const from = x === 'R' || x === 'C' ? fields[++index] : undefined
    if (!underRoots(path, tree.roots)) continue
    const source = from !== undefined && underRoots(from, tree.roots) ? { originalPath: shown(from) } : undefined
    if (x === '?' && y === '?') changes.push({ path: shown(path), status: 'untracked', staged: false })
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) changes.push({ path: shown(path), status: 'conflicted', staged: false })
    else {
      // A rename or copy whose source is outside the roots shows as an added file, without its source.
      if (STATUS[x]) changes.push({ path: shown(path), status: from !== undefined && !source ? 'added' : STATUS[x], staged: true, ...(source ?? {}) })
      if (STATUS[y]) changes.push({ path: shown(path), status: STATUS[y], staged: false })
    }
  }
  return { isRepo: true, branch, changes }
}

/**
 * `git diff` of one file, read as a file name and never as a Git pathspec: the name is resolved
 * against the project, its real path must be inside the roots, and Git gets its repository-relative
 * name with `--literal-pathspecs` after `--`, so `:(top)…`, `:/…` and globs are only file names.
 */
async function scopedDiff(scope: ProjectGitScope, requested: string, staged: boolean): Promise<{ text: string; isError: boolean }> {
  const file = canonical(resolve(scope.projectPath, requested))
  if (!scope.roots.some((root) => inside(canonical(root), file) !== null)) return { text: `Path is outside the project: ${requested}`, isError: true }
  const tree = await worktree(scope)
  if (!tree) return { text: '(no diff)', isError: false }
  const name = inside(tree.top, file, true)
  if (name === null) return { text: `Path is outside the project: ${requested}`, isError: true }
  const diff = ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--no-ext-diff', '--no-textconv']
  let run: GitResult
  if (staged) run = await readGit(tree.top, [...diff, '--cached', '--', name])
  else {
    const untracked = await readGit(tree.top, ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '-z', '--', name])
    // A new file: its whole content, against the null device (file paths, not pathspecs, here).
    if (untracked.stdout.split('\0').includes(name)) run = await readGit(tree.top, ['diff', '--no-ext-diff', '--no-textconv', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', name])
    else run = await readGit(tree.top, [...diff, '--', name])
  }
  // `--no-index` exits 1 when the files differ.
  if (run.code !== 0 && run.code !== 1) return { text: run.stderr.trim() || 'git diff failed', isError: true }
  return { text: run.stdout || '(no diff)', isError: false }
}

/**
 * Runs `git_status` or `git_diff` for the project, held to the scope's roots; errors are results,
 * never throws.
 */
export async function runProjectGitTool(name: string, args: Record<string, unknown>, scope: ProjectGitScope): Promise<{ text: string; isError: boolean }> {
  try {
    if (name === 'git_status') return { text: JSON.stringify(await scopedStatus(scope), null, 2), isError: false }
    if (name === 'git_diff') {
      const path = typeof args.path === 'string' ? args.path : ''
      if (!path.trim()) return { text: 'A file path is required.', isError: true }
      return await scopedDiff(scope, path, args.staged === true)
    }
    return { text: `Unknown git tool: ${name}`, isError: true }
  } catch (err) {
    return { text: err instanceof Error ? err.message : String(err), isError: true }
  }
}

/** Where the git tools may run: in a project, on a Build turn or a definition's turn (its grants decide). */
function availability(name: string, turn: AppToolTurn): Availability {
  if (!turn.settingsEnabled(name)) return disabledInSettings(name)
  if (!turn.projectPath) return 'No project root selected for project tools.'
  if (!turn.modeFacts.build && !turn.definition && !turn.trusted) return `Tool "${name}" is available in Build mode and to agents granted it.`
  return true
}

/**
 * `git_status` and `git_diff` as app tools (PR 4 §6), so a definition granted them keeps them over
 * the Mousse MCP server on a runtime with its own loop. A definition's grants decide each call (the
 * registry's definition gate); other turns may use them in Build mode, as in the pi loop. Registered
 * only where the host reads the repository (the MCP server's host): the pi loop runs its own copies.
 */
export function projectGitTools(host: AppToolHost): MousseTool[] {
  if (!host.projectGit) return []
  return projectGitToolDefinitions().map((tool): MousseTool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: plainSchema(tool),
    definition: () => tool,
    access: 'reads',
    class: 'read',
    available: (turn) => availability(tool.name, turn),
    describe: () => `Tool ${tool.name}`,
    handler: async (args, ctx): Promise<ToolOutcome> => {
      const projectPath = ctx.turn.projectPath
      if (!projectPath) return { text: 'No project root selected for project tools.', isError: true }
      const event = { kind: 'build_tool_call' as const, title: `Tool ${tool.name}`, summary: 'Called a local project tool.', details: [`Tool: ${tool.name}`] }
      ctx.timeline?.emit(event, 'start')
      // A definition's reads stay in its roots (the gate holds the project path inside them); any
      // other turn's stay in the project.
      const roots = ctx.turn.definition ? ctx.turn.definition.policy.workspace.canonicalRoots : [projectPath]
      const result = await runProjectGitTool(tool.name, args, { projectPath, roots })
      ctx.timeline?.emit({ ...event, kind: 'build_tool_result', summary: result.isError ? 'The tool returned an error.' : 'The tool returned successfully.', response: truncateForDisplay(result.text) }, 'complete')
      return result
    }
  }))
}
