import { join } from 'path'
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

export function createProcessFailureHandlers(deps: ProcessFailureHandlerDeps): ProcessFailureHandlers {
  let crashing = false
  return {
    onUnhandledRejection(reason) {
      deps.logLine(`[error:daemon] unhandledRejection: ${describeFailure(reason)}`)
    },
    onUncaughtException(error) {
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
      log.flushSync()
    }
  }
}
