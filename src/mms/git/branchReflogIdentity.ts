import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'

const digest = (parts: bigint[]): string => createHash('sha256').update(parts.join(':')).digest('hex')

/**
 * The files backend moves the branch's reflog when it renames the branch and removes it when it deletes the branch.
 * The file identity follows the original branch. Its version also changes when Git writes to the reflog.
 * With no identifiable reflog, callers cannot prove that this is still the same branch.
 */
export function branchReflogIdentity(commonDir: string, ref: string): { id: string; version: string } | undefined {
  if (!ref.startsWith('refs/heads/') || /[\\:]/.test(ref) || ref.split('/').some((part) => !part || part === '..')) return undefined
  try {
    const info = lstatSync(join(commonDir, 'logs', ref), { bigint: true })
    if (!info.isFile() || !info.ino || !info.birthtimeNs || !info.size) return undefined
    const identity = [info.dev, info.ino, info.birthtimeNs]
    return { id: digest(identity), version: digest([...identity, info.size, info.mtimeNs, info.ctimeNs]) }
  } catch {
    return undefined
  }
}
