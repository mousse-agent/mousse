import { describe, expect, it } from 'vitest'
import { linuxGuiLaunchArgs } from '../scripts/linux-gui-launch.mjs'

describe('Linux GUI launch arguments', () => {
  it('passes the X11 flag through electron-vite before Electron starts', () => {
    expect(linuxGuiLaunchArgs(['dev', '--watch'], 'linux', { DISPLAY: ':0' })).toEqual(['dev', '--watch', '--', '--ozone-platform=x11'])
    expect(linuxGuiLaunchArgs(['preview', '--', '--inspect'], 'linux', { DISPLAY: ':0' })).toEqual(['preview', '--', '--inspect', '--ozone-platform=x11'])
  })
  it('preserves explicit Wayland/X11 and does not touch CLI-only, other-platform or display-less launch arguments', () => {
    for (const args of [['dev', '--', '--ozone-platform=wayland'], ['preview', '--', '--ozone-platform', 'x11']]) expect(linuxGuiLaunchArgs(args, 'linux', { DISPLAY: ':0' })).toBe(args)
    const args = ['dev']
    expect(linuxGuiLaunchArgs(args, 'linux', {})).toBe(args)
    for (const platform of ['win32', 'darwin']) expect(linuxGuiLaunchArgs(args, platform, { DISPLAY: ':0' })).toBe(args)
  })
})
