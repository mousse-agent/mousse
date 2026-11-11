/**
 * A V8 heap snapshot of the service, written only when a person asks for one (`mousse-cli diagnostics memory
 * snapshot --yes`). It is not part of the numbers-only memory log: it holds everything the service has in memory, so
 * it goes to a folder of its own and is never attached to anything.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import v8 from 'node:v8'
import { toMb } from '../../shared/diagnostics/memory'

export const HEAP_SNAPSHOT_RELATIVE_DIR = 'diagnostics/heap-snapshots'
/** Older snapshots are deleted past this many. */
export const HEAP_SNAPSHOT_KEEP = 2

export const HEAP_SNAPSHOT_WARNING = [
  'A heap snapshot is a copy of everything the background service holds in memory:',
  'thread text, prompts, file paths, provider tokens and email addresses.',
  'It stays on this computer. Do not attach it to an issue or share it.',
  'Writing it pauses the service for a few seconds and needs about as much free memory again.'
].join('\n')

/** Writes the snapshot and keeps the newest two. Returns the home-relative file and its size. */
export function writeHeapSnapshotFile(
  homeDir: string,
  now = Date.now(),
  write: (file: string) => string = (file) => v8.writeHeapSnapshot(file)
): { file: string; mb: number } {
  const dir = join(homeDir, HEAP_SNAPSHOT_RELATIVE_DIR)
  // Only this user may read it, as with stored credentials: it holds tokens and thread text.
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const name = `heap-${new Date(now).toISOString().replace(/[:.]/g, '-')}.heapsnapshot`
  const written = write(join(dir, name))
  chmodSync(written, 0o600)
  const mb = toMb(statSync(written).size)
  const snapshots = readdirSync(dir).filter((entry) => /^heap-.*\.heapsnapshot$/.test(entry)).sort()
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - HEAP_SNAPSHOT_KEEP))) rmSync(join(dir, old), { force: true })
  return { file: `${HEAP_SNAPSHOT_RELATIVE_DIR}/${name}`, mb }
}
