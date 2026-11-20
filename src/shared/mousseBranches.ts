/**
 * Branch names Mousse makes and owns.
 *
 * A thread's worktree is made at once on a temporary branch `<prefix>/<random id>` (Settings → Storage → Branches; the
 * prefix is `mousse` unless the person changed it). Afterwards the title model may name it from the thread's first
 * message, and Mousse renames it once. Which branches are Mousse's is decided by its own records (the thread's journal
 * names every branch it made with `git worktree add -b` and every rename it did), not by a name's prefix: a renamed
 * `fix/login-button` is as much Mousse's as `mousse/a1b2c3d4`, and a person's own `mousse/x` would not be.
 *
 * The prefix rule below (`isMousseBranchName`) stays for records written before that: threads made earlier have
 * `mousse/<slug>` or id-named branches (`mousse/thread/<threadId>/<branchId>`, and `mousse/agent/…`, `mousse/workflow/…`
 * for agents and workflows), and they are still Mousse's.
 */

export const MOUSSE_BRANCH_PREFIX = 'mousse/'

/** The prefix of a thread's temporary branch when the person set none. */
export const DEFAULT_BRANCH_PREFIX = 'mousse'

/** The longest branch name the title model may give, prefix included. */
export const NAMED_BRANCH_MAX = 80

/** The id-named branches made before thread branches were named after their first message. */
const ID_NAMED = /^mousse\/(thread|agent|workflow)\//

/** Names that would clash with the id-named branches, as a branch or as a folder of one. */
const RESERVED = /^mousse\/(thread|agent|workflow)(\/|$)/

/** A name Git accepts as a branch (the rules of `git check-ref-format --branch`, kept strict: ASCII only). */
export function isValidBranchName(name: string | undefined | null): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255 || name === 'HEAD') return false
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false
  if (name.includes('..') || name.includes('//') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.startsWith('-') && !part.endsWith('.lock'))
}

/** Whether a branch is under `mousse/`: Mousse's by the rule older records rely on, the id-named ones included. */
export function isMousseBranchName(name: string | undefined | null): boolean {
  return typeof name === 'string' && name.startsWith(MOUSSE_BRANCH_PREFIX) && name.length > MOUSSE_BRANCH_PREFIX.length && isValidBranchName(name)
}

/** Whether a full ref name is Mousse's by name: anything under `refs/mousse/`, or a branch under `refs/heads/mousse/`. */
export function isMousseOwnedRef(ref: string | undefined | null): boolean {
  if (typeof ref !== 'string') return false
  if (ref.startsWith('refs/mousse/')) return true
  return ref.startsWith('refs/heads/') && isMousseBranchName(ref.slice('refs/heads/'.length))
}

/** Whether this is one of the id-named branches made before thread branches were named after their first message. */
export function isIdNamedMousseBranch(name: string | undefined | null): boolean {
  return typeof name === 'string' && ID_NAMED.test(name) && isValidBranchName(name)
}

/**
 * A branch prefix as typed in Settings: a trailing slash is optional, characters a branch cannot hold become hyphens, and
 * an empty prefix means none. A prefix inside the id-named branches' folders (`mousse/thread`, …) falls back to the default.
 */
export function normalizeBranchPrefix(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_BRANCH_PREFIX
  const parts = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .split('/')
    .map((part) => part.replace(/\.{2,}/g, '.').replace(/-{2,}/g, '-').replace(/^[.-]+/, '').replace(/(\.lock)+$/i, '').replace(/[.]+$/, ''))
    .filter(Boolean)
  const prefix = parts.join('/').slice(0, 40).replace(/[./-]+$/, '')
  if (!prefix) return ''
  if (!isValidBranchName(prefix) || RESERVED.test(prefix) || prefix === 'HEAD') return DEFAULT_BRANCH_PREFIX
  return prefix
}

/** `<prefix>/<name>`, or `<name>` without a prefix. */
export function withBranchPrefix(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name
}

/**
 * Whether Mousse may give a thread's branch this name: a valid branch name, not too long, and never one of the id-named
 * branches or their folders, which other records give meaning to.
 */
export function isAcceptableThreadBranchName(name: string | undefined | null): name is string {
  return isValidBranchName(name) && name.length <= NAMED_BRANCH_MAX && !RESERVED.test(name) && !name.startsWith('refs/')
}

/** The kinds the title model may start a branch with when it picks the prefix itself. */
export const SEMANTIC_BRANCH_KINDS = ['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'build', 'ci', 'style'] as const

/** A model's words as one branch segment: lowercase ASCII letters, digits and single hyphens. */
function segment(text: string, max: number): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '')
}

/** How the person chose to name thread branches (Settings → Storage → Branches). */
export type BranchNamingMode = 'static' | 'semantic' | 'custom'

/**
 * The branch the title model's answer names, or undefined when it names nothing usable. Only the answer's first line
 * counts, without quotes or backticks.
 *
 * - `static`: the answer is a short slug; the branch is `<prefix>/<slug>`.
 * - `semantic`: the answer is `<kind>/<slug>` with a kind from `SEMANTIC_BRANCH_KINDS`; anything else names nothing.
 * - `custom`: the answer is the whole branch name, as the person's instructions asked; it is only checked.
 */
export function branchNameFromModel(answer: string | null | undefined, mode: BranchNamingMode, prefix: string): string | undefined {
  const line = (answer ?? '').split(/\r?\n/).map((text) => text.trim()).find(Boolean)
  if (!line) return undefined
  const text = line.replace(/^(branch( name)?\s*:\s*)/i, '').replace(/^[`'"]+|[`'"]+$/g, '').trim()
  let name: string | undefined
  if (mode === 'custom') {
    name = text.replace(/\s+/g, '-')
  } else if (mode === 'semantic') {
    const match = /^([A-Za-z]+)\s*\/\s*(.+)$/.exec(text)
    const kind = match?.[1].toLowerCase()
    if (!match || !(SEMANTIC_BRANCH_KINDS as readonly string[]).includes(kind!)) return undefined
    const slug = segment(match[2], NAMED_BRANCH_MAX - kind!.length - 1)
    name = slug ? `${kind}/${slug}` : undefined
  } else {
    // The model was asked for a slug; a prefix it added anyway is dropped, so the person's prefix is the only one.
    const slug = segment(text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text, NAMED_BRANCH_MAX - prefix.length - 1)
    name = slug ? withBranchPrefix(prefix, slug) : undefined
  }
  return isAcceptableThreadBranchName(name) ? name : undefined
}
