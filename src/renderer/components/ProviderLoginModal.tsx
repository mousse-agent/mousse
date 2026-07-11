import { useEffect, useState } from 'react'
import { ExternalLink, Loader2, X } from 'lucide-react'
import type { ProviderLoginEvent } from '../../shared/providerAuth'

interface ProviderLoginModalProps {
  active: boolean
  onClose: () => void
}

export function ProviderLoginModal({ active, onClose }: ProviderLoginModalProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [event, setEvent] = useState<ProviderLoginEvent | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) {
      setSessionId(null)
      setEvent(null)
      setInputValue('')
      setError(null)
      return
    }

    const unsub = window.mousse.providers.onLoginEvent((nextEvent) => {
      setSessionId(nextEvent.sessionId)
      setEvent(nextEvent)
      setError(null)
    })

    return unsub
  }, [active])

  if (!active) return null

  const handleCancel = () => {
    if (sessionId) {
      void window.mousse.providers.cancelLogin(sessionId)
    }
    onClose()
  }

  const submitPrompt = () => {
    if (!sessionId || !event || event.type !== 'prompt') return
    void window.mousse.providers.respondLogin({
      sessionId,
      kind: 'prompt',
      value: inputValue
    })
    setInputValue('')
  }

  const submitManualCode = () => {
    if (!sessionId) return
    void window.mousse.providers.respondLogin({
      sessionId,
      kind: 'manual_code',
      value: inputValue
    })
    setInputValue('')
  }

  const submitSelect = (value: string) => {
    if (!sessionId) return
    void window.mousse.providers.respondLogin({
      sessionId,
      kind: 'select',
      value
    })
  }

  return (
    <div className="provider-login-overlay" role="dialog" aria-modal="true">
      <div className="provider-login-modal">
        <header className="provider-login-header">
          <h3>Connect provider</h3>
          <button type="button" className="provider-login-close" onClick={handleCancel}>
            <X size={16} />
          </button>
        </header>

        <div className="provider-login-body">
          {!event && (
            <div className="provider-login-loading">
              <Loader2 size={20} className="icon-spin" />
              <span>Starting authentication…</span>
            </div>
          )}

          {event?.type === 'progress' && (
            <p className="provider-login-message">{event.message}</p>
          )}

          {event?.type === 'auth_url' && (
            <>
              {event.instructions && (
                <p className="provider-login-message">{event.instructions}</p>
              )}
              <a
                className="provider-login-link"
                href={event.url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} />
                Open sign-in page
              </a>
              {event.usesCallbackServer && (
                <p className="provider-login-hint">
                  After signing in, paste the redirect URL below if the browser does not return
                  automatically.
                </p>
              )}
            </>
          )}

          {event?.type === 'device_code' && (
            <div className="provider-login-device-code">
              <p className="provider-login-message">
                Visit <strong>{event.verificationUri}</strong> and enter this code:
              </p>
              <code className="provider-login-code">{event.userCode}</code>
            </div>
          )}

          {event?.type === 'prompt' && (
            <>
              <label className="provider-login-label" htmlFor="provider-login-input">
                {event.message}
              </label>
              <input
                id="provider-login-input"
                className="provider-login-input"
                type={event.promptType === 'secret' ? 'password' : 'text'}
                placeholder={event.placeholder}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitPrompt()
                }}
                autoFocus
              />
              <button type="button" className="provider-login-submit" onClick={submitPrompt}>
                Continue
              </button>
            </>
          )}

          {event?.type === 'select' && (
            <>
              <p className="provider-login-message">{event.message}</p>
              <div className="provider-login-options">
                {event.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="provider-login-option"
                    onClick={() => submitSelect(option.id)}
                  >
                    <span>{option.label}</span>
                    {option.description && (
                      <small>{option.description}</small>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}

          {event?.type === 'manual_code' && (
            <>
              <p className="provider-login-message">{event.message}</p>
              <input
                className="provider-login-input"
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                placeholder="Paste redirect URL"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitManualCode()
                }}
              />
              <button type="button" className="provider-login-submit" onClick={submitManualCode}>
                Submit
              </button>
            </>
          )}

          {error && <p className="provider-login-error">{error}</p>}
        </div>

        <footer className="provider-login-footer">
          <button type="button" className="provider-login-cancel" onClick={handleCancel}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  )
}
