import { lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export function contained(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export async function ensureOwnedDirectory(directory: string, root: string): Promise<void> {
  const base = resolve(root)
  const target = resolve(directory)
  if (!contained(base, target)) throw new Error(`Path escapes managed browser root: ${directory}`)
  await mkdir(base, { recursive: true })
  const baseDetails = await lstat(base)
  if (baseDetails.isSymbolicLink() || !baseDetails.isDirectory()) throw new Error(`Managed browser root is not a real directory: ${base}`)
  const rel = relative(base, target)
  let current = base
  for (const part of rel ? rel.split(/[\\/]/).filter(Boolean) : []) {
    current = join(current, part)
    try {
      const details = await lstat(current)
      if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`Managed browser path is not a real directory: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current)
    }
  }
}

export async function assertOwnedPath(target: string, root: string): Promise<void> {
  const base = resolve(root)
  const path = resolve(target)
  if (!contained(base, path)) throw new Error(`Managed browser path escapes its root: ${target}`)
  const baseDetails = await lstat(base)
  if (baseDetails.isSymbolicLink() || !baseDetails.isDirectory()) throw new Error(`Managed browser root is not a real directory: ${base}`)
  let current = base
  const rel = relative(base, path)
  for (const part of rel ? rel.split(/[\\/]/).filter(Boolean) : []) {
    current = join(current, part)
    try {
      const details = await lstat(current)
      if (details.isSymbolicLink()) throw new Error(`Managed browser path contains a symlink: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export interface SafeTreeOptions {
  /**
   * Accept symlinks inside the tree when their real path stays inside the tree
   * itself (the macOS Chrome app bundle's framework links). The tree's own
   * path and its parents must still be real directories, and removal unlinks
   * such links without following them.
   */
  allowContainedSymlinks?: boolean
}

export async function assertSafeTree(target: string, root: string, options: SafeTreeOptions = {}): Promise<void> {
  await assertOwnedPath(target, root)
  let details
  try { details = await lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (details.isSymbolicLink()) throw new Error(`Managed browser path contains a symlink: ${target}`)
  if (!details.isDirectory()) return
  const treeRoot = options.allowContainedSymlinks ? await realpath(target) : undefined
  await assertSafeChildren(target, root, treeRoot)
}

async function assertSafeChildren(directory: string, root: string, treeRoot: string | undefined): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      if (!treeRoot) throw new Error(`Managed browser path contains a symlink: ${child}`)
      let resolved: string
      try { resolved = await realpath(child) } catch { throw new Error(`Managed browser path contains a dangling symlink: ${child}`) }
      const rel = relative(treeRoot, resolved)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Managed browser path contains a symlink that leaves its tree: ${child}`)
      continue
    }
    if (entry.isDirectory()) {
      await assertOwnedPath(child, root)
      await assertSafeChildren(child, root, treeRoot)
    }
  }
}

export async function removeOwnedTree(target: string, root: string, options: SafeTreeOptions = {}): Promise<void> {
  await assertSafeTree(target, root, options)
  await rm(target, { recursive: true, force: true })
}
