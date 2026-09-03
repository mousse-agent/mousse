import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Hash,
  Loader2,
  MessageSquare,
  Plug,
  PlugZap,
  RefreshCw,
  Save,
  Send,
  Shield,
  Users,
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
  { label: string; description: string; icon: typeof MessageSquare; accent: string }
> = {
  telegram: {
    label: 'Telegram',
    description: 'Bot API for DMs and groups',
    icon: MessageSquare,
    accent: '#26a5e4'
  },
  discord: {
    label: 'Discord',
    description: 'Bot for servers and DMs',
    icon: Hash,
    accent: '#5865f2'
  },
  webhook: {
    label: 'Webhook',
    description: 'Local HTTP endpoint for integrations',
    icon: Webhook,
    accent: 'var(--accent)'
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
      return 'Disconnected'
  }
}

function stateClass(state: ChannelConnectionState): string {
  if (state === 'connected') return 'connected'
  if (state === 'connecting') return 'connecting'
  if (state === 'error') return 'error'
  return 'disconnected'
}

function SectionCard({
  icon,
  title,
  description,
  children,
  defaultOpen = true
}: {
  icon: ReactNode
  title: string
  description?: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)

  return (
    <section className="channels-section-card">
      <button type="button" className="channels-section-header" onClick={() => setOpen((v) => !v)}>
        <span className="channels-section-icon">{icon}</span>
        <span className="channels-section-heading">
          <span className="channels-section-title">{title}</span>
          {description ? <span className="channels-section-desc">{description}</span> : null}
        </span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open ? <div className="channels-section-body">{children}</div> : null}
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

  const showMessage = (kind: 'ok' | 'error', text: string) => {
    setActionMessage({ kind, text })
    window.setTimeout(() => setActionMessage(null), 4000)
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
      setLoadError(err instanceof Error ? err.message : 'Failed to load channels')
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
      showMessage('ok', 'Configuration saved')
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to save config')
    } finally {
      setBusy(false)
    }
  }

  const connectAll = async () => {
    if (!draft) {
      showMessage('error', 'Channel configuration is still loading')
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
      showMessage('ok', 'Connecting enabled platforms')
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
      showMessage('ok', 'All platforms disconnected')
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Disconnect failed')
    } finally {
      setBusy(false)
    }
  }

  const connectPlatform = async (platform: ChannelPlatform) => {
    if (!draft) {
      showMessage('error', 'Channel configuration is still loading')
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
      showMessage('error', err instanceof Error ? err.message : `Failed to connect ${platform}`)
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
      showMessage('error', err instanceof Error ? err.message : `Failed to disconnect ${platform}`)
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
        showMessage('ok', `Test message sent via ${PLATFORM_META[testPlatform].label}`)
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
            <p>Loading channels…</p>
          </>
        )}
