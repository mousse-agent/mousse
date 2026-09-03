/**
 * npm's node-pty 1.1.0 tarball currently ships Unix spawn-helper with
 * mode 0644. node-pty can load pty.node, but spawning a terminal then fails
 * with `posix_spawnp failed`. Restore the executable bit after install and
 * before development/distribution builds.
 */
import { chmodSync, existsSync, readdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function ensureNodePtyHelperExecutable() {
  if (process.platform === 'win32') return []

  const nodePty = join(root, 'node_modules', 'node-pty')
  const prebuilds = join(nodePty, 'prebuilds')
  if (!existsSync(nodePty)) return []

  // Fix the source build as well as every Unix prebuild, not only the host
  // architecture: electron-builder can package a target architecture
  // different from the machine running it.
  const helpers = []
  const sourceHelper = join(nodePty, 'build', 'Release', 'spawn-helper')
  if (existsSync(sourceHelper)) {
    chmodSync(sourceHelper, 0o755)
    helpers.push(sourceHelper)
  }
  if (!existsSync(prebuilds)) return helpers

  for (const target of readdirSync(prebuilds, { withFileTypes: true })) {
    if (!target.isDirectory() || target.name.startsWith('win32-')) continue
    const helper = join(prebuilds, target.name, 'spawn-helper')
    if (!existsSync(helper)) continue
    chmodSync(helper, 0o755)
    helpers.push(helper)
  }
  return helpers
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  const helpers = ensureNodePtyHelperExecutable()
  for (const helper of helpers) console.log(`Ensured executable node-pty helper: ${helper}`)
}
