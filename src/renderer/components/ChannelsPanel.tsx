import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Copy,
  Hash,
  Inbox,
  Loader2,
  MessageSquare,
  Plug,
  PlugZap,
  RefreshCw,
  Save,
  Send,
  Webhook,
  X
} from 'lucide-react'
import type {
  ChannelActivityEvent,
  ChannelConfig,
  ChannelConnectionState,
  ChannelPlatform,
  ChannelsSnapshot,
  PairingRequest
} from '../../shared/types'
import '../styles/channels-panel.css'

const PLATFORMS: ChannelPlatform[] = ['telegram', 'discord', 'webhook']

const PLATFORM_META: Record<
  ChannelPlatform,
  { label: string; detail: string; icon: typeof MessageSquare; accent: string }
> = {
  telegram: {
    label: 'Telegram',
    detail: 'Bot API',
    icon: Send,
    accent: '#2aabee'
  },
  discord: {
    label: 'Discord',
    detail: 'Bot',
    icon: Hash,
    accent: '#5865f2'
  },
  webhook: {
    label: 'Webhook',
    detail: 'Local HTTP',
    icon: Webhook,
    accent: '#a785c7'
  }
}

function stateLabel(state: ChannelConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected'
    case 'connecting':
      return 'Connecting'
    case 'error':
      return 'Error'
    default:
      return 'Off'
  }
}

function stateClass(state: ChannelConnectionState): string {
  if (state === 'connected') return 'connected'
  if (state === 'connecting') return 'connecting'
  if (state === 'error') return 'error'
  return 'disconnected'
}

function Section({
  title,
  meta,
  children,
  defaultOpen = true
}: {
  title: string
  meta?: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="channels-group">
      <button type="button" className="channels-group-head" onClick={() => setOpen((v) => !v)}>
        <span className="channels-group-title">{title}</span>
        {meta ? <span className="channels-group-meta">{meta}</span> : null}
        <span className={`channels-chevron${open ? ' open' : ''}`}>
          <ChevronDown size={14} />
        </span>
      </button>
      {open ? <div className="channels-group-body">{children}</div> : null}
    </section>
  )
}

