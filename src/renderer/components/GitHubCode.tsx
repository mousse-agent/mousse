import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink } from '../lib/icons'
import { openExternalUrl } from './PullRequestMarkdown'

const DEVICE_URL = 'https://github.com/login/device'

/**
 * GitHub's one-time code from a sign-in in progress, with Copy and Open GitHub: on this computer or relayed from
 * another, since the code can be entered in any browser.
 */
export function GitHubCode({ code, url = DEVICE_URL, className = 'source-control-code' }: { code: string; url?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(code))
      .then(() => setCopied(true), () => setCopied(false))
  }
  return (
    <div className={className}>
      <code className="provider-login-code" aria-label="One-time code">{code}</code>
      <button type="button" className="settings-icon-btn" title="Copy code" aria-label="Copy code" onClick={copy}>
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <button type="button" className="settings-btn" title={url} onClick={() => openExternalUrl(url)}>
        <ExternalLink size={14} />
        Open GitHub
      </button>
    </div>
  )
}
