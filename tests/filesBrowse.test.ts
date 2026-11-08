import { describe, expect, it } from 'vitest'
import {
  fileLocation, filesBrowseRoot, folderErrorText, joinFolder, parentFolder, pathInside, pathSegments, resolveTypedPath, samePath
} from '../src/renderer/utils/filesBrowse'

describe('the folder the Files panel shows for a thread', () => {
  const base = { navigated: undefined, threadFolder: null, threadFolderLoading: false, filesRoot: 'C:\\Users\\me', remote: false }

  it('is the thread’s working folder (its worktree, else its project folder) before home', () => {
    expect(filesBrowseRoot({ ...base, threadFolder: 'J:\\wt\\task-1' })).toBe('J:\\wt\\task-1')
  })

  it('is the daemon’s folder (home) only for a thread without one', () => {
    expect(filesBrowseRoot(base)).toBe('C:\\Users\\me')
  })

  it('waits for the thread’s folder instead of showing home first', () => {
    expect(filesBrowseRoot({ ...base, threadFolderLoading: true })).toBe('')
  })

  it('is where the person went for the thread, once they moved', () => {
    expect(filesBrowseRoot({ ...base, threadFolder: 'J:\\wt\\task-1', navigated: 'D:\\' })).toBe('D:\\')
  })

  it('is always the daemon’s folder for a thread of another computer', () => {
    expect(filesBrowseRoot({ ...base, remote: true, threadFolder: '/srv/x', navigated: 'D:\\' })).toBe('C:\\Users\\me')
  })
})

describe('path segments for the breadcrumb', () => {
  it('starts a Windows path at its drive', () => {
    expect(pathSegments('C:\\Users\\avrsa')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'avrsa', path: 'C:\\Users\\avrsa' }
    ])
    expect(pathSegments('d:/')).toEqual([{ label: 'D:', path: 'D:\\' }])
  })

  it('starts a network path at its share and a POSIX path at /', () => {
    expect(pathSegments('\\\\nas\\media\\films').map((segment) => segment.path)).toEqual(['\\\\nas\\media\\', '\\\\nas\\media\\films'])
    expect(pathSegments('/home/me/').map((segment) => segment.label)).toEqual(['/', 'home', 'me'])
  })

  it('resolves . and .., and has none for a relative path', () => {
    expect(pathSegments('/a/./b/../c').at(-1)?.path).toBe('/a/c')
    expect(pathSegments('src/app')).toEqual([])
  })

  it('goes up to the parent, and not above a drive or root', () => {
    expect(parentFolder('C:\\Users\\me')).toBe('C:\\Users')
    expect(parentFolder('C:\\Users')).toBe('C:\\')
    expect(parentFolder('C:\\')).toBeNull()
    expect(parentFolder('/')).toBeNull()
  })
})

describe('a typed or pasted path', () => {
  it('is absolute, a bare drive, home-relative or relative to the folder shown', () => {
    expect(resolveTypedPath('"D:\\Projects\\x"', 'C:\\', null)).toBe('D:\\Projects\\x')
    expect(resolveTypedPath('e:', 'C:\\', null)).toBe('E:\\')
    expect(resolveTypedPath('~/code', '/srv', '/home/me')).toBe('/home/me/code')
    expect(resolveTypedPath('..\\other', 'C:\\work\\app', null)).toBe('C:\\work\\other')
    expect(resolveTypedPath('   ', 'C:\\', null)).toBeNull()
    expect(resolveTypedPath('~', '/srv', null)).toBeNull()
  })
})

describe('paths between the thread’s folder and the folder shown', () => {
  it('compares Windows paths without case or separator style', () => {
    expect(samePath('C:\\Users\\Me\\', 'c:/users/me')).toBe(true)
    expect(samePath('/home/Me', '/home/me')).toBe(false)
  })

  it('names a path inside a folder relative to it, and none outside', () => {
    expect(pathInside('C:/Users/me/src/a.ts', 'C:\\Users\\me')).toBe('src/a.ts')
    expect(pathInside('C:\\Users\\me', 'C:\\Users\\me')).toBe('')
    expect(pathInside('C:\\Users\\meta\\a.ts', 'C:\\Users\\me')).toBeNull()
    expect(pathInside('a.ts', 'C:\\Users\\me')).toBeNull()
  })

  it('joins a tree entry to the folder in that folder’s spelling', () => {
    expect(joinFolder('C:\\Users\\me', 'src/a.ts')).toBe('C:\\Users\\me\\src\\a.ts')
    expect(joinFolder('/', 'etc')).toBe('/etc')
  })

  it('reads a file outside the thread’s folder from its own folder, and a relative one as it is', () => {
    expect(fileLocation('D:/notes/todo.md')).toEqual({ path: 'todo.md', root: 'D:\\notes' })
    expect(fileLocation('/etc/hosts')).toEqual({ path: 'hosts', root: '/etc' })
    expect(fileLocation('src/a.ts')).toEqual({ path: 'src/a.ts' })
  })
})

describe('why the path bar could not open a folder', () => {
  const text = (message: string) => folderErrorText(`Error invoking remote method 'fs:listDir': MmsProtocolError: ${message}`)

  it('says it in a few words, keeping the daemon’s reason for the tooltip', () => {
    expect(text('The drive or folder at Z:\ is not answering. If macOS is asking…')).toEqual({ text: 'Drive not answering', detail: 'The drive or folder at Z:\ is not answering. If macOS is asking…' })
    expect(text('Only a Mousse window on this computer browses other folders').text).toBe('Not allowed here')
    expect(text('Network and device paths cannot be browsed. Map the share to a drive letter first.').text).toBe('Map the share to a drive first')
    expect(text('Enter the full path of a folder, starting with its drive.').text).toBe('Type the full path')
    expect(text('The Mousse service is older than this app and cannot open folders outside the thread. Restart Mousse to update it.').text).toBe('Restart Mousse to browse here')
    expect(text("ENOENT: no such file or directory, scandir 'C:\nope'").text).toBe('Folder not found')
    expect(text('EPERM: operation not permitted').text).toBe('Access denied')
    expect(text('something else').text).toBe('Couldn’t open this folder')
  })
})
