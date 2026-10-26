/**
 * Fuzzy matching for file paths. Pure and free of Node imports so the daemon
 * and the renderer can share it.
 */

export interface FuzzyMatch {
  score: number
  /** Indexes into the original path of the matched characters, ascending. */
  positions: number[]
}

export interface FuzzyRankedPath {
  /** Index into the candidate list. */
  index: number
  score: number
  positions: number[]
}

export interface FuzzyRankOptions {
  limit: number
  /** Absolute `Date.now()` timestamp after which ranking stops with `complete: false`. */
  deadline?: number
  /** Candidates between checks of the deadline and calls to `yield`. */
  yieldEvery?: number
  /** Awaited every `yieldEvery` candidates so other work can run in between. */
  yield?: () => Promise<void>
}

const SCORE_CHAR = 16
const SCORE_CONSECUTIVE = 12
const SCORE_SEGMENT_START = 10
const SCORE_BASENAME_CHAR = 6
const SCORE_ALL_IN_BASENAME = 20
const SCORE_BASENAME_START = 15
const SCORE_EXACT_BASENAME = 40
const MAX_GAP_PENALTY = 6
const LENGTH_PENALTY = 0.1

/**
 * Lowercases a path without changing its length, so positions found in the
 * lowercase copy index the original string. A few characters (for example
 * `İ`) lowercase to two UTF-16 units; those keep their original unit.
 */
export function lowerPath(path: string): string {
  const lower = path.toLowerCase()
  if (lower.length === path.length) return lower
  let out = ''
  for (let i = 0; i < path.length; i += 1) {
    const unit = path[i].toLowerCase()
    out += unit.length === 1 ? unit : path[i]
  }
  return out
}

function isSegmentStart(path: string, index: number): boolean {
  if (index === 0) return true
  const prev = path.charCodeAt(index - 1)
  // '/', '.', '_', '-', ' '
  if (prev === 47 || prev === 46 || prev === 95 || prev === 45 || prev === 32) return true
  const cur = path.charCodeAt(index)
  return prev >= 97 && prev <= 122 && cur >= 65 && cur <= 90
}

function scorePositions(positions: number[], count: number, path: string, baseStart: number): number {
  let score = 0
  let previous = -2
  let inBasename = 0
  let consecutive = true
  for (let k = 0; k < count; k += 1) {
    const at = positions[k]
    score += SCORE_CHAR
    if (at === previous + 1) score += SCORE_CONSECUTIVE
    else {
      if (k > 0) score -= Math.min(at - previous - 1, MAX_GAP_PENALTY)
      consecutive = false
    }
    if (isSegmentStart(path, at)) score += SCORE_SEGMENT_START
    if (at >= baseStart) {
      score += SCORE_BASENAME_CHAR
      inBasename += 1
    }
    previous = at
  }
  if (inBasename === count) score += SCORE_ALL_IN_BASENAME
  if (positions[0] === baseStart) score += SCORE_BASENAME_START
  if (consecutive && inBasename === count && positions[0] === baseStart && path.length - baseStart === count) {
    score += SCORE_EXACT_BASENAME
  }
  return score - path.length * LENGTH_PENALTY
}

/** Latest-possible positions ending at `end`: the tightest window for a subsequence that ends there. */
function fillBackward(query: string, pathLower: string, end: number, into: number[]): void {
  let j = query.length - 1
  for (let i = end; i >= 0 && j >= 0; i -= 1) {
    if (pathLower.charCodeAt(i) === query.charCodeAt(j)) {
      into[j] = i
      j -= 1
    }
  }
}

/** Index of the last matched character of the earliest subsequence match from `from`, or -1. */
function subsequenceEnd(query: string, pathLower: string, from: number): number {
  let at = from - 1
  for (let k = 0; k < query.length; k += 1) {
    at = pathLower.indexOf(query[k], at + 1)
    if (at < 0) return -1
  }
  return at
}

interface Scratch {
  whole: number[]
  basename: number[]
}

function newScratch(length: number): Scratch {
  return { whole: new Array<number>(length).fill(0), basename: new Array<number>(length).fill(0) }
}

/** Scores one candidate and leaves its positions in `out`; `null` when the query is not a subsequence. */
function matchInto(queryLower: string, pathLower: string, path: string, scratch: Scratch, out: number[]): number | null {
  const count = queryLower.length
  const end = subsequenceEnd(queryLower, pathLower, 0)
  if (end < 0) return null
  const baseStart = pathLower.lastIndexOf('/') + 1

  fillBackward(queryLower, pathLower, end, scratch.whole)
  let best = scratch.whole
  let bestScore = scorePositions(scratch.whole, count, path, baseStart)

  if (baseStart > 0) {
    const baseEnd = subsequenceEnd(queryLower, pathLower, baseStart)
    if (baseEnd >= 0) {
      fillBackward(queryLower, pathLower, baseEnd, scratch.basename)
      const baseScore = scorePositions(scratch.basename, count, path, baseStart)
      if (baseScore > bestScore) {
        best = scratch.basename
        bestScore = baseScore
      }
    }
  }
  for (let k = 0; k < count; k += 1) out[k] = best[k]
  return bestScore
}

/**
 * Case-insensitive subsequence match. `queryLower` and `pathLower` must be
 * lowercased with {@link lowerPath}; `path` is the original, used for the
 * case-sensitive camelCase boundary bonus.
 */
export function fuzzyMatchPath(queryLower: string, pathLower: string, path: string): FuzzyMatch | null {
  if (queryLower.length === 0) return { score: 0, positions: [] }
  const positions = new Array<number>(queryLower.length).fill(0)
  const score = matchInto(queryLower, pathLower, path, newScratch(queryLower.length), positions)
  return score === null ? null : { score, positions }
}

function pathDepthScore(path: string): number {
  let slashes = 0
  for (let i = 0; i < path.length; i += 1) if (path.charCodeAt(i) === 47) slashes += 1
  return -(slashes * 1000 + path.length)
}

/**
 * Ranks candidates for a query, best first, keeping only `limit` of them in a
 * bounded array so 200,000 candidates never allocate 200,000 result objects.
 * Ties keep candidate order. An empty query lists the shallowest paths first.
 * Every `yieldEvery` candidates it checks `deadline` and awaits `yield`.
 */
export async function rankFuzzyPaths(
  query: string,
  candidates: { paths: string[]; lower: string[] },
  options: FuzzyRankOptions
): Promise<{ results: FuzzyRankedPath[]; complete: boolean }> {
  const { limit, deadline, yieldEvery = 10_000 } = options
  const queryLower = lowerPath(query)
  const empty = queryLower.length === 0
  const top: FuzzyRankedPath[] = []
  const scratch = newScratch(queryLower.length)
  const positions = new Array<number>(queryLower.length).fill(0)
  const { paths, lower } = candidates

  for (let i = 0; i < paths.length; i += 1) {
    if (i > 0 && i % yieldEvery === 0) {
      if (deadline !== undefined && Date.now() > deadline) return { results: top, complete: false }
      if (options.yield) await options.yield()
    }
    const score = empty ? pathDepthScore(paths[i]) : matchInto(queryLower, lower[i], paths[i], scratch, positions)
    if (score === null) continue
    if (top.length >= limit && score <= top[top.length - 1].score) continue
    let at = top.length
    while (at > 0 && top[at - 1].score < score) at -= 1
    top.splice(at, 0, { index: i, score, positions: empty ? [] : positions.slice() })
    if (top.length > limit) top.pop()
  }
  return { results: top, complete: true }
}
