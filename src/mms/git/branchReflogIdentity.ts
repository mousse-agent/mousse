import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

const digest = (parts: bigint[]): string => createHash('sha256').update(parts.join(':')).digest('hex')

/**
 * The files backend moves the branch's reflog when it renames the branch and removes it when it deletes the branch.
 * The file identity follows the original branch. Its version also changes when Git writes to the reflog.
 * With no identifiable reflog, callers cannot prove that this is still the same branch.
 */
export function branchReflogIdentity(commonDir: string, ref: string, proof?: { message: string; creation?: true }): { id: string; version: string } | undefined {
  if (!ref.startsWith('refs/heads/') || /[\\:]/.test(ref) || ref.split('/').some((part) => !part || part === '..')) return undefined
  try {
    const path = join(commonDir, 'logs', ref)
    const info = lstatSync(path, { bigint: true })
    if (!info.isFile() || !info.ino || !info.birthtimeNs || !info.size) return undefined
    const identity = [info.dev, info.ino, info.birthtimeNs]
    if (proof) {
      const fd = openSync(path, 'r')
      try {
        // Read the marker and the identity from the same file, even if its name is replaced during the read.
        const opened = fstatSync(fd, { bigint: true })
        if (opened.dev !== info.dev || opened.ino !== info.ino || opened.birthtimeNs !== info.birthtimeNs) return undefined
        const bytes = Buffer.alloc(8192)
        const offset = proof.creation || info.size <= BigInt(bytes.length) ? 0 : Number(info.size) - bytes.length
        const entries = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, offset)).toString('utf8').split('\n')
        const marked = (entry: string): boolean => {
          const tab = entry.indexOf('\t')
          return tab >= 0 && entry.slice(tab + 1) === proof.message
        }
        if (proof.creation ? !/^0{40}(?:0{24})? /.test(entries[0]) || !marked(entries[0]) : !entries.slice(offset ? 1 : 0, -1).some(marked)) return undefined
      } finally {
        closeSync(fd)
      }
    }
    return { id: digest(identity), version: digest([...identity, info.size, info.mtimeNs, info.ctimeNs]) }
  } catch {
    return undefined
  }
}
