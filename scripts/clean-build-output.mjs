import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = resolve(projectRoot, 'release')

// This script is intentionally narrow: release is reproducible packaging output. It never
// touches tmp, source files, dependencies, Mousse runtime data, or paths supplied by callers.
if (releaseDir !== join(projectRoot, 'release') || dirname(releaseDir) !== projectRoot) {
  throw new Error(`Refusing unsafe build cleanup target: ${releaseDir}`)
}

await rm(releaseDir, { recursive: true, force: true })
console.log(`[clean-build-output] Removed reproducible packaging output: ${releaseDir}`)
