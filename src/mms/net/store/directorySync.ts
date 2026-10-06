import { closeSync, fsyncSync, openSync } from 'node:fs'

/** Flush a published directory entry where Node supports directory handles.
 * Windows can reject directory open/fsync with EPERM or EINVAL. Regular-file
 * flushes remain mandatory; this fallback does not establish power-loss durability.
 */
export function syncDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EINVAL')) throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
