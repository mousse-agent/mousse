/**
 * Sends errors in this window's page to main's `logs/renderer-errors.log`: what React reports (see `lib/appRoot`) and
 * what the page throws or rejects outside React. A window that goes blank then leaves a trace with the error, its
 * stack and the components that were drawing.
 */
import type { RendererErrorKind, RendererErrorReport } from '../../shared/diagnostics/rendererError'
import { useAppStore } from '../stores/appStore'

/** The same error again within this long is counted, not sent, so an error thrown every frame stays one line. */
const REPEAT_WINDOW_MS = 5_000

const lastSent = new Map<string, { at: number; repeats: number }>()

/** Chromium's own notice that a ResizeObserver callback took more than a frame: harmless, and very frequent. */
const BENIGN = /^ResizeObserver loop (limit exceeded|completed with undelivered notifications)/

export function describeThrown(value: unknown): { name: string; message: string; stack?: string } {
  if (value instanceof Error || (value && typeof value === 'object' && typeof (value as Error).message === 'string')) {
    const error = value as Error
    return { name: typeof error.name === 'string' && error.name ? error.name : 'Error', message: error.message, stack: typeof error.stack === 'string' ? error.stack : undefined }
  }
  if (value === null || value === undefined) return { name: String(value), message: '' }
  let message: string
  try { message = typeof value === 'object' ? JSON.stringify(value) : String(value) } catch { message = Object.prototype.toString.call(value) }
  return { name: typeof value, message }
}

function currentView(): string | undefined {
  try {
    const state = useAppStore.getState()
    return state.settingsOpen ? `${state.mainView}+settings` : state.mainView
  } catch {
    return undefined
  }
}

export function reportRendererError(kind: RendererErrorKind, thrown: unknown, extra: { componentStack?: string; source?: string } = {}): void {
  try {
    const described = describeThrown(thrown)
    if (BENIGN.test(described.message)) return
    const key = `${kind}\u0000${described.name}\u0000${described.message}`
    const now = Date.now()
    const last = lastSent.get(key)
    if (last && now - last.at < REPEAT_WINDOW_MS) {
      last.repeats += 1
      return
    }
    lastSent.set(key, { at: now, repeats: 0 })
    if (lastSent.size > 200) lastSent.delete(lastSent.keys().next().value!)
    const report: RendererErrorReport = {
      kind,
      ...described,
      componentStack: extra.componentStack || undefined,
      source: extra.source,
      view: currentView(),
      repeats: last?.repeats || undefined
    }
    window.mousse?.diagnostics?.reportError?.(report)
  } catch {
    // Reporting an error never throws another.
  }
}

/** Reports uncaught errors and unhandled promise rejections in the page. Returns a function that stops. */
export function installWindowErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    reportRendererError('error', event.error ?? event.message, {
      source: event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined
    })
  }
  const onRejection = (event: PromiseRejectionEvent) => reportRendererError('rejection', event.reason)
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

/** Tests only: forgets which errors were sent recently. */
export function resetRendererErrorReportsForTests(): void {
  lastSent.clear()
}
