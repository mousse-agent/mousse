import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProcessFailureHandlers, DAEMON_LOG_RELATIVE_PATH, installDaemonDiagnostics } from '../src/cli/daemonDiagnostics'
import { normalizeAppError } from '../src/shared/errors'
import { logError, logWarn, setDiagSink } from '../src/mms/log/diag'
import { RotatingFileLog } from '../src/mms/log/rotatingFileLog'
import { inTurnBoundary, turnBoundaryMark } from '../src/mms/diagnostics/turnBoundary'
import { turnTimingBegin, turnTimingBind, turnTimingFirstText } from '../src/mms/diagnostics/turnTiming'

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

  it('keeps running when a child program\'s pipe fails to start reading, and only then', async () => {
    const pipeFailure = (stack: string) => Object.assign(new Error('read ENOTCONN'), { code: 'ENOTCONN', syscall: 'read', stack })
    const spawnStack = 'Error: read ENOTCONN\n    at tryReadStart (node:net:776:20)\n    at new Socket (node:net:501:12)\n    at createSocket (node:internal/child_process:337:14)\n    at ChildProcess.spawn (node:internal/child_process:475:23)\n    at execFile (node:child_process:349:17)'
    const { lines, deps, handlers } = setup()
    handlers.onUncaughtException(pipeFailure(spawnStack))
    expect(lines[0]).toContain('kept running')
    expect(deps.shutdown).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()
    // The same code from a socket the service owns is still fatal.
    handlers.onUncaughtException(pipeFailure('Error: read ENOTCONN\n    at tryReadStart (node:net:776:20)\n    at Server.onconnection (node:net:2000:10)'))
    await vi.waitFor(() => expect(deps.exit).toHaveBeenCalledWith(1))
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

describe('error references in daemon.log', () => {
  it('a generic failure the service answers with "Reference: <id>" leaves that id, its method and its redacted cause there', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const homeDir = tmp()
    const diagnostics = installDaemonDiagnostics({ homeDir, shutdown: async () => undefined })
    const secret = 'ghp_0123456789abcdefghijABCDEFGHIJ'
    let message: string
    try {
      message = normalizeAppError(new Error(`git push failed for https://bot:${secret}@example.com/repo.git`), 'handler_error', 'net.link.make').message
    } finally {
      diagnostics.dispose()
    }
    const reference = /Reference: (\S+)$/.exec(message)?.[1]
    const line = readFileSync(join(homeDir, DAEMON_LOG_RELATIVE_PATH), 'utf8').split('\n').find((entry) => entry.includes(`${reference}`))
    expect(line).toContain('"operation":"net.link.make"')
    expect(line).toContain('git push failed')
    expect(line).not.toContain(secret)
    // Once the service's diagnostics are disposed, nothing more is written for it.
    normalizeAppError(new Error('after dispose'))
    expect(readFileSync(join(homeDir, DAEMON_LOG_RELATIVE_PATH), 'utf8')).not.toContain('after dispose')
  })
})

describe('turn timings in daemon.log', () => {
  // The service's standard output goes to mms-startup.log, which stops growing at its size cap; daemon.log keeps these.
  it('a turn boundary\'s line and a bot reply\'s timing line are written there, not only printed', async () => {
    const printed: string[] = []
    vi.spyOn(console, 'info').mockImplementation((line: unknown) => { printed.push(String(line)) })
    const homeDir = tmp()
    const diagnostics = installDaemonDiagnostics({ homeDir, shutdown: async () => undefined })
    try {
      await inTurnBoundary({ threadId: 'thread-1', runId: 'run-1' }, async () => {
        turnBoundaryMark('thread-1', 'workspace')
      })
      turnTimingBegin('bot-1')
      turnTimingBind('bot-1', 'thread-1')
      turnTimingFirstText('thread-1')
    } finally {
      diagnostics.dispose()
    }
    const lines = readFileSync(join(homeDir, DAEMON_LOG_RELATIVE_PATH), 'utf8').split('\n')
    const boundary = lines.find((line) => line.includes(' [turn-boundary] '))
    expect(JSON.parse(boundary!.slice(boundary!.indexOf('{')))).toMatchObject({ threadId: 'thread-1', runId: 'run-1', edge: 'start', phases: { workspace: {} } })
    expect(lines.find((line) => line.includes(' [turn-timing] '))).toContain('"threadId":"thread-1"')
    // Still printed, for a service started by hand.
    expect(printed.filter((line) => line.startsWith('[turn-boundary] ') || line.startsWith('[turn-timing] '))).toHaveLength(2)
  })
})
