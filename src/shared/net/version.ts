/**
 * Mousse app versions as `docs/releases.md` defines them: `major.minor.patch`, with an optional
 * SemVer prerelease (`0.1.2-nightly.20261022.17`). A prerelease sorts before the release it leads
 * to, so a nightly never looks newer than the stable build it was cut for.
 */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** Dot-separated prerelease identifiers; empty for a release. */
  prerelease: string[]
}

const VERSION = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** Undefined when `value` is not a Mousse version (a daemon may report anything). */
export function parseVersion(value: unknown): ParsedVersion | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined
  const match = VERSION.exec(value.trim())
  if (!match) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : []
  }
}

const NUMERIC = /^\d+$/

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  // A release outranks any prerelease of the same numbers.
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index],
      right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumber = NUMERIC.test(left),
      rightNumber = NUMERIC.test(right)
    // Digit strings, not Number: an identifier may be longer than a double holds exactly.
    if (leftNumber && rightNumber) {
      const a = left.replace(/^0+(?=\d)/, ''),
        b = right.replace(/^0+(?=\d)/, '')
      if (a === b) continue
      return a.length !== b.length ? (a.length < b.length ? -1 : 1) : a < b ? -1 : 1
    }
    // Numeric identifiers sort before alphanumeric ones.
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * -1 when `a` is older than `b`, 0 when they are the same, 1 when newer. Undefined when either is
 * not a version, so the caller never claims "older" about something it cannot read.
 */
export function compareVersions(a: unknown, b: unknown): -1 | 0 | 1 | undefined {
  const left = parseVersion(a),
    right = parseVersion(b)
  if (!left || !right) return undefined
  for (const key of ['major', 'minor', 'patch'] as const)
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  return comparePrerelease(left.prerelease, right.prerelease)
}

export function isOlderVersion(a: unknown, b: unknown): boolean {
  return compareVersions(a, b) === -1
}
