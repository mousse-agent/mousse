import { describe, expect, it, vi } from 'vitest'
import { executableDialogOptions, pickExecutable } from '../src/main/ipc/pickExecutable'

describe('executable picker', () => {
  it('opens one file, lists Windows programs first, and takes only string text from the renderer', () => {
    expect(executableDialogOptions({ title: 'Choose Codex', defaultPath: 'C:\\tools\\codex.exe' }, 'win32')).toEqual({
      title: 'Choose Codex',
      buttonLabel: 'Choose',
      defaultPath: 'C:\\tools\\codex.exe',
      properties: ['openFile', 'dontAddToRecent'],
      filters: [
        { name: 'Programs', extensions: ['exe', 'cmd', 'bat'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    const plain = executableDialogOptions({ title: 3, defaultPath: 'a\0b' }, 'darwin')
    expect(plain).toEqual({ title: 'Choose the executable', buttonLabel: 'Choose', properties: ['openFile', 'dontAddToRecent'] })
    expect(executableDialogOptions(null, 'linux')).toEqual(plain)
  })

  it('returns the chosen absolute path, or null when cancelled', async () => {
    const open = vi.fn(async () => ({ canceled: false, filePaths: ['/usr/local/bin/claude'] }))
    expect(await pickExecutable(open, { title: 'Choose Claude' }, 'linux')).toBe('/usr/local/bin/claude')
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ title: 'Choose Claude', properties: ['openFile', 'dontAddToRecent'] }))
    expect(await pickExecutable(async () => ({ canceled: true, filePaths: [] }), {}, 'linux')).toBeNull()
    expect(await pickExecutable(async () => ({ canceled: false, filePaths: [] }), {}, 'linux')).toBeNull()
  })
})
