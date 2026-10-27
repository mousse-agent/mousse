/** What makes a clone the same repository elsewhere: its root commits, and its normalized remotes. */
export interface ProjectIdentity {
  roots: readonly string[]
  remotes: readonly string[]
}

/**
 * The one project that is the same repository as `source`, or undefined. A candidate matches when
 * its root commits overlap the source's. Several matches are narrowed to those that share a
 * normalized remote; if more than one still remains, there is no answer. A folder that is not a
 * Git repository (`identity` null) never matches.
 */
export function matchProject(
  source: ProjectIdentity,
  candidates: ReadonlyArray<{ id: string; identity: ProjectIdentity | null }>
): string | undefined {
  const roots = new Set(source.roots)
  const remotes = new Set(source.remotes)
  const same = candidates.filter(
    (candidate) => candidate.identity?.roots.some((root) => roots.has(root)) === true
  )
  if (same.length <= 1) return same[0]?.id
  const shared = same.filter((candidate) => candidate.identity!.remotes.some((remote) => remotes.has(remote)))
  return shared.length === 1 ? shared[0]!.id : undefined
}
