import { join } from 'path'
import { setErrorReferenceSink, type ErrorReferenceEntry } from '../shared/errors'
import { setDiagSink } from '../mms/log/diag'
import { RotatingFileLog } from '../mms/log/rotatingFileLog'

export const DAEMON_LOG_RELATIVE_PATH = join('logs', 'daemon.log')
const UNCAUGHT_SHUTDOWN_TIMEOUT_MS = 5000

export interface ProcessFailureHandlerDeps {
  /** Writes a fully formatted line (with stack) to the persistent log. */
  logLine: (line: string) => void
  /** Attempts the existing graceful shutdown path. */
  shutdown: (reason: string, exitCode: number) => Promise<void>
  /** Flush persistent logs synchronously before exit. */
  flushSync: () => void
  exit: (code: number) => void
  shutdownTimeoutMs?: number
}

export interface ProcessFailureHandlers {
  onUnhandledRejection: (reason: unknown) => void
  onUncaughtException: (error: unknown) => void
}

function describeFailure(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  try {
    return typeof error === 'string' ? error : JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * A child program's output pipe that failed to start reading (`read ENOTCONN`, seen on Windows while the service
 * starts several programs at once). Node raises it on the pipe with no listener, so it lands here; the program's own
 * call still ends (it closes or fails), so the service only logs it instead of shutting down.
 */
export function isChildPipeReadFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const { code, syscall } = error as NodeJS.ErrnoException
  return code === 'ENOTCONN' && syscall === 'read' && /\bcreateSocket\b[\s\S]*\bChildProcess\.spawn\b/.test(error.stack ?? '')
}

export function createProcessFailureHandlers(deps: ProcessFailureHandlerDeps): ProcessFailureHandlers {
  let crashing = false
  return {
    onUnhandledRejection(reason) {
      deps.logLine(`[error:daemon] unhandledRejection: ${describeFailure(reason)}`)
    },
    onUncaughtException(error) {
      if (isChildPipeReadFailure(error)) {
        deps.logLine(`[warn:daemon] child program pipe failed, kept running: ${describeFailure(error)}`)
        return
      }
      deps.logLine(`[error:daemon] uncaughtException: ${describeFailure(error)}`)
      if (crashing) return
      crashing = true
      const timeoutMs = deps.shutdownTimeoutMs ?? UNCAUGHT_SHUTDOWN_TIMEOUT_MS
      let timer: NodeJS.Timeout | undefined
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
      void Promise.race([
        deps.shutdown('uncaughtException', 1).catch(() => undefined),
        timeout
      ]).finally(() => {
        if (timer) clearTimeout(timer)
        deps.flushSync()
        deps.exit(1)
      })
    }
  }
}

/**
 * The daemon.log line for a generic failure's `Reference: <id>`, so the id a person reports can be found: the id,
 * the error code, the method and the redacted causes (`errorCauseText`), never a secret.
 */
export function errorReferenceLine(entry: ErrorReferenceEntry): string {
  const fields = JSON.stringify({ code: entry.code, ...(entry.operation ? { operation: entry.operation } : {}) })
  return `[error:reference] ${entry.reference} ${fields}${entry.cause ? ` :: ${entry.cause}` : ''}`
}

export interface DaemonDiagnostics {
  log: RotatingFileLog
  dispose: () => void
}

/**
 * Daemon-process-only wiring: persists diag output to <home>/logs/daemon.log
 * and registers crash handlers. Never call from library modules or tests.
 */
export function installDaemonDiagnostics(opts: {
  homeDir: string
  shutdown: (reason: string, exitCode: number) => Promise<void>
}): DaemonDiagnostics {
  const log = new RotatingFileLog({ path: join(opts.homeDir, DAEMON_LOG_RELATIVE_PATH) })
  const stamp = (line: string): string => `${new Date().toISOString()} ${line}`
  setDiagSink((_level, line) => log.write(stamp(line)))
  setErrorReferenceSink((entry) => {
    const line = errorReferenceLine(entry)
    console.error(line)
    log.write(stamp(line))
  })

  const handlers = createProcessFailureHandlers({
    logLine: (line) => {
      console.error(line)
      log.write(stamp(line))
    },
    shutdown: opts.shutdown,
    flushSync: () => log.flushSync(),
    exit: (code) => process.exit(code)
  })
  process.on('unhandledRejection', handlers.onUnhandledRejection)
  process.on('uncaughtException', handlers.onUncaughtException)
  const onExit = (): void => log.flushSync()
  process.on('exit', onExit)

  return {
    log,
    dispose: () => {
      process.off('unhandledRejection', handlers.onUnhandledRejection)
      process.off('uncaughtException', handlers.onUncaughtException)
      process.off('exit', onExit)
      setDiagSink(null)
      setErrorReferenceSink(null)
      log.flushSync()
    }
  }
}
