import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, Loader2, X } from '../lib/icons'
import type { ProviderLoginEvent } from '../../shared/providerAuth'

interface ProviderLoginModalProps {
  active: boolean
  onClose: () => void
}

/** Sign-in target that must stay visible while the flow waits for the browser. */
type LoginLink =
  | { kind: 'url'; url: string; instructions?: string; usesCallbackServer?: boolean }
  | { kind: 'device'; userCode: string; verificationUri: string }

type StepEvent = Exclude<ProviderLoginEvent, { type: 'auth_url' | 'device_code' | 'manual_code' }>

export function ProviderLoginModal({ active, onClose }: ProviderLoginModalProps) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [step, setStep] = useState<StepEvent | null>(null)
  const [link, setLink] = useState<LoginLink | null>(null)
  const [manualMessage, setManualMessage] = useState<string | null>(null)
  const [showManual, setShowManual] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [copied, setCopied] = useState<'link' | 'code' | null>(null)
  const openedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!active) {
      setSessionId(null)
      setStep(null)
      setLink(null)
      setManualMessage(null)
      setShowManual(false)
      setInputValue('')
      setCopied(null)
      openedRef.current = null
      return
    }

    const unsub = window.mousse.providers.onLoginEvent((event) => {
      setSessionId(event.sessionId)
      if (event.type === 'auth_url') {
        setLink({ kind: 'url', url: event.url, instructions: event.instructions, usesCallbackServer: event.usesCallbackServer })
        setStep(null)
        if (event.usesCallbackServer) setManualMessage("If the browser cannot reach this machine, paste its final redirect URL.")
        return
      }
      if (event.type === 'device_code') {
        setLink({
          kind: 'device',
          userCode: event.userCode,
          verificationUri: event.verificationUri
        })
        setStep(null)
        return
      }
      if (event.type === 'manual_code') {
        // Sent alongside the browser flow as a fallback; never replace the sign-in link.
        setManualMessage(event.message)
        return
      }
      setLink(null)
      setManualMessage(null)
      setShowManual(false)
      setStep(event)
    })

    return unsub
  }, [active])

  // Open the browser once per sign-in target so the user never has to hunt for a link.
  const openTarget = link?.kind === 'url' ? link.url : link?.verificationUri
  useEffect(() => {
    if (!active || !openTarget || openedRef.current === openTarget) return
    openedRef.current = openTarget
    void window.mousse.providers.openLoginUrl(openTarget)
  }, [active, openTarget])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  if (!active) return null

  const handleCancel = () => {
    if (sessionId) {
      void window.mousse.providers.cancelLogin(sessionId)
    }
    onClose()
  }

  const copy = (text: string, which: 'link' | 'code') => {
    void navigator.clipboard.writeText(text).then(() => setCopied(which))
  }

  const submitPrompt = () => {
    if (!sessionId || !step || step.type !== 'prompt') return
    void window.mousse.providers.respondLogin({ sessionId, kind: 'prompt', value: inputValue })
    setInputValue('')
  }

  const submitManualCode = () => {
    if (!sessionId || !inputValue.trim()) return
    void window.mousse.providers.respondLogin({
      sessionId,
      kind: 'manual_code',
      value: inputValue
    })
    setInputValue('')
    setShowManual(false)
    setManualMessage(null)
  }

  const submitSelect = (value: string) => {
    if (!sessionId) return
    void window.mousse.providers.respondLogin({ sessionId, kind: 'select', value })
    setStep(null)
  }

  const waiting = link !== null

  return (
    <div className="provider-login-overlay" role="dialog" aria-modal="true">
      <div className="provider-login-modal">
        <header className="provider-login-header">
          <h3>Connect provider</h3>
          <button
            type="button"
            className="provider-login-close"
            onClick={handleCancel}
            aria-label="Cancel sign-in"
          >
            <X size={16} />
          </button>
        </header>

        <div className="provider-login-body">
          {!step && !link && (
            <div className="provider-login-loading">
              <Loader2 size={16} className="icon-spin" />
              <span>Starting authentication…</span>
            </div>
          )}

          {step?.type === 'progress' && (
            <div className="provider-login-loading">
              <Loader2 size={16} className="icon-spin" />
              <span>{step.message}</span>
            </div>
          )}

          {link?.kind === 'url' && (
            <>
              <p className="provider-login-message">
                We opened your browser to finish signing in. Come back here when you&apos;re done
                and this window will close on its own.
              </p>
              <div className="provider-login-actions">
                <button
                  type="button"
                  className="provider-login-submit"
                  onClick={() => void window.mousse.providers.openLoginUrl(link.url)}
                >
                  <ExternalLink size={14} />
                  Open sign-in page again
                </button>
                <button
                  type="button"
                  className="provider-login-secondary"
                  onClick={() => copy(link.url, 'link')}
                >
                  {copied === 'link' ? <Check size={14} /> : <Copy size={14} />}
                  {copied === 'link' ? 'Copied' : 'Copy link'}
                </button>
              </div>
            </>
          )}

          {link?.kind === 'device' && (
            <div className="provider-login-device-code">
              <p className="provider-login-message">
                We opened <strong>{link.verificationUri}</strong>. Enter this code there to
                connect:
              </p>
              <code className="provider-login-code">{link.userCode}</code>
              <div className="provider-login-actions">
                <button
                  type="button"
                  className="provider-login-submit"
                  onClick={() => copy(link.userCode, 'code')}
                >
                  {copied === 'code' ? <Check size={14} /> : <Copy size={14} />}
                  {copied === 'code' ? 'Copied' : 'Copy code'}
                </button>
                <button
                  type="button"
                  className="provider-login-secondary"
                  onClick={() => void window.mousse.providers.openLoginUrl(link.verificationUri)}
                >
                  <ExternalLink size={14} />
                  Open page again
                </button>
              </div>
            </div>
          )}

          {waiting && (
            <div className="provider-login-loading">
              <Loader2 size={16} className="icon-spin" />
              <span>Waiting for you to finish in the browser…</span>
            </div>
          )}

          {link?.kind === 'url' && manualMessage && (
            <div className="provider-login-fallback">
              {!showManual ? (
                <button
                  type="button"
                  className="provider-login-linkbutton"
                  onClick={() => setShowManual(true)}
                >
                  Browser didn&apos;t return here?
                </button>
              ) : (
                <>
                  <p className="provider-login-hint">
                    After signing in, copy the full address from the browser&apos;s address bar
                    (it starts with http://localhost:1455/…) and paste it here. The page may say it
                    can&apos;t be reached, which is expected.
                  </p>
                  <input
                    className="provider-login-input"
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    placeholder="http://localhost:1455/auth/callback?code=…"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitManualCode()
                    }}
                    autoFocus
                  />
                  <button
                    type="button"
                    className="provider-login-submit"
                    onClick={submitManualCode}
                    disabled={!inputValue.trim()}
                  >
                    Continue
                  </button>
                </>
              )}
            </div>
          )}

          {step?.type === 'prompt' && (
            <>
              <label className="provider-login-label" htmlFor="provider-login-input">
                {step.message}
              </label>
              <input
                id="provider-login-input"
                className="provider-login-input"
                type={step.promptType === 'secret' ? 'password' : 'text'}
                placeholder={step.placeholder}
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

          {step?.type === 'select' && (
            <>
              <p className="provider-login-message">{step.message}</p>
              <div className="provider-login-options">
                {step.options.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className="provider-login-option"
                    onClick={() => submitSelect(option.id)}
                  >
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </button>
                ))}
              </div>
            </>
          )}
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