</div>
    )
  }

  return (
    <div className="channels-panel">
      <div className="channels-panel-header">
        <p className="channels-panel-subtitle">
          {connectedCount} connected · {enabledCount} enabled · {snapshot?.sessions.length ?? 0} sessions
        </p>
        <div className="channels-panel-header-actions">
          {actionMessage ? (
            <span className={`channels-toast channels-toast-${actionMessage.kind}`}>
              {actionMessage.text}
            </span>
          ) : null}
          <button
            type="button"
            className="channels-btn"
            onClick={() => void refresh()}
            disabled={busy}
            title="Refresh"
          >
            <RefreshCw size={14} strokeWidth={2} className={busy ? 'channels-spin' : undefined} />
          </button>
          <button
            type="button"
            className="channels-btn channels-btn-primary"
            onClick={() => void saveConfig()}
            disabled={busy}
          >
            <Save size={14} strokeWidth={2} />
            Save
          </button>
          <button type="button" className="channels-btn" onClick={() => void connectAll()} disabled={busy}>
            <PlugZap size={14} strokeWidth={2} />
            Connect
          </button>
          <button type="button" className="channels-btn" onClick={() => void disconnectAll()} disabled={busy}>
            <Plug size={14} strokeWidth={2} />
            Disconnect
          </button>
        </div>
      </div>

      <div className="channels-scroll">
        <div className="channels-status-row">
          {statuses.map((status) => {
            const meta = PLATFORM_META[status.platform]
            const Icon = meta.icon
            const enabled = draft.platforms[status.platform].enabled
            return (
              <div
                key={status.platform}
                className={`channels-status-card${enabled ? '' : ' channels-status-card-disabled'}`}
                style={{ '--platform-accent': meta.accent } as React.CSSProperties}
              >
                <div className="channels-status-card-top">
                  <span className="channels-status-icon">
                    <Icon size={18} strokeWidth={2} />
                  </span>
                  <div className="channels-status-info">
                    <h3>{meta.label}</h3>
                    <span className={`channels-status-badge ${stateClass(status.state)}`}>
                      {stateLabel(status.state)}
                    </span>
                  </div>
                </div>
                {status.error ? <p className="channels-status-error">{status.error}</p> : null}
                <div className="channels-status-actions">
                  {status.state === 'connected' ? (
                    <button
                      type="button"
                      className="channels-btn channels-btn-sm"
                      disabled={busy}
                      onClick={() => void disconnectPlatform(status.platform)}
                    >
                      <Plug size={12} />
                      Disconnect
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="channels-btn channels-btn-sm channels-btn-primary"
                      disabled={busy || !enabled}
                      onClick={() => void connectPlatform(status.platform)}
                    >
                      <PlugZap size={12} />
                      Connect
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        <SectionCard
          icon={<Shield size={16} strokeWidth={2} />}
          title="Global settings"
          description="Security and message filtering"
        >
          <div className="channels-form-grid">
            <label className="channels-checkbox-row">
              <input
                type="checkbox"
                checked={draft.filterSilenceNarration}
                onChange={(e) =>
                  editDraft({ ...draft, filterSilenceNarration: e.target.checked })
                }
              />
              Filter silence narration from outbound messages
            </label>
            <label>
              Unauthorized DM behavior
              <select
                value={draft.unauthorizedDmBehavior}
                onChange={(e) =>
                  editDraft({
                    ...draft,
                    unauthorizedDmBehavior: e.target.value as ChannelConfig['unauthorizedDmBehavior']
                  })
                }
              >
                <option value="pair">Require pairing</option>
                <option value="ignore">Ignore silently</option>
              </select>
            </label>
          </div>
        </SectionCard>

        {PLATFORMS.map((platform) => {
          const meta = PLATFORM_META[platform]
          const Icon = meta.icon
          return (
            <SectionCard
              key={platform}
              icon={<Icon size={16} strokeWidth={2} />}
              title={meta.label}
              description={meta.description}
              defaultOpen={draft.platforms[platform].enabled}
            >
              <div className="channels-platform-toolbar">
                <label className="channels-toggle">
                  <input
                    type="checkbox"
                    checked={draft.platforms[platform].enabled}
                    onChange={(e) => updatePlatform(platform, { enabled: e.target.checked })}
                  />
                  <span className="channels-toggle-track" />
                  <span>Enabled</span>
                </label>
              </div>
              <div className="channels-form-grid">
                {platform !== 'webhook' ? (
                  <label>
                    Bot token
                    <input
                      type="password"
                      value={draft.platforms[platform].token ?? ''}
                      placeholder="Paste bot token"
                      onChange={(e) => updatePlatform(platform, { token: e.target.value })}
                    />
                  </label>
                ) : (
                  <>
                    <label>
                      Webhook port (localhost)
                      <input
                        type="number"
                        value={draft.platforms.webhook.webhookPort ?? 18789}
                        onChange={(e) =>
                          updatePlatform('webhook', { webhookPort: Number(e.target.value) || 18789 })
                        }
                      />
                    </label>
                    <label>
                      Webhook secret (optional)
                      <input
                        type="password"
                        value={draft.platforms.webhook.webhookSecret ?? ''}
                        onChange={(e) => updatePlatform('webhook', { webhookSecret: e.target.value })}
                      />
                    </label>
                    <p className="channels-hint">
                      POST to <code>http://127.0.0.1:{draft.platforms.webhook.webhookPort ?? 18789}/channels/webhook</code>
                    </p>
                  </>
                )}
                <label>
                  Allowed user IDs (comma-separated)
                  <textarea
                    value={(draft.platforms[platform].allowedUserIds ?? []).join(', ')}
                    placeholder="123456789, 987654321"
                    onChange={(e) =>
                      updatePlatform(platform, {
                        allowedUserIds: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                      })
                    }
                  />
                </label>
                <label className="channels-checkbox-row">
                  <input
                    type="checkbox"
                    checked={draft.platforms[platform].allowAllUsers ?? false}
                    onChange={(e) => updatePlatform(platform, { allowAllUsers: e.target.checked })}
                  />
                  Allow all users (skip allowlist)
                </label>
                {platform !== 'webhook' ? (
                  <label>
                    Home chat ID (optional)
                    <input
                      value={draft.platforms[platform].homeChatId ?? ''}
                      placeholder="Default chat for outbound messages"
                      onChange={(e) => updatePlatform(platform, { homeChatId: e.target.value })}
                    />
                  </label>
                ) : null}
              </div>
            </SectionCard>
          )
        })}

        <SectionCard
          icon={<Send size={16} strokeWidth={2} />}
          title="Send test message"
          description="Verify bot connectivity"
          defaultOpen={false}
        >
          <div className="channels-form-grid">
            <label>
              Platform
              <select
                value={testPlatform}
                onChange={(e) => setTestPlatform(e.target.value as ChannelPlatform)}
              >
                <option value="telegram">Telegram</option>
                <option value="discord">Discord</option>
              </select>
            </label>
            <label>
              Chat ID
              <input
                value={testChatId}
                onChange={(e) => setTestChatId(e.target.value)}
                placeholder="Chat or channel ID"
              />
            </label>
            <label>
              Message
              <input value={testText} onChange={(e) => setTestText(e.target.value)} />
            </label>
          </div>
          <div className="channels-actions">
            <button
              type="button"
              className="channels-btn channels-btn-primary"
              disabled={busy || !testChatId.trim() || !testText.trim()}
              onClick={() => void sendTest()}
            >
              <Send size={14} strokeWidth={2} />
              Send via {PLATFORM_META[testPlatform].label}
            </button>
          </div>
        </SectionCard>

        <SectionCard
          icon={<Users size={16} strokeWidth={2} />}
          title="Pending pairing"
          description={`${pairing.length} request${pairing.length === 1 ? '' : 's'}`}
          defaultOpen={pairing.length > 0}
        >
          {pairing.length === 0 ? (
            <p className="channels-empty">No pending pairing requests.</p>
          ) : (
            <table className="channels-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Platform</th>
                  <th>User</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pairing.map((entry) => (
                  <tr key={`${entry.platform}-${entry.code}`}>
                    <td>
                      <code className="channels-code">{entry.code}</code>
                    </td>
                    <td>{PLATFORM_META[entry.platform]?.label ?? entry.platform}</td>
                    <td>{entry.userName ?? entry.userId}</td>
                    <td>{new Date(entry.expiresAt).toLocaleString()}</td>
                    <td className="channels-table-actions">
                      <button
                        type="button"
                        className="channels-btn channels-btn-sm channels-btn-success"
                        title="Approve"
                        onClick={() => void window.mousse.channels.approvePairing(entry.code).then(refresh)}
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        className="channels-btn channels-btn-sm channels-btn-danger"
                        title="Reject"
                        onClick={() => void window.mousse.channels.rejectPairing(entry.code).then(refresh)}
                      >
                        <X size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard
          icon={<MessageSquare size={16} strokeWidth={2} />}
          title="Recent sessions"
          description={`${snapshot?.sessions.length ?? 0} active`}
          defaultOpen={false}
        >
          {(snapshot?.sessions.length ?? 0) === 0 ? (
            <p className="channels-empty">No channel sessions yet. Messages from connected bots will appear here.</p>
          ) : (
            <table className="channels-table">
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Chat</th>
                  <th>Thread</th>
                  <th>Last message</th>
                </tr>
              </thead>
              <tbody>
                {snapshot!.sessions.slice(0, 20).map((session) => (
                  <tr key={session.sessionKey}>
                    <td>{PLATFORM_META[session.platform]?.label ?? session.platform}</td>
                    <td>{session.chatName ?? session.chatId}</td>
                    <td>
                      <code className="channels-code">{session.mousseThreadId.slice(0, 8)}…</code>
                    </td>
                    <td>{session.lastMessageAt ? new Date(session.lastMessageAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard
          icon={<Activity size={16} strokeWidth={2} />}
          title="Activity"
          description={`${activity.length} recent events`}
          defaultOpen={activity.length > 0}
        >
          {activity.length === 0 ? (
            <p className="channels-empty">No activity yet.</p>
          ) : (
            <ul className="channels-activity-list">
              {activity
                .slice()
                .reverse()
                .map((event) => (
                  <li key={event.id} className={`channels-activity-item channels-activity-${event.direction}`}>
                    <span className="channels-activity-direction" title={event.direction}>
                      {event.direction === 'inbound' ? (
                        <ArrowDownLeft size={14} strokeWidth={2} />
                      ) : (
                        <ArrowUpRight size={14} strokeWidth={2} />
                      )}
                    </span>
                    <div className="channels-activity-content">
                      <div className="channels-activity-meta">
                        {PLATFORM_META[event.platform]?.label ?? event.platform}
                        {' · '}
                        {new Date(event.timestamp).toLocaleString()}
                      </div>
                      {event.text}
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  )
}
