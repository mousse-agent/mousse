import { spawnSync } from 'child_process'
import { existsSync } from 'fs'
import { createRequire } from 'module'
import { basename, dirname, join } from 'path'
import { setConsoleSubsystem } from './windows-console-exe.mjs'

const require = createRequire(import.meta.url)

function resolveRcedit() {
  try {
    const winstallerRoot = dirname(require.resolve('electron-winstaller/package.json'))
    const candidate = join(winstallerRoot, 'vendor', 'rcedit.exe')
    if (existsSync(candidate)) return candidate
  } catch {
    /* optional */
  }
  return null
}

function applyWindowsIcon(executable, iconPath, appInfo) {
  if (!existsSync(iconPath)) {
    throw new Error(`Windows icon missing: ${iconPath}`)
  }
  const rcedit = resolveRcedit()
  if (!rcedit) {
    console.warn(`[after-pack] rcedit.exe not found; leaving Electron icon on ${basename(executable)}`)
    return
  }
  // Windows file and product versions are four numbers, so a nightly shows 0.1.2.<build number>.
  // electron-builder edits the version fields after this hook, so the full version (such as
  // 0.1.2-nightly.20261022.17) is not kept here; the app reports it itself.
  const version = appInfo.version
  const args = [executable, '--set-icon', iconPath]
  if (version) {
    args.push(
      '--set-version-string',
      'ProductName',
      'Mousse',
      '--set-version-string',
      'FileDescription',
      'Mousse',
      '--set-file-version',
      appInfo.getVersionInWeirdWindowsForm(),
      '--set-product-version',
      version
    )
  }
  const result = spawnSync(rcedit, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`rcedit failed for ${executable} (exit ${result.status ?? 'unknown'})`)
  }
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const configuredName = context.packager.appInfo.productFilename
  const packagedExe = join(context.appOutDir, `${configuredName}.exe`)
  const outputName = basename(packagedExe).toLowerCase()
  const iconPath = join(context.packager.projectDir, 'resources', 'icon.ico')

  // signAndEditExecutable is false (avoids Authenticode hangs), so stamp the
  // Mousse icon onto the PE ourselves. Otherwise Windows keeps the Electron logo.
  applyWindowsIcon(packagedExe, iconPath, context.packager.appInfo)

  // The app package carries Mousse.exe only. Its installer makes mousse-cli.exe from it at
  // install time (build/installer.nsh), so the Setup download does not carry the runtime twice.
  if (outputName === 'mousse-cli.exe') {
    setConsoleSubsystem(packagedExe)
  }
}
