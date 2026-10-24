import { win32 } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getFileIcon: vi.fn() }, shell: { openPath: vi.fn() } }))

import { detectEditors, EDITOR_CATALOG, filesLabel, scanPath, type EditorDetectionEnv } from '../src/main/editors'

const env = (patch: Partial<EditorDetectionEnv> & { files?: string[]; commands?: Record<string, string> }): EditorDetectionEnv => {
  const files = new Set(patch.files ?? [])
  const commands = patch.commands ?? {}
  return {
    platform: 'darwin',
    home: '/Users/me',
    exists: (path) => files.has(path),
    findOnPath: (name) => commands[name] ?? null,
    ...patch
  }
}

describe('detectEditors', () => {
  it('finds macOS apps in /Applications and ~/Applications in catalog order', () => {
    const found = detectEditors(env({ files: ['/Users/me/Applications/Zed.app', '/Applications/Cursor.app', '/Applications/Xcode.app'] }))
    expect(found).toEqual([
      { id: 'cursor', label: 'Cursor', appPath: '/Applications/Cursor.app' },
      { id: 'zed', label: 'Zed', appPath: '/Users/me/Applications/Zed.app' },
      { id: 'xcode', label: 'Xcode', appPath: '/Applications/Xcode.app' }
    ])
  })

  it('accepts alternate JetBrains bundle names', () => {
    const found = detectEditors(env({ files: ['/Applications/PyCharm CE.app'] }))
    expect(found).toEqual([{ id: 'pycharm', label: 'PyCharm', appPath: '/Applications/PyCharm CE.app' }])
  })

  it('finds Linux editors by CLI and never lists Xcode', () => {
    const found = detectEditors(env({ platform: 'linux', commands: { code: '/usr/bin/code', zeditor: '/usr/bin/zeditor', subl: '/usr/bin/subl' }, files: ['/Applications/Xcode.app'] }))
    expect(found.map((entry) => [entry.id, entry.launcherPath])).toEqual([
      ['vscode', '/usr/bin/code'],
      ['zed', '/usr/bin/zeditor'],
      ['sublime', '/usr/bin/subl']
    ])
  })

  it('finds Windows editors under LOCALAPPDATA before PATH', () => {
    const local = 'C:\\Users\\me\\AppData\\Local'
    const code = win32.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe')
    const found = detectEditors(env({ platform: 'win32', localAppData: local, files: [code], commands: { cursor: 'C:\\tools\\cursor.exe' } }))
    expect(found.map((entry) => entry.id)).toEqual(['vscode', 'cursor'])
    expect(found[1].launcherPath).toBe('C:\\tools\\cursor.exe')
  })

  it('returns nothing when nothing is installed', () => {
    expect(detectEditors(env({}))).toEqual([])
  })

  it('keeps the requested catalog order', () => {
    expect(EDITOR_CATALOG.map((entry) => entry.id).slice(0, 5)).toEqual(['vscode', 'cursor', 'windsurf', 'zed', 'vscode-insiders'])
    expect(EDITOR_CATALOG.map((entry) => entry.id).slice(-1)).toEqual(['xcode'])
  })
})

describe('scanPath', () => {
  it('returns the first directory holding the command', () => {
    const exists = (path: string) => path === '/b/code'
    expect(scanPath('code', '/a::/b:/c', 'linux', exists)).toBe('/b/code')
    expect(scanPath('missing', '/a:/b', 'linux', exists)).toBeNull()
  })

  it('looks for .exe launchers on Windows', () => {
    const exists = (path: string) => path.endsWith('code.exe')
    expect(scanPath('code', 'C:\\x;C:\\y', 'win32', exists)).toMatch(/y.code\.exe$|x.code\.exe$/)
  })
})

describe('filesLabel', () => {
  it('names the platform file manager', () => {
    expect([filesLabel('darwin'), filesLabel('win32'), filesLabel('linux')]).toEqual(['Finder', 'File Explorer', 'Files'])
  })
})
