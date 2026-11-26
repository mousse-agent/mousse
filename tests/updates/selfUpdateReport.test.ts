import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const userData = mkdtempSync(join(tmpdir(), 'self-update-userdata-'))
const { windowCreated } = vi.hoisted(() => ({ windowCreated: [] as Array<(event: unknown, window: unknown) => void> }))
vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.0',
    isPackaged: false,
    getPath: () => userData,
    on: (event: string, listener: (event: unknown, window: unknown) => void) => {
      if (event === 'browser-window-created') windowCreated.push(listener)
    },
    removeListener: vi.fn(),
    quit: vi.fn()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  nativeImage: { createFromPath: vi.fn() }
}))

import { startDesktopUpdates, updatesDisabledReason } from '../../src/main/updates'
import {
  NO_DESKTOP_APP_REASON,
  readSelfUpdateReport,
  selfUpdateReportPath,
  selfUpdateReporter
} from '../../src/mms/updates/selfUpdateReport'

const homes: string[] = []
const home = () => {
  const path = mkdtempSync(join(tmpdir(), 'self-update-home-'))
  homes.push(path)
  return path
}
afterEach(() => {
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})
afterAll(() => rmSync(userData, { recursive: true, force: true }))

describe('whether this computer updates itself, as the service tells other computers', () => {
  it('says a home with no desktop app cannot update itself, on the channel of its build', () => {
    expect(readSelfUpdateReport(home(), '0.4.0-nightly.20261125.3')).toEqual({
      channel: 'nightly',
      self: false,
      reason: NO_DESKTOP_APP_REASON
    })
    const unreadable = home()
    writeFileSync(selfUpdateReportPath(unreadable), '{"channel":"beta"}')
    expect(readSelfUpdateReport(unreadable, '0.4.0')).toMatchObject({ channel: 'stable', self: false })
  })

  it('reads what the desktop updater last reported, and writes only when that changes', async () => {
    const path = home()
    const file = selfUpdateReportPath(path)
    const report = selfUpdateReporter(path)
    report({ phase: 'idle', channel: 'stable' })
    await report.settled()
    expect(readSelfUpdateReport(path)).toEqual({ channel: 'stable', self: true })
    // A mark the reporter would wipe if it wrote the file again.
    const marked = '{"channel":"stable","self":true,"mark":1}'
    writeFileSync(file, marked)
    // Progress and checks say nothing new: the file is left alone, by this launch and by the next one.
    report({ phase: 'checking', channel: 'stable' })
    report({ phase: 'downloading', channel: 'stable' })
    await report.settled()
    const next = selfUpdateReporter(path)
    next({ phase: 'up-to-date', channel: 'stable' })
    await next.settled()
    expect(readFileSync(file, 'utf8')).toBe(marked)
    report({ phase: 'disabled', channel: 'nightly', disabledReason: 'Updates are turned off by MOUSSE_DISABLE_UPDATES.' })
    await report.settled()
    expect(readSelfUpdateReport(path)).toEqual({
      channel: 'nightly',
      self: false,
      reason: 'Updates are turned off by MOUSSE_DISABLE_UPDATES.'
    })
  })

  it('is written by the desktop updater once its window shows, never before', async () => {
    const path = home()
    const updater = startDesktopUpdates({ home: path, prepareInstall: async () => undefined, recoverInstall: async () => undefined })
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Opening the app waits on no file work.
    expect(existsSync(selfUpdateReportPath(path))).toBe(false)
    const shown: Array<() => void> = []
    for (const listener of windowCreated) listener({}, { once: (event: string, show: () => void) => event === 'show' && shown.push(show) })
    for (const show of shown) show()
    await vi.waitFor(() => expect(existsSync(selfUpdateReportPath(path))).toBe(true))
    const reason = updatesDisabledReason()
    expect(readSelfUpdateReport(path)).toEqual({
      channel: updater.getState().channel,
      self: !reason,
      ...(reason ? { reason } : {})
    })
  })
})
