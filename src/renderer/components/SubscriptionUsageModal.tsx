import { useEffect } from 'react'
import { Loader2, X } from 'lucide-react'

interface SubscriptionUsageModalProps {
  open: boolean
  providerLabel: string
  usage?: string
  loading: boolean
  error?: string
  onClose: () => void
}

/** Displays provider-supplied subscription usage without deriving or estimating quotas. */
export function SubscriptionUsageModal({
  open,
  providerLabel,
  usage,
  loading,
  error,
  onClose
}: SubscriptionUsageModalProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="subscription-usage-overlay" role="presentation" onMouseDown={onClose}>
      <section
        className="subscription-usage-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subscription-usage-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="subscription-usage-header">
          <div>
            <h3 id="subscription-usage-title">Subscription usage</h3>
            <p>{providerLabel}</p>
          </div>
          <button type="button" className="subscription-usage-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="subscription-usage-body">
          {loading ? (
            <div className="subscription-usage-loading"><Loader2 size={18} className="icon-spin" /> Loading usage…</div>
          ) : error ? (
            <p className="subscription-usage-status">{error}</p>
          ) : usage ? (
            <pre className="subscription-usage-content">{usage}</pre>
          ) : (
            <p className="subscription-usage-status">Subscription usage is not available for this provider.</p>
          )}
        </div>
      </section>
    </div>
  )
}
