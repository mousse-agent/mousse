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

/**
 * The managed browser's worker entry beside the running build: `out/browser-worker/index.mjs` next
 * to the bundle `from` is in (`out/cli` in a build, `app.asar/out/cli` packaged, `src/mms` from
 * source). Undefined when this build has none: managed sessions then say so when one is opened.
 */
export function bundledBrowserWorkerModule(from: string): string | undefined {
  for (const root of [join(from, '..', '..'), join(from, '..', '..', '..')]) {
    try {
      return browserWorkerModulePath(root)
    } catch {
      // Not this level.
    }
  }
  return undefined
}
