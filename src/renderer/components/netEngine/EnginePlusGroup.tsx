import { useEffect, useState } from 'react'
import { AlertTriangle, Cloud } from '../../lib/icons'
import type { NetEngineStatus } from '../../../shared/netEngine/local'
import type { PlatformRequestMethod } from '../../../shared/platform'
import { errorText } from '../devices/useDaemonCall'
import { RowMenu } from '../integrations/RowMenu'
import { SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { linkResultText, planLine, plusNotices, poolLine, relayClassLine } from './plusRows'

/**
 * Mousse Plus under Settings → Devices (Phase 4, M16 and M17): sign-in with a code typed on the Plus website,
 * the plan and what is left, the paid relay per class, and status lines for a spent balance, paused copies and
 * an outage. Nothing here prompts; copies over the paid relay pause and resume on their own.
 */
export function EnginePlusGroup({ status, read }: { status: NetEngineStatus; read: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const plus = status.plus
  // The code stops working at its expiry: the row turns back to Sign in then, without waiting for the helper.
  const expiresAt = plus?.link?.expiresAt ? plus.link.expiresAt * 1000 : undefined
  const [, setTick] = useState(0)
  useEffect(() => {
    if (expiresAt === undefined || expiresAt <= Date.now()) return
    const timer = setTimeout(
      () => setTick((n) => n + 1),
      Math.min(expiresAt - Date.now() + 50, 2 ** 31 - 1)
    )
    return () => clearTimeout(timer)
  }, [expiresAt])
  if (!status.on || !plus?.configured) return null
  const expired = expiresAt !== undefined && expiresAt <= Date.now()
  const link = expired ? undefined : plus.link

  const call = async <T,>(method: PlatformRequestMethod): Promise<T | undefined> => {
    setBusy(true)
    setError('')
    try {
      return await window.mousse.platformRequest.request<T>(method, {})
    } catch (cause) {
      setError(errorText(cause))
      return undefined
    } finally {
      setBusy(false)
      read()
    }
  }
  const open = (url: string) => void window.mousse.providers?.openLoginUrl?.(url)
  const signIn = async () => {
    const link = await call<{ verifyUrl: string }>('netEngine.plus.signIn')
    if (link?.verifyUrl) open(link.verifyUrl)
  }

  const relay = plus.relay
  const relayParts = [
    relayClassLine(relay?.interactive) && `Typing: ${relayClassLine(relay?.interactive)}`,
    relayClassLine(relay?.bulk) && `Copies: ${relayClassLine(relay?.bulk)}`
  ].filter(Boolean)
  const notices = plus.linked ? plusNotices(plus) : []

  return (
    <SettingsGroup
      anchor="devices-plus"
      title="Mousse Plus"
      icon={Cloud}
      className="devices-group engine-group"
    >
      {link ? (
        <SettingsRow
          title="Sign in to Plus"
          description={
            <span className="engine-plus-link">
              Type <code className="engine-plus-code">{link.userCode}</code> on the Plus
              website
            </span>
          }
          control={
            <span className="engine-group-actions">
              <button
                type="button"
                className="settings-btn primary"
                onClick={() => open(link.verifyUrl)}
              >
                Open website
              </button>
              <button
                type="button"
                className="settings-btn"
                disabled={busy}
                onClick={() => void call('netEngine.plus.cancel')}
              >
                Cancel
              </button>
            </span>
          }
        />
      ) : !plus.linked ? (
        <SettingsRow
          title="Mousse Plus"
          description={linkResultText(expired ? 'expired' : plus.linkResult) ?? 'Not signed in'}
          control={
            <button
              type="button"
              className="settings-btn"
              disabled={busy}
              onClick={() => void signIn()}
            >
              Sign in
            </button>
          }
        />
      ) : (
        <>
          <SettingsRow
            title={planLine(plus)}
            description={
              [
                poolLine(plus.interactive) && `Typing: ${poolLine(plus.interactive)}`,
                poolLine(plus.bulk) && `Copies: ${poolLine(plus.bulk)}`
              ]
                .filter(Boolean)
                .join(' · ') || undefined
            }
            control={
              <RowMenu
                label="Plus actions"
                disabled={busy}
                items={[
                  {
                    label: 'Refresh',
                    action: 'plus-refresh',
                    onSelect: () => void call('netEngine.plus.refresh')
                  },
                  {
                    label: 'Sign out',
                    danger: true,
                    action: 'plus-sign-out',
                    onSelect: () => void call('netEngine.plus.signOut')
                  }
                ]}
              />
            }
          />
          {relayParts.length > 0 && (
            <SettingsRow
              title="Paid relay"
              description={<span data-plus-relay="">{relayParts.join(' · ')}</span>}
            />
          )}
        </>
      )}
      {notices.map((notice) => (
        <p
          key={notice.line}
          className="settings-muted devices-note settings-status-warn"
          role="status"
          title={notice.detail}
        >
          <AlertTriangle size={12} aria-hidden="true" /> {notice.line}
        </p>
      ))}
      {error && (
        <p role="alert" className="chat-error devices-error">
          {error}
        </p>
      )}
    </SettingsGroup>
  )
}
