import { createHash } from 'node:crypto'
import { mkdir, realpath, lstat, open, writeFile, readFile, rm } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { NetError, DEFAULT_MAX_BLOB_BYTES, type RpcArtifactRef } from '../../../shared/net'
import { git } from './git'
import { COMMIT, type PortableRepository } from './repository'

export const inputRef = (base: string): string => `refs/mousse/dispatch-input/${base}`
export const resultRef = (dispatch: string): string => `refs/mousse/dispatch/${dispatch}`

export async function privateDirectory(parent: string, name: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(name) || await realpath(parent) !== parent) throw new NetError('forbidden')
  const path = join(parent, name)
  await mkdir(path, { recursive: true, mode: 0o700 })
  if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new NetError('forbidden')
  return path
}

export async function writeArtifact(path: string, bytes: Uint8Array | AsyncIterable<Uint8Array>, ref: RpcArtifactRef, signal: AbortSignal): Promise<void> {
  const file = await open(path, 'wx', 0o600), hash = createHash('sha256')
  let size = 0
  try {
    const parts = bytes instanceof Uint8Array ? (async function* () { yield bytes })() : bytes
    for await (const chunk of parts) {
      if (signal.aborted) throw new NetError('cancelled')
      if (!(chunk instanceof Uint8Array)) throw new NetError('bad_request')
      size += chunk.length
      if (size > DEFAULT_MAX_BLOB_BYTES) throw new NetError('too_large')
      hash.update(chunk)
      await file.writeFile(chunk)
    }
    if (!size || ref.blob !== `blb_${hash.digest('hex')}`) throw new NetError('conflict')
    await file.sync()
  } finally { await file.close() }
}

/** Only a verified artifact enters here; Git can import precisely one named commit ref. */
export async function verifyAndImportBundle(root: string, quarantine: string, bundle: string, base: string, identity: PortableRepository, signal: AbortSignal): Promise<void> {
  if (!COMMIT.test(base) || await realpath(quarantine) !== quarantine || await realpath(bundle) !== bundle) throw new NetError('forbidden')
  const heads = await git(root, ['bundle', 'list-heads', bundle], signal)
  if (heads !== `${base} ${inputRef(base)}`) throw new NetError('bad_request')
  const repository = await privateDirectory(quarantine, 'objects')
  await git(repository, ['init', '--bare', '--template='], signal)
  const objects = await git(root, ['rev-parse', '--git-path', 'objects'], signal)
  const canonicalObjects = await realpath(isAbsolute(objects) ? objects : join(root, objects))
  if (/[\r\n]/.test(canonicalObjects)) throw new NetError('forbidden')
  // Existing local objects satisfy incremental prerequisites, never incoming configuration.
  await writeFile(join(repository, 'objects/info/alternates'), `${canonicalObjects}\n`, { mode: 0o600 })
  await git(repository, ['bundle', 'verify', bundle], signal)
  await git(repository, ['-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', bundle, `${inputRef(base)}:${inputRef(base)}`], signal)
  await git(repository, ['fsck', '--strict', '--no-reflogs'], signal)
  if (await git(repository, ['rev-parse', '--verify', `${base}^{commit}`], signal) !== base) throw new NetError('bad_request')
  const roots = (await git(repository, ['rev-list', '--max-parents=0', base], signal)).split('\n').sort()
  if (!roots.length || roots.some(value => !identity.roots.includes(value))) throw new NetError('bad_request')
  let held: string | undefined
  try { held = await git(root, ['rev-parse', '--verify', inputRef(base)], signal) } catch { /* Missing ref is expected. */ }
  if (held && held !== base) throw new NetError('conflict')
  await git(root, ['-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', 'fetch', '--no-tags', '--no-write-fetch-head', repository, `${inputRef(base)}:${inputRef(base)}`], signal)
}

export async function createResultBundle(root: string, quarantine: string, dispatch: string, signal: AbortSignal): Promise<Uint8Array> {
  const file = join(quarantine, 'result.bundle')
  await git(root, ['bundle', 'create', file, resultRef(dispatch)], signal)
  if (await realpath(file) !== file || !(await lstat(file)).isFile()) throw new NetError('forbidden')
  if ((await lstat(file)).size > DEFAULT_MAX_BLOB_BYTES) throw new NetError('too_large')
  return readFile(file)
}

export async function removeQuarantine(parent: string, dispatch: string): Promise<void> {
  const path = join(parent, dispatch)
  try { if (await realpath(path) !== path || (await lstat(path)).isSymbolicLink()) throw new NetError('forbidden') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  await rm(path, { recursive: true })
}
