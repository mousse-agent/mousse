import { describe, expect, it, vi } from 'vitest'
import { configureLinuxWindowing, linuxTransparencyOptions } from '../src/main/linuxRendering'

describe('Linux native transparency', () => {
  it('creates an alpha-capable surface for acrylic and runtime toggles', () => {
    expect(linuxTransparencyOptions('linux')).toEqual({ transparent: true, roundedCorners: true })
  })

  it.each(['win32', 'darwin'] as const)('preserves native %s window options', (platform) => {
    expect(linuxTransparencyOptions(platform)).toEqual({})
  })
})

describe('Linux client-side window controls', () => {
  it('relaunches an implicit backend with a startup argument before any windows or daemon connection', () => {
    const app = { relaunch: vi.fn(), exit: vi.fn() }
    expect(configureLinuxWindowing(app, 'linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, ['electron', '.', '--profile=work'])).toBe(true)
    expect(app.relaunch).toHaveBeenCalledWith({ args: ['.', '--profile=work', '--ozone-platform=x11'] })
    expect(app.exit).toHaveBeenCalledWith(0)
  })
  it('retains explicit backend selection and does not configure display-less or other-platform processes', () => {
    const app = { relaunch: vi.fn(), exit: vi.fn() }
    for (const argv of [['--ozone-platform=wayland'], ['--ozone-platform', 'x11']]) expect(configureLinuxWindowing(app, 'linux', { DISPLAY: ':0' }, argv)).toBe(false)
    expect(configureLinuxWindowing(app, 'linux', {}, [])).toBe(false)
    for (const platform of ['win32', 'darwin'] as const) expect(configureLinuxWindowing(app, platform, { DISPLAY: ':0' }, [])).toBe(false)
    expect(app.relaunch).not.toHaveBeenCalled(); expect(app.exit).not.toHaveBeenCalled()
  })
})
