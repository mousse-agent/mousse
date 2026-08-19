import { spawnSync } from 'child_process'
import { copyFileSync, existsSync, openSync, closeSync, readSync, writeSync } from 'fs'
import { createRequire } from 'module'
import { basename, dirname, join } from 'path'

// Electron is linked as a Windows GUI application. That is correct for Mousse.exe,
// but a CLI built from the same runtime needs the console subsystem so Node sees
// real TTY streams and PowerShell/cmd wait for it like a normal command.
const WINDOWS_CUI_SUBSYSTEM = 3
const require = createRequire(import.meta.url)

function setConsoleSubsystem(executable) {
  const fd = openSync(executable, 'r+')
  try {
    const dosHeader = Buffer.alloc(64)
    readSync(fd, dosHeader, 0, dosHeader.length, 0)
    if (dosHeader.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error(`${executable} is not a PE executable`)
    }

    const peOffset = dosHeader.readUInt32LE(0x3c)
    const signature = Buffer.alloc(4)
    readSync(fd, signature, 0, signature.length, peOffset)
    if (signature.toString('ascii') !== 'PE\0\0') {
      throw new Error(`${executable} has an invalid PE signature`)
    }

    // IMAGE_OPTIONAL_HEADER.Subsystem is at offset 68 for PE32 and PE32+.
    const subsystemOffset = peOffset + 24 + 68
    const value = Buffer.alloc(2)
    value.writeUInt16LE(WINDOWS_CUI_SUBSYSTEM)
    writeSync(fd, value, 0, value.length, subsystemOffset)
  } finally {
    closeSync(fd)
  }
}

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

function applyWindowsIcon(executable, iconPath) {
  if (!existsSync(iconPath)) {
    throw new Error(`Windows icon missing: ${iconPath}`)
  }
  const rcedit = resolveRcedit()
  if (!rcedit) {
    console.warn(`[after-pack] rcedit.exe not found; leaving Electron icon on ${basename(executable)}`)
    return
  }
  const version = String(process.env.npm_package_version ?? '').trim()
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
      version,
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
  applyWindowsIcon(packagedExe, iconPath)

  if (outputName === 'mousse.exe') {
    const cliExe = join(context.appOutDir, 'mousse-cli.exe')
    copyFileSync(packagedExe, cliExe)
    setConsoleSubsystem(cliExe)
    return
  }

  if (outputName === 'mousse-cli.exe') {
    setConsoleSubsystem(packagedExe)
  }
}
