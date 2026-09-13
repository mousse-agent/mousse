import { cp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundledModulesRoot = path.join(
  projectRoot,
  'node_modules',
  'pi-cursor-sdk',
  'node_modules'
)

// pi-cursor-sdk bundles these packages, so npm overrides cannot update them.
// Replace the bundled copies with the patched root versions pinned in
// package.json overrides. The lockfile records these effective versions too.
for (const packageName of ['fast-uri', 'hono', 'qs']) {
  const target = path.join(bundledModulesRoot, packageName)
  if (path.dirname(target) !== bundledModulesRoot) {
    throw new Error(`Refusing to remove unexpected path: ${target}`)
  }
  await rm(target, { recursive: true, force: true })
  await cp(path.join(projectRoot, 'node_modules', packageName), target, {
    recursive: true
  })
}
