import { lstat, mkdir, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, resolve } from 'node:path'

/**
 * A folder typed in New project: "~" at its start is this computer's home folder. It must be a full path, and not a
 * drive or the file system's root.
 */
export function expandFolderPath(typed: string, home = homedir()): string {
  const trimmed = typed.trim()
  const expanded = trimmed === '~' ? home : /^~[\\/]/.test(trimmed) ? join(home, trimmed.slice(2)) : trimmed
  if (!expanded || !isAbsolute(expanded)) throw new Error('Type the folder’s full path.')
  const path = resolve(expanded)
  if (path === parse(path).root) throw new Error('Choose a folder, not the whole drive.')
  return path
}

const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code

/**
 * Makes the folder of a new empty project. The folder it goes in must exist; the project's folder must be new, or empty
 * (then it is used as it is). Nothing that is already there is changed.
 */
export async function makeProjectFolder(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Something with that name is already there.')
    if ((await readdir(path)).length > 0) throw new Error('That folder already has files in it. Open it as a project instead.')
    return
  } catch (error) {
    if (codeOf(error) !== 'ENOENT') throw error
  }
  try {
    await mkdir(path)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') throw new Error('The folder it goes in does not exist.')
    throw error
  }
}
