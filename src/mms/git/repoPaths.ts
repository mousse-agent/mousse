import { realpathSync } from 'node:fs'
import { isAbsolute, posix, relative, resolve } from 'node:path'

const WINDOWS_DRIVE = /^[A-Za-z]:/

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const outside = (rel: string): boolean => rel === '..' || rel.startsWith('../') || isAbsolute(rel) || WINDOWS_DRIVE.test(rel)

/**
 * The one path convention for Git actions that name files: repository-relative, with `/`, exactly as
 * `getStatus` reports them and as `GitService` selects them. A path is accepted only when it lies inside
 * the project folder, which can be a subfolder of the repository, so a name that is shared with a file
 * elsewhere in the repository can never reach that file. Absolute paths are converted, never trusted.
 * Throws when a path is outside the project folder, empty, or names the folder itself.
 */
export function repoRelativePaths(top: string, projectRoot: string, inputs: readonly string[]): string[] {
  const topReal = real(top)
  const prefix = relative(topReal, real(projectRoot)).replace(/\\/g, '/')
  if (prefix !== '' && outside(prefix)) throw new Error('The project folder is outside its repository')
  const caseless = process.platform === 'win32'
  const within = (rel: string): boolean => {
    if (prefix === '') return true
    const a = caseless ? rel.toLowerCase() : rel
    const p = caseless ? prefix.toLowerCase() : prefix
    return a === p || a.startsWith(`${p}/`)
  }
  return inputs.map((input) => {
    let rel = input
    if (isAbsolute(input) || WINDOWS_DRIVE.test(input)) {
      const absolute = resolve(input)
      // The folder may be reached through a link (a temp directory on macOS), so try both spellings of its top.
      rel = [relative(topReal, real(absolute)), relative(resolve(top), absolute)].find((candidate) => !outside(candidate.replace(/\\/g, '/'))) ?? absolute
    }
    rel = posix.normalize(rel.replace(/\\/g, '/'))
    if (rel === '.' || rel === '' || outside(rel) || !within(rel) || (prefix !== '' && rel === prefix)) throw new Error('Path is outside the project folder')
    return rel
  })
}
