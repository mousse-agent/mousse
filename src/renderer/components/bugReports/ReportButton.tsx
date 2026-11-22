import type { ErrorReportInput } from '../../services/bugReportsClient'
import { errorReportKey, reportError, useBugReportStore } from '../../stores/bugReportStore'
import '../../styles/bugReports.css'

/**
 * An error's Report action: opens the report dialog with this error's draft. Once filed it reads "Reported · #N" (or
 * "Added to #N") and links to the issue. Nothing shows while Settings → General → Report button is off.
 */
export function ReportButton({ error, className = '' }: { error: ErrorReportInput; className?: string }) {
  const enabled = useBugReportStore((state) => state.settings.enabled)
  const outcome = useBugReportStore((state) => state.reported[errorReportKey(error)])
  if (!enabled) return null
  if (outcome && (outcome.status === 'filed' || outcome.status === 'existing')) {
    return (
      <a className={`bug-report-done ${className}`.trim()} href={outcome.url} target="_blank" rel="noopener noreferrer" title="Open the issue on GitHub">
        {outcome.status === 'filed' ? `Reported · #${outcome.number}` : `Added to #${outcome.number}`}
      </a>
    )
  }
  return (
    <button type="button" className={`bug-report-action ${className}`.trim()} title="Report this error as a public GitHub issue, filed from your GitHub account. You see the draft first." onClick={(event) => { event.stopPropagation(); reportError(error) }}>
      Report
    </button>
  )
}

/** The reference id, small and in mono: the only mono text an error shows. */
export function ErrorReference({ reference }: { reference: string }) {
  return <span className="bug-report-ref" title={`Reference ${reference}`}>Ref <code>{reference.slice(0, 8)}</code></span>
}
