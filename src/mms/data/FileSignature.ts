/** The `stat` fields that tell one written file from another. */
export interface FileIdentityStats {
  dev: bigint
  ino: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
}

const MILLISECOND_NS = 1_000_000n

/**
 * A key that changes whenever a file is replaced or rewritten, for reusing what was read from it: its file
 * identity, size and modification and change times. Undefined when the file system cannot be trusted to change
 * it. With no file identity (`ino` 0: FAT, exFAT, some network drives) or with times in whole milliseconds or
 * coarser (FAT's 2 s, exFAT's 10 ms, many network file systems' 1 s), two same-size writes within one tick would
 * share a key. A time that falls on a whole millisecond on a fine-grained file system only costs a read.
 */
export function cacheSignature(stats: FileIdentityStats): string | undefined {
  if (!stats.ino || stats.mtimeNs % MILLISECOND_NS === 0n) return undefined
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
}

/**
 * Whether `current` is the file `created` was, by file identity. Undefined when the file system has no file
 * identities, so the caller must check ownership another way.
 */
export function sameFileIdentity(current: Pick<FileIdentityStats, 'dev' | 'ino'>, created: Pick<FileIdentityStats, 'dev' | 'ino'>): boolean | undefined {
  if (!created.ino) return undefined
  return current.dev === created.dev && current.ino === created.ino
}
