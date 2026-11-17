import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensureConsoleCliExe,
  readSubsystem,
  setConsoleSubsystem
} from '../scripts/windows-console-exe.mjs'

const PE_OFFSET = 0x80
const GUI = 2

/** A minimal PE: DOS header, e_lfanew, the PE signature and a GUI subsystem field. */
function fakePe(subsystem = GUI): Buffer {
  const bytes = Buffer.alloc(0x200, 0xab)
  bytes.write('MZ', 0, 'ascii')
  bytes.writeUInt32LE(PE_OFFSET, 0x3c)
  bytes.write('PE\0\0', PE_OFFSET, 'ascii')
  bytes.writeUInt16LE(subsystem, PE_OFFSET + 92)
  return bytes
}

let dir: string | null = null
function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'mousse-console-exe-'))
  return dir
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

describe('windows console executable', () => {
  it('marks an executable as a console program and changes nothing else', () => {
    const exe = join(tempDir(), 'mousse-cli.exe')
    const before = fakePe()
    writeFileSync(exe, before)

    setConsoleSubsystem(exe)

    const after = readFileSync(exe)
    expect(readSubsystem(exe)).toBe(3)
    expect(after.length).toBe(before.length)
    const changed = [...after].flatMap((byte, i) => (byte === before[i] ? [] : [i]))
    expect(changed).toEqual([PE_OFFSET + 92])
  })

  it('makes mousse-cli.exe from Mousse.exe in a folder that has none, leaving Mousse.exe a GUI program', () => {
    const packageDir = tempDir()
    writeFileSync(join(packageDir, 'Mousse.exe'), fakePe())

    expect(ensureConsoleCliExe(packageDir).created).toBe(true)
    expect(readSubsystem(join(packageDir, 'mousse-cli.exe'))).toBe(3)
    expect(readSubsystem(join(packageDir, 'Mousse.exe'))).toBe(GUI)

    // A folder that already has it, such as an installed one, keeps its copy.
    expect(ensureConsoleCliExe(packageDir).created).toBe(false)
  })

  it('refuses a file without a PE signature', () => {
    const exe = join(tempDir(), 'broken.exe')
    const bytes = fakePe()
    bytes.write('XX', PE_OFFSET, 'ascii')
    writeFileSync(exe, bytes)

    expect(() => setConsoleSubsystem(exe)).toThrow(/invalid PE signature/)
  })
})
