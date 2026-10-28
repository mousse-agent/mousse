/** What makes a clone the same repository elsewhere: its root commits, and its normalized remotes. */
export interface ProjectIdentity {
  roots: readonly string[]
  remotes: readonly string[]
}

/** The project that matched, and whether the match rests on the root commit alone. */
export interface ProjectMatch {
  id: string
  /**
   * Weak: the root commits overlap and one side has no remote to compare, so a fork or a copy made from the same
   * template cannot be told from a clone. Strong: they share a normalized remote.
   */
  weak: boolean
}

/**
 * The one project that is the same repository as `source`, or undefined.
 *
 * A candidate needs a root commit in common. Where both sides have remotes, they must share one: a fork and
 * its upstream, or two projects made from one template, share root commits but are not the same repository.
 * A shared remote is a strong match. With no remote on one side the root commit is all there is, and the
 * match is weak. If more than one candidate remains, there is no answer. A folder that is not a Git
 * repository (`identity` null) never matches.
 */
export function matchProjectWithEvidence(
  source: ProjectIdentity,
  candidates: ReadonlyArray<{ id: string; identity: ProjectIdentity | null }>
): ProjectMatch | undefined {
  const roots = new Set(source.roots)
  const remotes = new Set(source.remotes)
  const sharesRemote = (identity: ProjectIdentity): boolean =>
    identity.remotes.some((remote) => remotes.has(remote))
  const same = candidates.filter(
    (candidate) => candidate.identity?.roots.some((root) => roots.has(root)) === true
  )
  const possible = same.filter(
    (candidate) =>
      !(
        candidate.identity!.remotes.length &&
        source.remotes.length &&
        !sharesRemote(candidate.identity!)
      )
  )
  const shared = possible.filter((candidate) => sharesRemote(candidate.identity!))
  if (shared.length === 1) return { id: shared[0]!.id, weak: false }
  if (shared.length > 1 || possible.length !== 1) return undefined
  return { id: possible[0]!.id, weak: true }
}

/** `matchProjectWithEvidence` for a caller that wants only the id. */
export function matchProject(
  source: ProjectIdentity,
  candidates: ReadonlyArray<{ id: string; identity: ProjectIdentity | null }>
): string | undefined {
  return matchProjectWithEvidence(source, candidates)?.id
}
