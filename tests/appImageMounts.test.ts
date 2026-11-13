import { describe, expect, it } from 'vitest'
import { dropForeignAppImageMounts, withoutForeignAppImageMounts } from '../src/cli/appImageMounts'

// The service's environment on 2026-11-13, started by a window (mount DYEa68) that had inherited
// T3 Code's search paths. The window had quit, so `git` failed with `spawn ENOTCONN`.
const started = () => ({
  APPDIR: '/tmp/.mount_MoussenGM5FX',
  HOME: '/home/u',
  PATH: '/tmp/.mount_MoussenGM5FX:/tmp/.mount_MoussenGM5FX/usr/sbin:/tmp/.mount_MousseDYEa68:/tmp/.mount_MousseDYEa68/usr/sbin:/home/u/.local/bin:/tmp/.mount_T3-CodLDjNnp:/usr/local/bin:/usr/bin:/bin',
  LD_LIBRARY_PATH: '/tmp/.mount_MousseDYEa68/usr/lib:/tmp/.mount_T3-CodLDjNnp/usr/lib',
  XDG_DATA_DIRS: '/tmp/.mount_MousseDYEa68/usr/share/:/usr/local/share:/usr/share',
  GSETTINGS_SCHEMA_DIR: '/tmp/.mount_MousseDYEa68/usr/share/glib-2.0/schemas'
})

describe('the search paths the background service starts programs with', () => {
  it('drop the mounts of apps that may quit before it, and keep its own', () => {
    const env: NodeJS.ProcessEnv = started()
    dropForeignAppImageMounts(env, 'linux')
    expect(env).toEqual({
      APPDIR: '/tmp/.mount_MoussenGM5FX',
      HOME: '/home/u',
      PATH: '/tmp/.mount_MoussenGM5FX:/tmp/.mount_MoussenGM5FX/usr/sbin:/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin',
      XDG_DATA_DIRS: '/usr/local/share:/usr/share'
    })
  })

  it('drop every mount when the service does not run from an AppImage', () => {
    const { APPDIR: _own, ...env } = started()
    expect(withoutForeignAppImageMounts(env).PATH).toBe('/home/u/.local/bin:/usr/local/bin:/usr/bin:/bin')
  })

  it('leave a clean environment, and other systems, alone', () => {
    expect(withoutForeignAppImageMounts({ PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: '/opt/lib' })).toEqual({})
    const env: NodeJS.ProcessEnv = started()
    dropForeignAppImageMounts(env, 'darwin')
    expect(env).toEqual(started())
  })

  it('do not mistake a directory that only shares the prefix for the own mount', () => {
    expect(withoutForeignAppImageMounts({ APPDIR: '/tmp/.mount_Mousse', PATH: '/tmp/.mount_MousseX:/tmp/.mount_Mousse/usr/bin:/usr/bin' }).PATH)
      .toBe('/tmp/.mount_Mousse/usr/bin:/usr/bin')
  })
})
