import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessFailureHandlers } from '../src/cli/daemonDiagnostics'
import { logError, logWarn, setDiagSink } from '../src/mms/log/diag'
import { RotatingFileLog } from '../src/mms/log/rotatingFileLog'

const dirs: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mousse-diag-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  setDiagSink(null)
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RotatingFileLog', () => {
  it('appends buffered lines on flush', async () => {
    const path = join(tmp(), 'logs', 'daemon.log')
    const log = new RotatingFileLog({ path })
    log.write('one')
    log.write('two\n')
    await log.flush()
    expect(readFileSync(path, 'utf-8')).toBe('one\ntwo\n')
  })

  it('rotates past the size cap and keeps only 3 files', async () => {
    const path = join(tmp(), 'daemon.log')
    const log = new RotatingFileLog({ path, maxBytes: 100, keep: 3 })
    for (let i = 0; i < 6; i++) {
      log.write(`entry-${i}-${'x'.repeat(70)}`)
      await log.flush()
    }
    expect(readFileSync(path, 'utf-8')).toContain('entry-5')
    expect(readFileSync(`${path}.1`, 'utf-8')).toContain('entry-4')
    expect(readFileSync(`${path}.2`, 'utf-8')).toContain('entry-3')
    expect(readFileSync(`${path}.3`, 'utf-8')).toContain('entry-2')
    expect(existsSync(`${path}.4`)).toBe(false)
  })

  it('accounts for pre-existing file size and rotates in flushSync', () => {
    const path = join(tmp(), 'daemon.log')
    writeFileSync(path, 'a'.repeat(90))
    const log = new RotatingFileLog({ path, maxBytes: 100, keep: 3 })
    log.write('b'.repeat(30))
    log.flushSync()
    expect(readFileSync(`${path}.1`, 'utf-8')).toBe('a'.repeat(90))
    expect(readFileSync(path, 'utf-8')).toBe(`${'b'.repeat(30)}\n`)
  })
})

describe('diag sink', () => {
  it('forwards warn and error lines but not debug when disabled', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const sink = vi.fn()
    setDiagSink(sink)
    logWarn('m', 'w', undefined, { apiToken: 'secret-value' })
    logError('m', 'e')
    expect(sink).toHaveBeenCalledTimes(2)
    expect(sink.mock.calls[0][1]).toContain('<redacted>')
    expect(sink.mock.calls[0][1]).not.toContain('secret-value')
  })
})

describe('process failure handlers', () => {
  function setup() {
    const lines: string[] = []
    const deps = {
      logLine: (l: string) => lines.push(l),
      shutdown: vi.fn(async () => undefined),
      flushSync: vi.fn(),
      exit: vi.fn(),
      shutdownTimeoutMs: 20
    }
    return { lines, deps, handlers: createProcessFailureHandlers(deps) }
  }

  it('logs unhandled rejections with a stack and keeps running', () => {
    const { lines, deps, handlers } = setup()
    handlers.onUnhandledRejection(new Error('nope'))
    expect(lines[0]).toContain('unhandledRejection')
    expect(lines[0]).toContain('Error: nope')
    expect(lines[0]).toContain('at ')
    expect(deps.shutdown).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()
  })

  it('logs uncaught exceptions, shuts down, then exits non-zero', async () => {
    const { lines, deps, handlers } = setup()
    handlers.onUncaughtException(new Error('crash'))
    await vi.waitFor(() => expect(deps.exit).toHaveBeenCalledWith(1))
    expect(lines[0]).toContain('uncaughtException')
    expect(deps.shutdown).toHaveBeenCalledWith('uncaughtException', 1)
    expect(deps.flushSync).toHaveBeenCalled()
  })

  it('still exits when shutdown hangs', async () => {
    const { deps, handlers } = setup()
    deps.shutdown.mockImplementation(() => new Promise<void>(() => undefined))
    handlers.onUncaughtException('boom')
    await vi.waitFor(() => expect(deps.exit).toHaveBeenCalledWith(1))
  })

  it('handles repeated uncaught exceptions once', async () => {
    const { deps, handlers } = setup()
    handlers.onUncaughtException(new Error('a'))
    handlers.onUncaughtException(new Error('b'))
    await vi.waitFor(() => expect(deps.exit).toHaveBeenCalledTimes(1))
    expect(deps.shutdown).toHaveBeenCalledTimes(1)
  })
})
