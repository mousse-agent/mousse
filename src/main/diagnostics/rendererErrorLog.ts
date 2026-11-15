/**
 * Errors in the windows' pages, written by main to `<home>/logs/renderer-errors.log`, beside `gui-connection.log`:
 * a component that threw while drawing, what React reported, and uncaught errors and rejected promises. One JSON
 * object a line, with the error's message, stack and component stack, so a window that went blank leaves a trace.
 *
 * The file stays on this computer. Text that names the home folder has it replaced by `<home>`, each field is cut to
 * a few kilobytes, and a window sending errors in a loop is held to a few lines a minute, with a count of what was
 * left out. The file rotates at 1 MB and keeps two older files. The connection log gets one short line per error
 * (window, kind and class, no text), so it reads in order with the window's other events.
 */
import { join } from 'path'
import { ipcMain } from 'electron'
import { RotatingFileLog } from '../../mms/log/rotatingFileLog'
import { RENDERER_ERROR_CHANNEL, RENDERER_ERROR_KINDS, type RendererErrorKind, type RendererErrorReport } from '../../shared/diagnostics/rendererError'
import { withoutHome, type GuiConnectionLogSink } from '../mms/guiConnectionLog'

export const RENDERER_ERROR_LOG_RELATIVE_PATH = join('logs', 'renderer-errors.log')
export const RENDERER_ERROR_LOG_MAX_BYTES = 1_000_000
export const RENDERER_ERROR_LOG_KEEP = 2
/** Lines one window may write in a minute; the rest are counted. */
export const RENDERER_ERROR_LINES_PER_MINUTE = 30

const LIMITS = { name: 80, message: 2_000, stack: 8_000, componentStack: 8_000, source: 400, view: 80 } as const

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const scrubbed = withoutHome(value)
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed
}

/** The report the page sent, checked and cut to size; undefined when it is not one. */
export function readRendererErrorReport(raw: unknown): RendererErrorReport | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Record<string, unknown>
  if (!RENDERER_ERROR_KINDS.includes(value.kind as RendererErrorKind)) return undefined
  const repeats = typeof value.repeats === 'number' && Number.isFinite(value.repeats) && value.repeats > 0 ? Math.floor(value.repeats) : undefined
  return {
    kind: value.kind as RendererErrorKind,
    name: text(value.name, LIMITS.name) ?? 'Error',
    message: text(value.message, LIMITS.message) ?? '',
    stack: text(value.stack, LIMITS.stack),
    componentStack: text(value.componentStack, LIMITS.componentStack),
    source: text(value.source, LIMITS.source),
    view: text(value.view, LIMITS.view),
    repeats
  }
}

export interface RendererErrorSink {
  report(window: number, raw: unknown): void
}

export class RendererErrorLog implements RendererErrorSink {
  readonly path: string
  private readonly file: Pick<RotatingFileLog, 'write' | 'flushSync'>
  private readonly now: () => number
  private readonly connectionLog?: Pick<GuiConnectionLogSink, 'write'>
  /** Per window: when its current minute started, lines written in it, and lines left out. */
  private readonly budget = new Map<number, { since: number; lines: number; dropped: number }>()

  constructor(homeDir: string, options: {
    connectionLog?: Pick<GuiConnectionLogSink, 'write'>
    now?: () => number
    file?: Pick<RotatingFileLog, 'write' | 'flushSync'>
  } = {}) {
    this.path = join(homeDir, RENDERER_ERROR_LOG_RELATIVE_PATH)
    this.now = options.now ?? Date.now
    this.connectionLog = options.connectionLog
    this.file = options.file ?? new RotatingFileLog({
      path: this.path,
      maxBytes: RENDERER_ERROR_LOG_MAX_BYTES,
      keep: RENDERER_ERROR_LOG_KEEP,
      flushIntervalMs: 200
    })
  }

  report(window: number, raw: unknown): void {
    try {
      const report = readRendererErrorReport(raw)
      if (!report) return
      const now = this.now()
      let budget = this.budget.get(window)
      if (!budget || now - budget.since >= 60_000) {
        budget = { since: now, lines: 0, dropped: budget?.dropped ?? 0 }
        this.budget.set(window, budget)
      }
      if (budget.lines >= RENDERER_ERROR_LINES_PER_MINUTE) {
        budget.dropped += 1
        return
      }
      budget.lines += 1
      const dropped = budget.dropped || undefined
      budget.dropped = 0
      this.file.write(JSON.stringify({ t: new Date(now).toISOString(), window, ...report, dropped }))
      this.connectionLog?.write('renderer.error', { window, kind: report.kind, error: report.name })
      // A render error is the window going blank or showing its error line: on disk now, in case the app goes next.
      if (report.kind === 'render' || report.kind === 'uncaught') this.file.flushSync()
    } catch {
      // Diagnostics never take main down.
    }
  }
}

type IpcLike = Pick<typeof ipcMain, 'on' | 'removeAllListeners'>

/** Listens for the windows' error reports (`window.mousse.diagnostics.reportError`). */
export function registerRendererErrorIpc(log: RendererErrorSink, ipc: IpcLike = ipcMain): void {
  ipc.removeAllListeners(RENDERER_ERROR_CHANNEL)
  ipc.on(RENDERER_ERROR_CHANNEL, (event: { sender?: { id?: number } }, raw: unknown) => {
    log.report(event.sender?.id ?? -1, raw)
  })
}
