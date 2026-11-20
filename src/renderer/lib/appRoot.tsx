/**
 * The window's React root and its last line of defence. A component that throws while drawing replaces the app with
 * one line and a Reload button, instead of React emptying the window. Every error React sees (that one, those the
 * app's own boundaries catch, and any it cannot place) goes to main's log with its component stack.
 */
import { Component, useState, type ReactNode } from 'react'
import { createRoot, type RootOptions } from 'react-dom/client'
import { describeThrown, reportRendererError } from '../services/rendererErrors'
import { reloadWindow } from '../services/reloadWindow'
import { ReportButton } from '../components/bugReports/ReportButton'
import { BugReportDialogHost } from '../components/bugReports/BugReportDialog'

function RenderFailed({ error }: { error: unknown }) {
  const [unsaved, setUnsaved] = useState(false)
  const { name, message, stack } = describeThrown(error)
  const reload = async () => {
    setUnsaved(false)
    if (await reloadWindow() === 'unsaved') setUnsaved(true)
  }
  return (
    <div className="root-render-failed" role="alert">
      <p className="root-render-failed-line">
        This window hit an error.{' '}
        <button type="button" className="root-render-failed-reload" onClick={() => void reload()}>Reload</button>
        {unsaved && <span className="root-render-failed-note"> Save or close unsaved files first.</span>}
        {' '}<ReportButton error={{ title: 'This window hit an error', message: `${name}: ${message}`, ...(stack ? { stack } : {}), surface: 'window' }} />
      </p>
      {/* The app behind this screen is gone, and its report dialog with it. */}
      <BugReportDialogHost />
      <details className="root-render-failed-details">
        <summary>Details</summary>
        <pre>{stack && stack.includes(message) ? stack : `${name}: ${message}${stack ? `\n${stack}` : ''}`}</pre>
      </details>
    </div>
  )
}

/** Shows `RenderFailed` in place of the app once anything below throws while drawing. */
export class RootErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; error: unknown }> {
  state: { failed: boolean; error: unknown } = { failed: false, error: null }

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error }
  }

  render() {
    return this.state.failed ? <RenderFailed error={this.state.error} /> : this.props.children
  }
}

export const rootErrorOptions: Pick<RootOptions, 'onUncaughtError' | 'onCaughtError' | 'onRecoverableError'> = {
  onUncaughtError(error, info) {
    console.error(error, info.componentStack)
    reportRendererError('uncaught', error, { componentStack: info.componentStack })
  },
  onCaughtError(error, info) {
    console.error(error, info.componentStack)
    reportRendererError(info.errorBoundary instanceof RootErrorBoundary ? 'render' : 'caught', error, { componentStack: info.componentStack })
  },
  onRecoverableError(error, info) {
    console.warn(error, info.componentStack)
    reportRendererError('recoverable', error, { componentStack: info.componentStack })
  }
}

/** A React root that reports its errors; render the app inside `RootErrorBoundary`. */
export function createAppRoot(container: Element) {
  return createRoot(container, rootErrorOptions)
}
