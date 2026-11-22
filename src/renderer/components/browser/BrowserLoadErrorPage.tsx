import { useEffect, useState } from 'react'
import { RefreshCw } from '../../lib/icons'
import { browserLoadErrorView, type BrowserLoadFailure } from './browserLoadError'

/** A browser window whose cable came unplugged: the art of a page the tab couldn't open. Themed by `currentColor` and `--accent`. */
export function BrowserUnreachableArt({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 120 96" fill="none" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle className="browser-load-error-art-glow" cx="60" cy="57" r="24" />
      <g className="browser-load-error-art-frame" stroke="currentColor" strokeWidth="2.5">
        <rect x="4" y="6" width="112" height="84" rx="14" />
        <path d="M4 25h112" />
      </g>
      <g className="browser-load-error-art-frame" fill="currentColor">
        <circle cx="16" cy="15.5" r="2.25" />
        <circle cx="24" cy="15.5" r="2.25" />
        <circle cx="32" cy="15.5" r="2.25" />
      </g>
      <g className="browser-load-error-art-plug" stroke="currentColor" strokeWidth="2.5">
        <path d="M14 78c10 0 12-21 22-21" />
        <rect x="36" y="49" width="12" height="16" rx="3.5" />
        <path d="M48 53.5h6M48 60.5h6" />
        <path d="M84 57c10 0 12-21 22-21" />
        <rect x="72" y="49" width="12" height="16" rx="3.5" />
        <path d="M72 53.5h-2.5M72 60.5h-2.5" />
      </g>
      <g className="browser-load-error-art-spark" stroke="currentColor" strokeWidth="2.25">
        <path d="M61.5 36v6M53 39.5l3 4.5M70 39.5l-3 4.5" />
        <path d="M61.5 78v-6M53 74.5l3-4.5M70 74.5l-3-4.5" />
      </g>
    </svg>
  )
}

/**
 * What a tab shows over its page when the page couldn't be opened: what happened in plain words,
 * what to try, and Reload. Chromium's code stays small, and the address with its number is under Details.
 */
export function BrowserLoadErrorPage({ failure, loading, onReload }: { failure: BrowserLoadFailure; loading: boolean; onReload: () => void }) {
  const view = browserLoadErrorView(failure)
  const [details, setDetails] = useState(false)
  useEffect(() => { setDetails(false) }, [failure])
  return (
    <div className="browser-load-error" role="alert">
      <div className="browser-load-error-body">
        <BrowserUnreachableArt className="browser-load-error-art" />
        <h2 className="browser-load-error-title">{view.title}</h2>
        <p className="browser-load-error-line">{view.host && <><strong>{view.host}</strong>{' '}</>}{view.line}</p>
        {view.tips.length > 0 && (
          <div className="browser-load-error-tips">
            <p>Try:</p>
            <ul>{view.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul>
          </div>
        )}
        <p className="browser-load-error-code">{view.code}</p>
        {details && (
          <p className="browser-load-error-details">
            Mousse couldn’t open <span className="browser-load-error-url">{failure.url}</span>. The browser reported {view.code} ({failure.errorCode}).
          </p>
        )}
        <div className="browser-load-error-actions">
          <button type="button" className="browser-load-error-reload" disabled={loading} onClick={onReload}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} aria-hidden="true" />
            {loading ? 'Reloading…' : 'Reload'}
          </button>
          <button type="button" className="browser-load-error-more" aria-expanded={details} onClick={() => setDetails((open) => !open)}>
            {details ? 'Hide details' : 'Details'}
          </button>
        </div>
      </div>
    </div>
  )
}
