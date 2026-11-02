import { renameSync } from 'node:fs'

/**
 * Moves a folder in one step. On Windows a rename fails with EPERM/EACCES/EBUSY while any process, such as an
 * indexer, a virus scanner or a build tool, has a handle inside the folder; they let go within moments, so the move is
 * retried briefly before the failure is reported. A failed move changes nothing.
 */
export function renameFolder(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') || attempt >= 10) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
}