export function ChannelsPanel() {
  const [snapshot, setSnapshot] = useState<ChannelsSnapshot | null>(null)
  const [draft, setDraft] = useState<ChannelConfig | null>(null)
  const [pairing, setPairing] = useState<PairingRequest[]>([])
  const [activity, setActivity] = useState<ChannelActivityEvent[]>([])
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    null
  )
  const [testPlatform, setTestPlatform] = useState<ChannelPlatform>('telegram')
  const [testChatId, setTestChatId] = useState('')
  const [testText, setTestText] = useState('Hello from Mousse')

  const toastTimerRef = useRef(0)
  const [toastCopied, setToastCopied] = useState(false)
  const showMessage = (kind: 'ok' | 'error', text: string) => {
    setActionMessage({ kind, text })
    setToastCopied(false)
    window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setActionMessage(null), 4000)
  }

  const copyToast = async () => {
    if (!actionMessage) return
    try {
      await navigator.clipboard.writeText(actionMessage.text)
      setToastCopied(true)
      window.setTimeout(() => setToastCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  // True while the user has unsaved edits. Snapshot/refresh events must not
  // clobber an in-progress form; the draft only resyncs after an explicit save.
  const draftDirtyRef = useRef(false)
  const editDraft = (next: ChannelConfig) => {
    draftDirtyRef.current = true
    setDraft(next)
  }

  const refresh = useCallback(async () => {
    try {
      const [nextSnapshot, nextPairing, nextActivity] = await Promise.all([
        window.mousse.channels.getSnapshot(),
        window.mousse.channels.listPairingRequests(),
        window.mousse.channels.getActivity(30)
      ])
      setSnapshot(nextSnapshot)
      if (!draftDirtyRef.current) setDraft(nextSnapshot.config)
      setPairing(nextPairing)
      setActivity(nextActivity)
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Load failed')
    }
  }, [])

  useEffect(() => {
    void refresh()
    const offUpdated = window.mousse.channels.onUpdated((next) => {
      setSnapshot(next)
      if (!draftDirtyRef.current) setDraft(next.config)
    })
    const offActivity = window.mousse.channels.onActivity((event) => {
      setActivity((prev) => [...prev.slice(-29), event])
    })
    return () => {
      offUpdated()
      offActivity()
    }
  }, [refresh])

  const statuses = useMemo(() => {
    const map = new Map(snapshot?.statuses.map((s) => [s.platform, s]))
    return PLATFORMS.map((platform) => map.get(platform) ?? { platform, state: 'disconnected' as const })
  }, [snapshot])

  const connectedCount = statuses.filter((s) => s.state === 'connected').length
  const enabledCount = PLATFORMS.filter((p) => draft?.platforms[p].enabled).length

  const saveConfig = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await window.mousse.channels.updateConfig(draft)
      draftDirtyRef.current = false
      await refresh()
      showMessage('ok', 'Saved')
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Save failed')
    } finally {
      setBusy(false)
    }
  }

  const connectAll = async () => {
    if (!draft) {
      showMessage('error', 'Still loading')
      return
    }
    setBusy(true)
    try {
      // Connect always uses persisted configuration. Save the current draft first
      // so edits made immediately before clicking Connect cannot be ignored.
      await window.mousse.channels.updateConfig(draft)
      await window.mousse.channels.connect()
      draftDirtyRef.current = false
      await refresh()
      showMessage('ok', 'Connecting')
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Connect failed')
    } finally {
      setBusy(false)
    }
  }

  const disconnectAll = async () => {
    setBusy(true)
    try {
      await window.mousse.channels.disconnect()
      await refresh()
      showMessage('ok', 'Disconnected')
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Disconnect failed')
    } finally {
      setBusy(false)
    }
  }

  const connectPlatform = async (platform: ChannelPlatform) => {
    if (!draft) {
      showMessage('error', 'Still loading')
      return
    }
    setBusy(true)
    try {
      // Persist the draft before connecting; the daemon reads its saved config.
      await window.mousse.channels.updateConfig(draft)
      await window.mousse.channels.connect(platform)
      draftDirtyRef.current = false
      await refresh()
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Connect failed')
    } finally {
      setBusy(false)
    }
  }

  const disconnectPlatform = async (platform: ChannelPlatform) => {
    setBusy(true)
    try {
      await window.mousse.channels.disconnect(platform)
      await refresh()
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Disconnect failed')
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async () => {
    if (!testChatId.trim()) return
    setBusy(true)
    try {
      const result = await window.mousse.channels.sendTest(
        testPlatform,
        testChatId.trim(),
        testText
      )
      if (result.success) {
        showMessage('ok', 'Sent')
      } else {
        showMessage('error', result.error ?? 'Send failed')
      }
      await refresh()
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }

  const updatePlatform = (
    platform: ChannelPlatform,
    patch: Partial<ChannelConfig['platforms'][ChannelPlatform]>
  ) => {
    if (!draft) return
    editDraft({
      ...draft,
      platforms: {
        ...draft.platforms,
        [platform]: { ...draft.platforms[platform], ...patch }
      }
    })
  }

  if (!draft) {
    return (
      <div className="channels-loading">
        {loadError ? (
          <>
            <p className="channels-empty">{loadError}</p>
            <button type="button" className="channels-btn" onClick={() => void refresh()}>
              <RefreshCw size={14} />
              Retry
            </button>
          </>
        ) : (
          <>
            <Loader2 size={24} className="channels-spinner" />
            <p>Loading</p>
          </>
        )}
</div>
    )
  }

  return (
    <div className="channels-panel">
      <div className="channels-toolbar">
        <div className="channels-stats">
          <span className="channels-stat">
            <span className={`channels-dot${connectedCount > 0 ? ' on' : ''}`} />
            {connectedCount} connected
          </span>
          <span className="channels-stat-sep" />
          <span className="channels-stat">{enabledCount} enabled</span>
          <span className="channels-stat-sep" />
          <span className="channels-stat">{snapshot?.sessions.length ?? 0} sessions</span>
        </div>
        <div className="channels-toolbar-actions">
          <button
            type="button"
            className="channels-icon-btn"
            onClick={() => void refresh()}
            disabled={busy}
            title="Refresh"
          >
            <RefreshCw size={15} strokeWidth={2} className={busy ? 'channels-spin' : undefined} />
          </button>
          <button type="button" className="channels-btn ghost" onClick={() => void disconnectAll()} disabled={busy}>
            <Plug size={14} strokeWidth={2} />
            Disconnect
          </button>
          <button type="button" className="channels-btn secondary" onClick={() => void connectAll()} disabled={busy}>
            <PlugZap size={14} strokeWidth={2} />
            Connect
          </button>
          <button
            type="button"
            className="channels-btn primary"
            onClick={() => void saveConfig()}
            disabled={busy}
          >
            <Save size={14} strokeWidth={2} />
            Save
          </button>
        </div>
      </div>

      <div className="channels-scroll">
        <div className="channels-platforms">
          {statuses.map((status) => {
            const meta = PLATFORM_META[status.platform]
            const Icon = meta.icon
            const enabled = draft.platforms[status.platform].enabled
            return (
              <div
                key={status.platform}
                className={`channels-platform${enabled ? '' : ' is-disabled'} is-${stateClass(status.state)}`}
                style={{ '--platform-accent': meta.accent } as React.CSSProperties}
              >
                <div className="channels-platform-glow" />
                <div className="channels-platform-top">
                  <span className="channels-platform-icon">
                    <Icon size={17} strokeWidth={2.2} />
                  </span>
                  <div className="channels-platform-meta">
                    <h3>{meta.label}</h3>
                    <p>{meta.detail}</p>
                  </div>
                </div>
                <div className="channels-platform-foot">
                  <span className="channels-status-line">
                    <span className={`channels-live-dot ${stateClass(status.state)}`} />
                    {enabled ? stateLabel(status.state) : 'Off'}
                  </span>
                  {status.state === 'connected' ? (
                    <button
                      type="button"
                      className="channels-btn ghost sm"
                      disabled={busy}
                      onClick={() => void disconnectPlatform(status.platform)}
                    >
                      Disconnect
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="channels-btn secondary sm"
                      disabled={busy || !enabled}
                      onClick={() => void connectPlatform(status.platform)}
                    >
                      <PlugZap size={12} />
                      Connect
                    </button>
                  )}
                </div>
                {status.error ? <p className="channels-platform-error">{status.error}</p> : null}
              </div>
            )
          })}
        </div>

        <Section title="General">
          <div className="channels-form">
            <label className="channels-row">
              <span className="channels-row-text">
                <span className="channels-row-label">Silence filter</span>
                <span className="channels-row-hint">Strip narration</span>
              </span>
              <span className={`channels-switch${draft.filterSilenceNarration ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={draft.filterSilenceNarration}
                  onChange={(e) =>
                    editDraft({ ...draft, filterSilenceNarration: e.target.checked })
                  }
                />
                <span className="channels-switch-knob" />
              </span>
            </label>
            <div className="channels-field">
              <span className="channels-label">Unknown DMs</span>
              <div className="channels-segmented">
                {(
                  [
                    { value: 'pair', label: 'Pairing' },
                    { value: 'ignore', label: 'Ignore' }
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className={`channels-segment${draft.unauthorizedDmBehavior === opt.value ? ' active' : ''}`}
                    onClick={() =>
                      editDraft({ ...draft, unauthorizedDmBehavior: opt.value })
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Section>

        {PLATFORMS.map((platform) => {
          const meta = PLATFORM_META[platform]
          const cfg = draft.platforms[platform]
          const status = statuses.find((s) => s.platform === platform)
          const state = status ? stateLabel(status.state) : null
          return (
            <Section
              key={platform}
              title={meta.label}
              meta={cfg.enabled && state ? state.toLowerCase() : cfg.enabled ? 'enabled' : 'off'}
              defaultOpen={cfg.enabled}
            >
              <div className="channels-form">
                <label className="channels-row">
                  <span className="channels-row-text">
                    <span className="channels-row-label">Enabled</span>
                  </span>
                  <span className={`channels-switch${cfg.enabled ? ' on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={cfg.enabled}
                      onChange={(e) => updatePlatform(platform, { enabled: e.target.checked })}
                    />
                    <span className="channels-switch-knob" />
                  </span>
                </label>
                {platform !== 'webhook' ? (
                  <div className="channels-field">
                    <span className="channels-label">Bot token</span>
                    <input
                      className="channels-input mono"
                      type="password"
                      value={draft.platforms[platform].token ?? ''}
                      placeholder="Token"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => updatePlatform(platform, { token: e.target.value })}
                    />
                  </div>
                ) : (
                  <div className="channels-field-row">
                    <div className="channels-field">
                      <span className="channels-label">Port</span>
                      <input
                        className="channels-input mono"
                        type="number"
                        value={draft.platforms.webhook.webhookPort ?? 18789}
                        onChange={(e) =>
                          updatePlatform('webhook', { webhookPort: Number(e.target.value) || 18789 })
                        }
                      />
                    </div>
                    <div className="channels-field">
                      <span className="channels-label">Secret</span>
                      <input
                        className="channels-input mono"
                        type="password"
                        value={draft.platforms.webhook.webhookSecret ?? ''}
                        placeholder="Optional"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => updatePlatform('webhook', { webhookSecret: e.target.value })}
                      />
                    </div>
                  </div>
                )}
                {platform === 'webhook' ? (
                  <p className="channels-hint">
                    POST{' '}
                    <code>
                      http://127.0.0.1:{draft.platforms.webhook.webhookPort ?? 18789}/channels/webhook
                    </code>
                  </p>
                ) : null}
                <div className="channels-field">
                  <span className="channels-label">Allowed IDs</span>
                  <textarea
                    className="channels-input mono"
                    value={(cfg.allowedUserIds ?? []).join(', ')}
                    placeholder="123456789, 987654321"
                    rows={2}
                    spellCheck={false}
                    onChange={(e) =>
                      updatePlatform(platform, {
                        allowedUserIds: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                      })
                    }
                  />
                </div>
                <div className="channels-field-row split">
                  <label className="channels-check">
                    <input
                      type="checkbox"
                      checked={cfg.allowAllUsers ?? false}
                      onChange={(e) => updatePlatform(platform, { allowAllUsers: e.target.checked })}
                    />
                    <span>Allow all</span>
                  </label>
                  {platform !== 'webhook' ? (
                    <div className="channels-field grow">
                      <span className="channels-label">Home chat</span>
                      <input
                        className="channels-input mono"
                        value={draft.platforms[platform].homeChatId ?? ''}
                        placeholder="Default outbound chat"
                        spellCheck={false}
                        onChange={(e) => updatePlatform(platform, { homeChatId: e.target.value })}
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </Section>
          )
        })}

        <Section title="Test message" defaultOpen={false}>
          <div className="channels-form">
            <div className="channels-segmented">
              {(Object.keys(PLATFORM_META) as ChannelPlatform[])
                .filter((p) => p !== 'webhook')
                .map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`channels-segment${testPlatform === p ? ' active' : ''}`}
                    onClick={() => setTestPlatform(p)}
                  >
                    {PLATFORM_META[p].label}
                  </button>
                ))}
            </div>
            <div className="channels-field-row">
              <div className="channels-field">
                <span className="channels-label">Chat ID</span>
                <input
                  className="channels-input mono"
                  value={testChatId}
                  onChange={(e) => setTestChatId(e.target.value)}
                  placeholder="Chat or channel ID"
                  spellCheck={false}
                />
              </div>
              <div className="channels-field grow">
                <span className="channels-label">Message</span>
                <input
                  className="channels-input"
                  value={testText}
                  onChange={(e) => setTestText(e.target.value)}
                  placeholder="Hello from Mousse"
                />
              </div>
            </div>
          </div>
          <div className="channels-foot-actions">
            <button
              type="button"
              className="channels-btn primary"
              disabled={busy || !testChatId.trim() || !testText.trim()}
              onClick={() => void sendTest()}
            >
              <Send size={14} strokeWidth={2} />
              Send
            </button>
          </div>
        </Section>

        <Section
          title="Pairing"
          meta={pairing.length > 0 ? `${pairing.length} pending` : undefined}
          defaultOpen={pairing.length > 0}
        >
          {pairing.length === 0 ? (
            <div className="channels-empty-state">
              <Inbox size={16} />
              <p>No pending requests.</p>
            </div>
          ) : (
            <ul className="channels-list">
              {pairing.map((entry) => (
                <li key={`${entry.platform}-${entry.code}`} className="channels-list-item">
                  <code className="channels-code">{entry.code}</code>
                  <div className="channels-list-meta">
                    <span className="channels-list-title">{entry.userName ?? entry.userId}</span>
                    <span className="channels-list-hint">
                      {PLATFORM_META[entry.platform]?.label ?? entry.platform} · expires{' '}
                      {new Date(entry.expiresAt).toLocaleString()}
                    </span>
                  </div>
                  <div className="channels-list-actions">
                    <button
                      type="button"
                      className="channels-icon-btn success"
                      title="Approve"
                      onClick={() => void window.mousse.channels.approvePairing(entry.code).then(refresh)}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      type="button"
                      className="channels-icon-btn danger"
                      title="Reject"
                      onClick={() => void window.mousse.channels.rejectPairing(entry.code).then(refresh)}
                    >
                      <X size={15} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Sessions"
          meta={snapshot?.sessions.length ? `${Math.min(snapshot.sessions.length, 20)}` : undefined}
          defaultOpen={false}
        >
          {(snapshot?.sessions.length ?? 0) === 0 ? (
            <div className="channels-empty-state">
              <MessageSquare size={16} />
              <p>No sessions yet.</p>
            </div>
          ) : (
            <ul className="channels-list">
              {snapshot!.sessions.slice(0, 20).map((session) => (
                <li key={session.sessionKey} className="channels-list-item">
                  <span
                    className="channels-mini-dot"
                    style={{ background: PLATFORM_META[session.platform]?.accent } as React.CSSProperties}
                  />
                  <div className="channels-list-meta">
                    <span className="channels-list-title">{session.chatName ?? session.chatId}</span>
                    <span className="channels-list-hint">
                      {PLATFORM_META[session.platform]?.label ?? session.platform} ·{' '}
                      {session.lastMessageAt ? new Date(session.lastMessageAt).toLocaleString() : 'no messages'} ·{' '}
                      <span className="channels-mono">{session.mousseThreadId.slice(0, 8)}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section
          title="Activity"
          meta={activity.length > 0 ? `${activity.length}` : undefined}
          defaultOpen={activity.length > 0}
        >
          {activity.length === 0 ? (
            <div className="channels-empty-state">
              <p>No activity yet.</p>
            </div>
          ) : (
            <ul className="channels-feed">
              {activity
                .slice()
                .reverse()
                .map((event) => (
                  <li key={event.id} className={`channels-feed-item ${event.direction}`}>
                    <span className="channels-feed-icon" title={event.direction}>
                      {event.direction === 'inbound' ? (
                        <ArrowDownLeft size={13} strokeWidth={2.2} />
                      ) : (
                        <ArrowUpRight size={13} strokeWidth={2.2} />
                      )}
                    </span>
                    <div className="channels-feed-body">
                      <div className="channels-feed-meta">
                        <span>{PLATFORM_META[event.platform]?.label ?? event.platform}</span>
                        <span>,</span>
                        <span>{new Date(event.timestamp).toLocaleTimeString()}</span>
                      </div>
                      <p>{event.text}</p>
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </Section>
      </div>
      {actionMessage ? (
        <div className="channels-toast-stack" role="status">
          <div className={`channels-toast channels-toast-${actionMessage.kind}`}>
            {actionMessage.kind === 'ok' ? <CircleCheck size={14} /> : <CircleAlert size={14} />}
            <span className="channels-toast-text">{actionMessage.text}</span>
            <button type="button" className="channels-toast-copy" title="Copy" onClick={() => void copyToast()}>
              {toastCopied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
