import { realpath, lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { NetError } from '../../../shared/net'
import { canonicalJson } from '../../net/sync/codec'
import { git } from './git'

export interface PortableRepository {
  repoId: string
  remotes: string[]
  roots: string[]
}
export const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
export const REPO_ID = /^repo_[a-f0-9]{64}$/

/** Transport/user differences do not make clones of the same remote different repositories. */
export function normalizeRemote(value: string): string {
  if (!value || value.length > 4096 || /[\x00-\x20\x7f]/.test(value))
    throw new NetError('bad_request')
  const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(value)
  const url = new URL(scp && !value.includes('://') ? `ssh://${scp[1]}/${scp[2]}` : value)
  if (
    !['ssh:', 'https:', 'http:', 'git:', 'file:'].includes(url.protocol) ||
    url.search ||
    url.hash
  )
    throw new NetError('bad_request')
  const path = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')
  if (!path || path.split('/').some((part) => part === '..' || part === '.'))
    throw new NetError('bad_request')
  // Retain non-default custom ports. Credentials are intentionally not identity material.
  const port =
    url.port &&
    !(
      (url.protocol === 'ssh:' && url.port === '22') ||
      (url.protocol === 'git:' && url.port === '9418')
    )
      ? `:${url.port}`
      : ''
  return url.protocol === 'file:' ? `file://${path}` : `${url.hostname.toLowerCase()}${port}${path}`
}

export async function canonicalRepository(path: string): Promise<string> {
  const absolute = resolve(path),
    canonical = await realpath(absolute)
  if (canonical !== absolute || !(await lstat(canonical)).isDirectory())
    throw new NetError('forbidden')
  const root = await realpath(await git(canonical, ['rev-parse', '--show-toplevel']))
  if (root !== canonical || (await git(root, ['rev-parse', '--is-bare-repository'])) !== 'false')
    throw new NetError('bad_request')
  return root
}

export async function portableRepository(path: string): Promise<PortableRepository> {
  const root = await canonicalRepository(path)
  const names = (await git(root, ['remote'])).split('\n').filter(Boolean)
  if (names.length > 32) throw new NetError('too_large')
  const remotes: string[] = []
  for (const name of names) {
    for (const value of (await git(root, ['remote', 'get-url', '--all', name])).split('\n'))
      remotes.push(normalizeRemote(value))
  }
  const roots = [
    ...new Set(
      (await git(root, ['rev-list', '--max-parents=0', '--all'])).split('\n').filter(Boolean)
    )
  ].sort()
  if (!roots.length || roots.length > 256 || roots.some((value) => !COMMIT.test(value)))
    throw new NetError('bad_request')
  const identity = { v: 1, remotes: [...new Set(remotes)].sort(), roots }
  return {
    repoId: `repo_${createHash('sha256').update(canonicalJson(identity)).digest('hex')}`,
    remotes: identity.remotes,
    roots
  }
}
