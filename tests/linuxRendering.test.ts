import { describe, expect, it, vi } from 'vitest'
import { configureLinuxGraphics, configureLinuxVsync, configureLinuxWindowing, linuxTransparencyOptions } from '../src/main/linuxRendering'

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

describe('Xwayland graphics compatibility', () => {
  it('uses software painting only when explicitly requested', () => {
    const app = { disableHardwareAcceleration: vi.fn() }
    expect(configureLinuxGraphics(app, 'linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', MOUSSE_SOFTWARE_RENDERING: '1' }, ['--ozone-platform=x11'])).toBe(true)
    expect(app.disableHardwareAcceleration).toHaveBeenCalledOnce()
  })
  it('preserves native X11, other platforms, and explicitly selected graphics backends', () => {
    const app = { disableHardwareAcceleration: vi.fn() }
    const env = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', MOUSSE_SOFTWARE_RENDERING: '1' }
    for (const argv of [['--use-angle=vulkan'], ['--use-gl', 'angle'], ['--ozone-platform=wayland'], ['--ozone-platform', 'wayland']]) {
      expect(configureLinuxGraphics(app, 'linux', env, argv)).toBe(false)
    }
    expect(configureLinuxGraphics(app, 'linux', { DISPLAY: ':0' }, [])).toBe(false)
    expect(configureLinuxGraphics(app, 'linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }, ['--ozone-platform=x11'])).toBe(false)
    for (const platform of ['win32', 'darwin'] as const) expect(configureLinuxGraphics(app, platform, env, [])).toBe(false)
    expect(app.disableHardwareAcceleration).not.toHaveBeenCalled()
  })
})

describe('Xwayland timing workaround', () => {
  const env = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }
  it('preserves existing ANGLE features and adds the timing workaround once', () => {
    const values = new Map([['enable-angle-features', 'existingFeature']])
    const appendSwitch = vi.fn((key, value) => values.set(key, value))
    const app = { commandLine: { getSwitchValue: (key: string) => values.get(key) ?? '', appendSwitch } }
    expect(configureLinuxVsync(app, 'linux', env, ['--ozone-platform=x11'])).toBe(true)
    expect(appendSwitch).toHaveBeenCalledWith('enable-angle-features', 'existingFeature,disableSyncControlSupport')
    configureLinuxVsync(app, 'linux', env, [])
    expect(appendSwitch).toHaveBeenCalledOnce()
  })
  it('preserves other platforms, native Wayland, and an explicit feature opt-out', () => {
    const appendSwitch = vi.fn()
    const app = { commandLine: { getSwitchValue: () => '', appendSwitch } }
    for (const platform of ['darwin', 'win32'] as const) expect(configureLinuxVsync(app, platform, env, [])).toBe(false)
    expect(configureLinuxVsync(app, 'linux', { DISPLAY: ':0' }, [])).toBe(false)
    expect(configureLinuxVsync(app, 'linux', env, ['--ozone-platform=wayland'])).toBe(false)
    expect(configureLinuxVsync(app, 'linux', env, ['--ozone-platform', 'wayland'])).toBe(false)
    app.commandLine.getSwitchValue = () => 'disableSyncControlSupport'
    expect(configureLinuxVsync(app, 'linux', env, [])).toBe(false)
    expect(appendSwitch).not.toHaveBeenCalled()
  })
})
