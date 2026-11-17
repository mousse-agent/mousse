/**
 * Main writes the windows' error reports to `logs/renderer-errors.log`, through the IPC listener the preload sends
 * to: message, stack and component stack, with the home folder replaced, and a window sending errors in a loop held
 * to a few lines a minute.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeAllListeners: vi.fn() } }))

import {
  registerRendererErrorIpc,
  RENDERER_ERROR_LINES_PER_MINUTE,
  RENDERER_ERROR_LOG_RELATIVE_PATH,
  RendererErrorLog
} from '../src/main/diagnostics/rendererErrorLog'
import { RENDERER_ERROR_CHANNEL } from '../src/shared/diagnostics/rendererError'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fake `ipcMain` that hands back the listener registered for the error channel. */
function fakeIpc() {
  const listeners = new Map<string, (event: unknown, raw: unknown) => void>()
  return {
    ipc: {
      on: (channel: string, listener: (event: unknown, raw: unknown) => void) => { listeners.set(channel, listener) },
      removeAllListeners: (channel: string) => { listeners.delete(channel) }
    },
    send: (windowId: number, raw: unknown) => listeners.get(RENDERER_ERROR_CHANNEL)!({ sender: { id: windowId } }, raw)
  }
}

const lines = (home: string) => readFileSync(join(home, RENDERER_ERROR_LOG_RELATIVE_PATH), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

describe('the renderer error log', () => {
  it('writes a window render error with its stack and component stack, without the home folder', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-renderer-errors-')); dirs.push(home)
    const connectionLog = { write: vi.fn() }
    const { ipc, send } = fakeIpc()
    registerRendererErrorIpc(new RendererErrorLog(home, { connectionLog }), ipc as never)

    send(3, {
      kind: 'render',
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'title')",
      stack: `TypeError: Cannot read properties of undefined\n    at BotsView (${join(homedir(), 'app', 'index.js')}:1:2)`,
      componentStack: '\n    at BotsView\n    at Workspace',
      view: 'bots'
    })
    send(3, { kind: 'not-a-kind', message: 'ignored' })
    send(3, 'ignored')

    // A render error is flushed at once, so the line is on disk now.
    const [line, ...rest] = lines(home)
    expect(rest).toEqual([])
    expect(line).toMatchObject({ window: 3, kind: 'render', name: 'TypeError', view: 'bots', componentStack: '\n    at BotsView\n    at Workspace' })
    expect(line.stack).toContain('at BotsView (<home>')
    expect(line.stack).not.toContain(homedir())
    // The connection log gets the error's place in the window's story, not its text.
    expect(connectionLog.write).toHaveBeenCalledWith('renderer.error', { window: 3, kind: 'render', error: 'TypeError' })
  })

  it('holds a window in an error loop to a few lines a minute, and counts the rest', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-renderer-errors-')); dirs.push(home)
    let now = Date.parse('2026-11-15T10:00:00.000Z')
    const written: string[] = []
    const log = new RendererErrorLog(home, { now: () => now, file: { write: (line) => { written.push(line) }, flushSync: () => undefined } })

    for (let i = 0; i < RENDERER_ERROR_LINES_PER_MINUTE + 5; i += 1) log.report(1, { kind: 'error', name: 'Error', message: `tick ${i}` })
    log.report(2, { kind: 'error', name: 'Error', message: 'another window' })
    expect(written).toHaveLength(RENDERER_ERROR_LINES_PER_MINUTE + 1)

    now += 60_000
    log.report(1, { kind: 'rejection', name: 'Error', message: 'next minute' })
    expect(JSON.parse(written.at(-1)!)).toMatchObject({ window: 1, message: 'next minute', dropped: 5 })
  })
})
