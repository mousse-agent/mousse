import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { TreeDigest } from '../../../shared/profiles/types'
import { ProfilePathError } from '../../../shared/profiles/errors'

export function digestPath(path: string): TreeDigest {
  if (!existsSync(path)) {
    return { files: 0, bytes: 0, sha256: createHash('sha256').update('missing').digest('hex') }
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    throw new ProfilePathError('Refusing to hash a symlink as migration content', { path })
  }
  if (stat.isFile()) {
    const bytes = readFileSync(path)
    return {
      files: 1,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex')
    }
  }
  if (!stat.isDirectory()) {
    throw new ProfilePathError('Unsupported migration path type', { path })
  }
  const files: string[] = []
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, entry.name)
      if (entry.isSymbolicLink()) {
        throw new ProfilePathError('Refusing to hash a symlink as migration content', { path: child })
      }
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(child)
    }
  }
  visit(path)
  files.sort((a, b) => relative(path, a).replace(/\\/g, '/').localeCompare(relative(path, b).replace(/\\/g, '/')))
  const hash = createHash('sha256')
  let bytes = 0
  for (const file of files) {
    const rel = relative(path, file).replace(/\\/g, '/')
    const content = readFileSync(file)
    bytes += content.length
    hash.update(rel)
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
    hash.update(String(statSync(file).size))
    hash.update('\0')
  }
  return { files: files.length, bytes, sha256: hash.digest('hex') }
}

export function digestsEqual(a: TreeDigest, b: TreeDigest): boolean {
  return a.files === b.files && a.bytes === b.bytes && a.sha256 === b.sha256
}
