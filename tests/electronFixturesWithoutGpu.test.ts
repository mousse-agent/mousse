import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NO_GPU_SWITCHES, runWithoutGpu } from './fixtures/electronWithoutGpu.mjs'

function fakeElectron(windows: Array<{ destroyed: boolean; url: string }>) {
  const exits: number[] = []
  const app = {
    disableHardwareAcceleration: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    exit: (code?: number) => { exits.push(code ?? 0) }
  }
  const BrowserWindow = {
    getAllWindows: () => windows.map((window) => ({ isDestroyed: () => window.destroyed, webContents: { getURL: () => window.url } }))
  }
  return { app, BrowserWindow, exits }
}

afterEach(() => { vi.restoreAllMocks() })

describe('runWithoutGpu', () => {
  it('turns the GPU off and reduced motion on', () => {
    const { app, BrowserWindow } = fakeElectron([])
    runWithoutGpu({ app, BrowserWindow })
    expect(app.disableHardwareAcceleration).toHaveBeenCalledOnce()
    expect(app.commandLine.appendSwitch.mock.calls.map(([name]) => name)).toEqual(['disable-gpu', 'disable-gpu-compositing', 'force-prefers-reduced-motion'])
  })

  it('fails a passing exit while a window is still open', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const { app, BrowserWindow, exits } = fakeElectron([{ destroyed: false, url: 'http://127.0.0.1:1/' }, { destroyed: true, url: 'about:blank' }])
    runWithoutGpu({ app, BrowserWindow })
    app.exit(0)
    expect(exits).toEqual([1])
    expect(String(stderr.mock.calls[0]?.[0])).toContain('1 window(s) still open when the test app exited: http://127.0.0.1:1/')
  })

  it('keeps the exit code when every window is closed, or when the app already failed', () => {
    const closed = fakeElectron([{ destroyed: true, url: 'about:blank' }])
    runWithoutGpu(closed)
    closed.app.exit()
    expect(closed.exits).toEqual([0])
    const failed = fakeElectron([{ destroyed: false, url: '' }])
    runWithoutGpu(failed)
    failed.app.exit(2)
    expect(failed.exits).toEqual([2])
  })
})

describe('Electron test fixtures', () => {
  const root = join(process.cwd(), 'tests', 'fixtures')
  const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => /\.(?:[cm]?[jt]s|tsx)$/.test(path))
    .map((path) => ({ path: relative(process.cwd(), join(root, path)).replaceAll('\\', '/'), text: readFileSync(join(root, path), 'utf8') }))
  const apps = sources.filter(({ text }) => /\bapp\.whenReady\(/.test(text) && /['"]electron['"]/.test(text))

  it('finds the Electron apps tests start', () => {
    expect(apps.map(({ path }) => path)).toContain('tests/fixtures/turn-window/main.ts')
    expect(apps.length).toBeGreaterThanOrEqual(15)
  })

  it('start every one of them without the GPU', () => {
    expect(apps.filter(({ text }) => !text.includes('runWithoutGpu({ app, BrowserWindow })')).map(({ path }) => path)).toEqual([])
  })

  it('never show a window or ask for GPU features', () => {
    const gpuHeavy = /show:\s*true|enable-gpu|ignore-gpu-blocklist|force_high_performance_gpu|enable-zero-copy/
    expect(sources.filter(({ text }) => gpuHeavy.test(text)).map(({ path }) => path)).toEqual([])
    expect(NO_GPU_SWITCHES).toContain('disable-gpu')
  })
})
