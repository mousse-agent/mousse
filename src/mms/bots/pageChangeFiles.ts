import { closeSync, constants, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export function pageChangePath(root: string, activationId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(activationId)) throw new Error('Invalid page-change run folder.')
  return join(root, activationId, 'page-change.txt')
}

/** Validate both directory components; on Linux hold the parent open for an anchored leaf operation. */
function inRun<T>(root: string, activationId: string, create: boolean, use: (leaf: string) => T): T {
  const file = pageChangePath(root, activationId)
  const parent = join(root, activationId)
  if (create) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  }
  const expectedRoot = join(realpathSync(dirname(root)), basename(root))
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== expectedRoot) throw new Error('Invalid run root.')
  if (create) {
    try { mkdirSync(parent, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  for (const directory of [root, parent]) {
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== (directory === root ? expectedRoot : join(expectedRoot, activationId))) throw new Error('The page-change parent must be a real directory inside the run root.')
  }
  const fd = openSync(parent, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0))
  try { return use(process.platform === 'linux' ? `/proc/self/fd/${fd}/page-change.txt` : file) }
  finally { closeSync(fd) }
}

export function writePageChange(root: string, activationId: string, text: string): string {
  inRun(root, activationId, true, leaf => {
    const fd = openSync(leaf, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    try { writeFileSync(fd, text) } finally { closeSync(fd) }
  })
  return pageChangePath(root, activationId)
}

export function removePageChange(root: string, activationId: string): void {
  try { inRun(root, activationId, false, leaf => unlinkSync(leaf)) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('A page-change file could not be removed safely', { activationId })
  }
}
