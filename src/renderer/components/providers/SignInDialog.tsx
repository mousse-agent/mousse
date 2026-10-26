import { useEffect, useRef, useState } from 'react'
import type { SignInPrompt, SignInResponse } from '../../../shared/harness/types'
import { Check, Copy, ExternalLink, Loader2 } from '../../lib/icons'
import { useProviderSnapshotsStore } from '../../lib/providerSnapshots'
import { Modal } from '../ui/Modal'
import { errorText } from './parts'

/** The pasted-address fallback shows only while the sign-in says it accepts one. */
export function offersRedirectPaste(prompt: SignInPrompt): boolean {
  return prompt.type === 'auth_url' && prompt.acceptsRedirectPaste === true
}

/** What to say when the sign-in refuses an answer. */
export function refusedText(response: SignInResponse): string {
  return response.kind === 'redirect_url'
    ? "That address didn't finish the sign-in. Copy the full address from the browser again and paste it here."
    : "The sign-in didn't take that answer. Try again."
}

/**
 * A provider sign-in started with `providers.instances.signIn`: shows the step the operation asks
 * for (a browser link, a device code, a field, a choice) and answers it with `respondSignIn`.
 * Closing cancels the sign-in. It closes itself when the operation completes.
 */
export function SignInDialog({ operationId, name, onClose }: { operationId: string | null; name: string; onClose: () => void }) {
  const event = useProviderSnapshotsStore((state) => (operationId ? state.operations[operationId] : undefined))
  const latestPrompt = useProviderSnapshotsStore((state) => (operationId ? state.prompts[operationId] : undefined))
  /** An answered field or choice gives way to progress until the next step arrives. */
  const [answered, setAnswered] = useState<string | null>(null)
  const failed = event?.phase === 'failed'
  const prompt: SignInPrompt | null =
    latestPrompt && !failed && (latestPrompt.promptId !== answered || latestPrompt.type === 'auth_url' || latestPrompt.type === 'device_code') ? latestPrompt : null
  const progress = event?.phase === 'progress' ? event.message : null
  const [value, setValue] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const [copied, setCopied] = useState<'link' | 'code' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const openedRef = useRef<string | null>(null)

  useEffect(() => {
    setAnswered(null)
    setValue('')
    setShowPaste(false)
    setError(null)
    openedRef.current = null
  }, [operationId])

  useEffect(() => {
    if (event?.phase === 'completed' || event?.phase === 'cancelled') onClose()
  }, [event, onClose])

  // Open the browser once per sign-in target so the user never has to hunt for a link.
  const target = prompt?.type === 'auth_url' ? prompt.url : prompt?.type === 'device_code' ? prompt.verificationUri : undefined
  useEffect(() => {
    if (!target || openedRef.current === target) return
    openedRef.current = target
    void window.mousse.providers.openLoginUrl(target)
  }, [target])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  if (!operationId) return null

  const respond = (response: SignInResponse) => {
    setError(null)
    if (response.promptId) setAnswered(response.promptId)
    setValue('')
    void window.mousse.providers.instances
      .respondSignIn(operationId, response)
      .then((accepted) => {
        // Refused (a stale prompt, a wrong address): say so and show the step again.
        if (accepted || response.kind === 'cancel') return
        setAnswered(null)
        setError(refusedText(response))
      })
      .catch((failure) => setError(errorText(failure)))
  }
  const cancel = () => {
    if (event?.phase !== 'failed') respond({ kind: 'cancel' })
    onClose()
  }
  const copy = (text: string, which: 'link' | 'code') => void navigator.clipboard.writeText(text).then(() => setCopied(which))
  const failure = error ?? (event?.phase === 'failed' ? event.error.message : null)

  return (
    <Modal open title={`Sign in to ${name}`} onClose={cancel}>
      <div className="provider-login-body">
        {!prompt && !failed && (
          <div className="provider-login-loading">
            <Loader2 size={16} className="icon-spin" />
            <span>{progress ?? 'Starting sign-in…'}</span>
          </div>
        )}

        {prompt?.type === 'auth_url' && (
          <>
            <p className="provider-login-message">
              {prompt.instructions ?? 'We opened your browser to finish signing in. Come back here when you’re done and this window will close on its own.'}
            </p>
            <div className="provider-login-actions">
              <button type="button" className="settings-btn" onClick={() => void window.mousse.providers.openLoginUrl(prompt.url)}>
                <ExternalLink size={14} />
                Open sign-in page again
              </button>
              <button type="button" className="settings-btn" onClick={() => copy(prompt.url, 'link')}>
                {copied === 'link' ? <Check size={14} /> : <Copy size={14} />}
                {copied === 'link' ? 'Copied' : 'Copy link'}
              </button>
            </div>
            <div className="provider-login-loading">
              <Loader2 size={16} className="icon-spin" />
              <span>Waiting for you to finish in the browser…</span>
            </div>
            {offersRedirectPaste(prompt) && (
              <div className="provider-login-fallback">
                {!showPaste ? (
                  <button type="button" className="provider-login-linkbutton" onClick={() => setShowPaste(true)}>
                    Browser didn&apos;t return here?
                  </button>
                ) : (
                  <>
                    <p className="provider-login-hint">
                      After signing in, copy the full address from the browser&apos;s address bar and paste it here. The page may say it
                      can&apos;t be reached, which is expected.
                    </p>
                    <input
                      className="provider-login-input"
                      type="text"
                      value={value}
                      autoFocus
                      placeholder="http://localhost:…"
                      onChange={(change) => setValue(change.target.value)}
                      onKeyDown={(key) => {
                        if (key.key === 'Enter' && value.trim()) respond({ promptId: prompt.promptId, kind: 'redirect_url', value: value.trim() })
                      }}
                    />
                    <button
                      type="button"
                      className="settings-btn"
                      disabled={!value.trim()}
                      onClick={() => respond({ promptId: prompt.promptId, kind: 'redirect_url', value: value.trim() })}
                    >
                      Continue
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        )}

        {prompt?.type === 'device_code' && (
          <div className="provider-login-device-code">
            <p className="provider-login-message">
              We opened <strong>{prompt.verificationUri}</strong>. Enter this code there to connect:
            </p>
            <code className="provider-login-code">{prompt.userCode}</code>
            <div className="provider-login-actions">
              <button type="button" className="settings-btn" onClick={() => copy(prompt.userCode, 'code')}>
                {copied === 'code' ? <Check size={14} /> : <Copy size={14} />}
                {copied === 'code' ? 'Copied' : 'Copy code'}
              </button>
              <button type="button" className="settings-btn" onClick={() => void window.mousse.providers.openLoginUrl(prompt.verificationUri)}>
                <ExternalLink size={14} />
                Open page again
              </button>
            </div>
          </div>
        )}

        {prompt?.type === 'input' && (
          <>
            <label className="provider-login-label" htmlFor="provider-signin-input">
              {prompt.message}
            </label>
            <input
              id="provider-signin-input"
              className="provider-login-input"
              type={prompt.secret ? 'password' : 'text'}
              placeholder={prompt.placeholder}
              value={value}
              autoFocus
              onChange={(change) => setValue(change.target.value)}
              onKeyDown={(key) => {
                if (key.key === 'Enter') respond({ promptId: prompt.promptId, kind: 'input', value })
              }}
            />
            <button type="button" className="settings-btn" onClick={() => respond({ promptId: prompt.promptId, kind: 'input', value })}>
              Continue
            </button>
          </>
        )}

        {prompt?.type === 'select' && (
          <>
            <p className="provider-login-message">{prompt.message}</p>
            <div className="provider-login-options">
              {prompt.options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className="provider-login-option"
                  onClick={() => respond({ promptId: prompt.promptId, kind: 'select', value: option.id })}
                >
                  <span>{option.label}</span>
                  {option.description && <small>{option.description}</small>}
                </button>
              ))}
            </div>
          </>
        )}

        {failure && <p className="prov-error">{failure}</p>}
      </div>
    </Modal>
  )
}
