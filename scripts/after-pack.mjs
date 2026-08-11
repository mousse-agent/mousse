import { copyFileSync, openSync, closeSync, readSync, writeSync } from 'fs'
import { basename, join } from 'path'

// Electron is linked as a Windows GUI application. That is correct for Mousse.exe,
// but a CLI built from the same runtime needs the console subsystem so Node sees
// real TTY streams and PowerShell/cmd wait for it like a normal command.
const WINDOWS_CUI_SUBSYSTEM = 3

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

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const configuredName = context.packager.appInfo.productFilename
  const packagedExe = join(context.appOutDir, `${configuredName}.exe`)
  const outputName = basename(packagedExe).toLowerCase()

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
