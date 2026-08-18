/**
 * electron-vite throws "Electron uninstall" when path.txt / dist/ is missing.
 * npm can skip the postinstall download (cache, ELECTRON_SKIP_BINARY_DOWNLOAD,
 * interrupted install). Re-run Electron's official installer if needed.
 */
import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(root, 'node_modules', 'electron')
const pathFile = join(electronDir, 'path.txt')
const installJs = join(electronDir, 'install.js')

function installedBinary() {
  if (!existsSync(pathFile)) return null
  const name = readFileSync(pathFile, 'utf8').trim()
  if (!name) return null
  const exe = join(electronDir, 'dist', name)
  return existsSync(exe) ? exe : null
}

export function ensureElectron() {
  if (installedBinary()) return
  if (!existsSync(installJs)) {
    throw new Error('node_modules/electron is missing — run npm install')
  }
  console.log('[electron] binary missing — downloading Electron…')
  const result = spawnSync(process.execPath, [installJs], {
    cwd: electronDir,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '' }
  })
  if (result.status !== 0) {
    throw new Error(
      `Electron install failed (exit ${result.status ?? 'unknown'}). ` +
        'Delete node_modules/electron and run npm install.'
    )
  }
  if (!installedBinary()) {
    throw new Error('Electron install finished but dist/ is still missing')
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    ensureElectron()
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  }
}
