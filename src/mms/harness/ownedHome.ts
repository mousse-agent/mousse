import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

/**
 * Whether `home` is a real directory Mousse owns: under `root` (the profile folder), with no
 * symbolic link or Windows junction on the way down to it and none at the home itself, and a real
 * location that is where its path says. A sign-in or sign-out writes and deletes credentials in this
 * folder, so a link to another account's folder would act on that account. Returns why not, in
 * words for the user, or undefined when it is fine. A folder that does not exist yet is fine (Mousse
 * creates it); the links of `root` itself and above it are the user's own and are not checked.
 */
export function ownedHomeProblem(home: string, root: string): string | undefined {
  const inside = relative(root, home)
  if (!inside || inside.startsWith('..') || isAbsolute(inside))
    return `This account's home folder (${home}) is outside Mousse's own folder, so Mousse will not sign in or out there.`
  let current = root
  for (const part of inside.split(sep)) {
    current = join(current, part)
    let stat
    try {
      stat = lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      return `Mousse cannot inspect this account's home folder (${current}), so it will not sign in or out there.`
    }
    if (stat.isSymbolicLink())
      return `${current} is a link to another folder. Mousse signs in and out only in a folder of its own: remove the link and try again.`
    if (!stat.isDirectory()) return `${current} is not a folder, so Mousse will not sign in or out there.`
  }
  try {
    const expected = join(realpathSync.native(root), inside)
    const actual = realpathSync.native(home)
    const same = process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected
    if (!same) return `This account's home folder (${home}) is really ${actual}. Mousse signs in and out only in a folder of its own: remove the link and try again.`
  } catch {
    return `Mousse cannot resolve this account's home folder (${home}), so it will not sign in or out there.`
  }
  return undefined
}
