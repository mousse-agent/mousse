import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** applicationRoot comes from the trusted app/CLI entrypoint, never an RPC parameter. */
export function browserWorkerModulePath(applicationRoot: string): string {
  if (!isAbsolute(applicationRoot)) throw new Error('Browser worker application root must be absolute')
  const root = applicationRoot.endsWith('.asar') ? applicationRoot + '.unpacked' : applicationRoot
  const path = join(root, 'out', 'browser-worker', 'index.mjs')
  if (!existsSync(path)) throw Object.assign(new Error('Managed browser worker is missing from this build'), { code: 'setup_required' })
  return path
}
