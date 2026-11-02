/**
 * The branches Mousse owns: everything under `mousse/`. A thread's worktree branch is `mousse/<slug>`, named once from the
 * thread's first message when the worktree is made. Threads made before that keep their id-named branches
 * (`mousse/thread/<threadId>/<branchId>`, and `mousse/agent/…`, `mousse/workflow/…` for agents and workflows): they are
 * still Mousse's, and nothing renames them.
 */

export const MOUSSE_BRANCH_PREFIX = 'mousse/'

/** The longest slug a thread branch gets, before a `-2` style suffix. */
export const THREAD_BRANCH_SLUG_MAX = 40

/** The id-named branches made before thread branches were named from their first message. */
const ID_NAMED = /^mousse\/(thread|agent|workflow)\//

/**
 * Slugs that would clash with the id-named branches: Git cannot hold `mousse/thread` and `mousse/thread/<id>/main` at
 * once, since one ref would have to be a folder of the other.
 */
const RESERVED_SLUGS = new Set(['thread', 'agent', 'workflow'])

/** A name Git accepts as a branch (the rules of `git check-ref-format`, kept strict). */
function validBranchName(name: string): boolean {
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) return false
  if (name.includes('..') || name.includes('//') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

/** Whether Mousse owns this branch: any valid branch name under `mousse/`, the id-named ones included. */
export function isMousseBranchName(name: string | undefined | null): boolean {
  return typeof name === 'string' && name.startsWith(MOUSSE_BRANCH_PREFIX) && name.length > MOUSSE_BRANCH_PREFIX.length && validBranchName(name)
}

/** Whether a full ref name is Mousse's own: anything under `refs/mousse/`, or a branch under `refs/heads/mousse/`. */
export function isMousseOwnedRef(ref: string | undefined | null): boolean {
  if (typeof ref !== 'string') return false
  if (ref.startsWith('refs/mousse/')) return true
  return ref.startsWith('refs/heads/') && isMousseBranchName(ref.slice('refs/heads/'.length))
}

/** Whether this is one of the id-named branches made before thread branches were named from their first message. */
export function isIdNamedMousseBranch(name: string | undefined | null): boolean {
  return typeof name === 'string' && ID_NAMED.test(name) && validBranchName(name)
}

/**
 * A short branch slug from free text: lowercase ASCII letters, digits and single hyphens, at most
 * `THREAD_BRANCH_SLUG_MAX` characters, cut at a word boundary when it can be. Empty when the text has nothing usable.
 */
export function threadBranchSlug(text: string): string {
  const words = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > THREAD_BRANCH_SLUG_MAX) {
      if (!slug) slug = word.slice(0, THREAD_BRANCH_SLUG_MAX)
      break
    }
    slug = next
  }
  return slug
}

/**
 * The branch a thread's new worktree gets: `mousse/<slug>` from `text` (the thread's first message), or
 * `mousse/thread-<first 8 of the id>` when the text has no usable word. `taken` says whether a name is already used in
 * the repository (a branch of that name, or branches under it); a taken or reserved name gets `-2`, `-3`, … appended.
 */
export function threadBranchName(text: string | undefined, threadId: string, taken: (name: string) => boolean): string {
  const fallback = `thread-${threadId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'new'}`
  const base = threadBranchSlug(text ?? '') || fallback
  for (let suffix = 1; suffix < 1000; suffix++) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`
    const name = `${MOUSSE_BRANCH_PREFIX}${slug}`
    if (RESERVED_SLUGS.has(slug) || !validBranchName(name) || taken(name)) continue
    return name
  }
  throw new Error(`No free branch name for ${MOUSSE_BRANCH_PREFIX}${base}`)
}
