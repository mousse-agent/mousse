import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { configureLinuxRendering } from '../src/main/linuxRendering'

describe('Linux rendering policy', () => {
  it('uses full raster and frame presentation without disabling acceleration', () => {
    const appendSwitch = vi.fn()
    const disableHardwareAcceleration = vi.fn()
    const app = { commandLine: { appendSwitch }, disableHardwareAcceleration }
    configureLinuxRendering(app, 'linux')
    expect(appendSwitch.mock.calls).toEqual([
      ['disable-partial-raster'],
      ['ui-disable-partial-swap']
    ])
    expect(disableHardwareAcceleration).not.toHaveBeenCalled()
  })

  it.each(['win32', 'darwin'] as const)('leaves %s rendering unchanged', (platform) => {
    const appendSwitch = vi.fn()
    configureLinuxRendering({ commandLine: { appendSwitch } }, platform)
    expect(appendSwitch).not.toHaveBeenCalled()
  })

  it('applies the policy before GUI startup and outside the headless CLI path', () => {
    const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/else\s*\{\s*configureLinuxRendering\(app, process.platform\)\s*startGuiApp\(\)/)
  })
})
