import { mkdirSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const base = (): string => resolve('node_modules', '.cache', 'mousse-e2e-bundles')

/**
 * A folder inside the installation for the Electron bundle of the fixture that owns `root`.
 * These bundles keep packages external, and a package only resolves from a file below the
 * folder that holds `node_modules`, so the bundle cannot live in the temp directory.
 */
export function fixtureBundleDir(root: string): string {
  const dir = join(base(), basename(root))
  mkdirSync(dir, { recursive: true })
  return dir
}

export function removeFixtureBundleDir(root: string): void {
  rmSync(join(base(), basename(root)), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
