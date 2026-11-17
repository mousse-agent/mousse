import { closeSync, copyFileSync, existsSync, openSync, readSync, writeSync } from 'fs'
import { join } from 'path'

// Electron is linked as a Windows GUI application. That is correct for Mousse.exe,
// but a CLI built from the same runtime needs the console subsystem so Node sees
// real TTY streams and PowerShell/cmd wait for it like a normal command.
export const WINDOWS_CUI_SUBSYSTEM = 3

/** Offset of IMAGE_OPTIONAL_HEADER.Subsystem: PE signature (4) + file header (20) + 68, for PE32 and PE32+. */
export const SUBSYSTEM_OFFSET_FROM_PE_HEADER = 4 + 20 + 68

function subsystemOffset(fd, executable) {
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
  return peOffset + SUBSYSTEM_OFFSET_FROM_PE_HEADER
}

export function readSubsystem(executable) {
  const fd = openSync(executable, 'r')
  try {
    const value = Buffer.alloc(2)
    readSync(fd, value, 0, value.length, subsystemOffset(fd, executable))
    return value.readUInt16LE(0)
  } finally {
    closeSync(fd)
  }
}

export function setConsoleSubsystem(executable) {
  const fd = openSync(executable, 'r+')
  try {
    const value = Buffer.alloc(2)
    value.writeUInt16LE(WINDOWS_CUI_SUBSYSTEM)
    writeSync(fd, value, 0, value.length, subsystemOffset(fd, executable))
  } finally {
    closeSync(fd)
  }
}

/**
 * The installer makes mousse-cli.exe from Mousse.exe at install time (build/installer.nsh), so the
 * Setup download carries the Electron runtime once. A packaged folder that did not go through the
 * installer, such as release\win-unpacked, gets the same copy here.
 */
export function ensureConsoleCliExe(packageDir) {
  const cliExe = join(packageDir, 'mousse-cli.exe')
  if (existsSync(cliExe)) return { cliExe, created: false }
  copyFileSync(join(packageDir, 'Mousse.exe'), cliExe)
  setConsoleSubsystem(cliExe)
  return { cliExe, created: true }
}
