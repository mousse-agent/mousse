import { posix, win32 } from 'node:path'

/**
 * How a path in an SFTP request names a place on this computer, and back. A path that does not name a place
 * (`undefined`) is answered "no such file".
 */
export interface SftpPaths {
  /** The folder a relative path starts from: the user's home. */
  readonly home: string
  /**
   * The local path of a client path; `null` for the virtual folder above the drives (Windows only); `undefined`
   * when the path names nothing here.
   */
  toLocal(path: string): string | null | undefined
  /** The path a client sees for a local path. */
  toRemote(local: string): string
}

/** Linux and macOS: the client's paths are the paths of the file system, and a relative path starts at home. */
export function posixPaths(home: string): SftpPaths {
  return {
    home,
    toLocal: (path) => (path === '' || path === '.' ? home : posix.resolve(home, path)),
    toRemote: (local) => local
  }
}

/**
 * Windows, the way Win32-OpenSSH names things (so a client written for it works): `/C:/Users/x` is
 * `C:\Users\x`, a drive letter is accepted in either case and with or without the leading slash, `/` is a
 * virtual folder that lists the drives, and a relative path starts at home. A backslash is a separator. An
 * absolute path that names no drive (`/Users`) is not a place.
 */
export function windowsPaths(home: string): SftpPaths {
  return {
    home,
    toLocal(path) {
      if (path === '' || path === '.') return home
      const text = path.replace(/\\/gu, '/')
      if (text === '/') return null
      const drive = /^\/?([A-Za-z]):(\/.*)?$/u.exec(text)
      if (drive) return win32.normalize(`${drive[1]!.toUpperCase()}:${drive[2] || '\\'}`)
      if (text.startsWith('/')) return undefined
      return win32.resolve(home, text)
    },
    toRemote(local) {
      const text = local.replace(/\\/gu, '/')
      // `C:/` keeps its slash; every other path loses a trailing one.
      return '/' + (/^[A-Za-z]:\/$/u.test(text) ? text : text.replace(/\/$/u, ''))
    }
  }
}
