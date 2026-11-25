import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  isComputerUseRequestCall,
  parseComputerUseOutcome,
  type ComputerUseSetupRequestView,
  type ComputerUseStatus
} from '../../shared/computerUse'
import type { ChatMessage } from '../../shared/types'
import { isQualifiedId } from '../../shared/threadRef'
import { X } from '../lib/icons'
import { openSettingsSection } from '../lib/settingsNavigation'
import '../styles/computerUse.css'

/**
 * The setup card an agent's `computer_use_request` opened in a thread (`src/shared/computerUse.ts`): above the composer,
 * never in the transcript, so it stays after the turn ends and a refused or old call never shows a button. Nothing waits
 * on it: what the person does here (install, enable, Not now) applies from the agent's next turn, to every agent of the
 * profile. A bot's card shows in its chat, whichever of its turns asked.
 *
 * A thread of another computer gets no card and sends nothing to this computer's Cua Driver or settings: when the last
 * finished `computer_use_request` there said setup was needed, a quiet line says where to set it up.
 */

interface Props {
  /** The thread on screen (a bot's chat thread in a bot's chat). */
  threadId: string | null | undefined
  /** The computer the thread runs on, when it is another one. */
  remoteNode?: string
  /** That computer's name, when known. */
  remoteHostName?: string
  /** The thread's transcript, read only for another computer's thread. */
  messages?: readonly ChatMessage[]
}

export function ComputerUseSetupCard({ threadId, remoteNode, remoteHostName, messages }: Props) {
  if (!threadId) return null
  if (isQualifiedId(threadId) || remoteNode) return <RemoteComputerUseLine messages={messages} hostName={remoteHostName} />
  return <LocalComputerUseCard threadId={threadId} />
}

/** What `computerUse.*` the card calls, through the window's platform transport (never routed to another computer). */
interface SetupClient {
  get(threadId: string): Promise<ComputerUseSetupRequestView | null>
  dismiss(threadId: string, requestId: string): Promise<void>
  status(refresh: boolean): Promise<ComputerUseStatus>
  install(): Promise<ComputerUseStatus>
  enable(): Promise<void>
}

function useSetupClient(): SetupClient | null {
  return useMemo(() => {
    const transport = window.mousse?.platformRequest
    if (!transport) return null
    return {
      get: async (threadId) => (await transport.request<{ request: ComputerUseSetupRequestView | null }>('computerUse.setupRequest.get', { threadId })).request ?? null,
      dismiss: async (threadId, requestId) => { await transport.request('computerUse.setupRequest.dismiss', { threadId, requestId }) },
      status: (refresh) => transport.request<ComputerUseStatus>('computerUse.status', refresh ? { refresh: true } : {}),
      install: () => transport.request<ComputerUseStatus>('computerUse.install', {}),
      enable: async () => { await window.mousse.settings.set({ agentAccess: { computerUse: true } }) }
    }
  }, [])
}

/** The thread's open card and the driver's state, read again whenever the service says the card changed. */
function useSetupRequest(threadId: string, client: SetupClient | null) {
  const [request, setRequest] = useState<ComputerUseSetupRequestView | null>(null)
  const [status, setStatus] = useState<ComputerUseStatus | null>(null)
  const [generation, setGeneration] = useState(0)
  const refresh = useCallback(() => setGeneration((value) => value + 1), [])

  useEffect(() => {
    if (!client) return
    let live = true
    void (async () => {
      try {
        const next = await client.get(threadId)
        if (!live) return
        setRequest(next)
        if (next) {
          const driver = await client.status(false)
          if (live) setStatus(driver)
        }
      } catch {
        if (live) setRequest(null)
      }
    })()
    return () => { live = false }
  }, [client, threadId, generation])

  useEffect(() => {
    const off = window.mousse?.orchestrator?.onComputerUseSetupRequestChanged?.((payload) => {
      if (payload.threadId === threadId) refresh()
    })
    return () => off?.()
  }, [threadId, refresh])

  return { request, status, setStatus, setRequest, refresh }
}

type CardView =
  | { kind: 'checking' }
  | { kind: 'enable' }
  | { kind: 'install'; enable: boolean }
  | { kind: 'installing' }
  | { kind: 'chosen'; text: string }
  | { kind: 'error'; text: string; reinstall: boolean }
  | { kind: 'manual' }
  | { kind: 'ready' }

/** What the card offers, from the driver's state and an error this card is still showing. */
export function setupCardView(status: ComputerUseStatus | null, actionError: string | undefined): CardView {
  if (!status) return { kind: 'checking' }
  if (status.state === 'installing') return { kind: 'installing' }
  if (status.source === 'chosen' && (status.state === 'missing' || status.state === 'broken'))
    return { kind: 'chosen', text: status.state === 'missing' ? 'The driver chosen in Settings → Computer use is not there.' : "The driver chosen in Settings → Computer use didn't start." }
  const error = actionError ?? status.error
  if (status.state === 'broken' || error)
    return { kind: 'error', text: error ?? "Cua Driver didn't start.", reinstall: status.installable }
  if (status.state === 'found') return status.enabled ? { kind: 'ready' } : { kind: 'enable' }
  if (!status.installable) return { kind: 'manual' }
  return { kind: 'install', enable: !status.enabled }
}

function LocalComputerUseCard({ threadId }: { threadId: string }) {
  const client = useSetupClient()
  const { request, status, setStatus, setRequest } = useSetupRequest(threadId, client)
  const [busy, setBusy] = useState(false)
  // An installer's failure stays on the card through the service's refreshes, until the next action or a success.
  const [actionError, setActionError] = useState<string | undefined>()
  const [done, setDone] = useState(false)

  useEffect(() => {
    setActionError(undefined)
    setDone(false)
  }, [threadId])

  if (!client) return null
  if (done) {
    return (
      <div className="cu-setup-card is-line" role="status">
        <span className="cu-setup-text">Computer use is enabled. The agent can use it from its next turn.</span>
        <button type="button" className="settings-icon-btn cu-setup-close" aria-label="Close" title="Close" onClick={() => setDone(false)}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
    )
  }
  if (!request) return null
  const view = setupCardView(status, actionError)
  if (view.kind === 'ready') return null

  const act = async (work: () => Promise<void>) => {
    setBusy(true)
    setActionError(undefined)
    try {
      await work()
    } catch (error) {
      setActionError(error instanceof Error && error.message ? error.message : 'That did not work. Try again in Settings → Computer use.')
    } finally {
      setBusy(false)
    }
  }
  // Turned on only once the driver runs; then the driver is looked at again before the card says it is enabled.
  const enableAndCheck = async () => {
    await client.enable()
    const checked = await client.status(true)
    setStatus(checked)
    if (checked.enabled && checked.state === 'found' && !checked.error) setDone(true)
  }
  const install = () => act(async () => {
    setStatus((current) => (current ? { ...current, state: 'installing', error: undefined } : current))
    const result = await client.install()
    setStatus(result)
    if (result.state !== 'found' || result.error) {
      setActionError(result.error ?? (result.state === 'broken' ? "Cua Driver was installed but didn't start." : "The installer finished, but Cua Driver wasn't found."))
      return
    }
    if (!result.enabled) await enableAndCheck()
    else {
      const checked = await client.status(true)
      setStatus(checked)
      if (checked.enabled && checked.state === 'found' && !checked.error) setDone(true)
    }
  })
  const enable = () => act(enableAndCheck)
  const dismiss = () => act(async () => {
    await client.dismiss(request.threadId, request.requestId)
    setRequest(null)
  })
  const settings = () => openSettingsSection('computer')

  const line = view.kind === 'enable' ? 'Computer use is off on this computer.'
    : view.kind === 'install' ? 'Cua Driver is not installed on this computer.'
      : view.kind === 'installing' ? 'Installing Cua Driver…'
        : view.kind === 'chosen' || view.kind === 'error' ? view.text
          : view.kind === 'manual' ? 'Cua Driver has no one-click install here. Set it up in Settings → Computer use.'
            : 'Checking Cua Driver…'

  return (
    <div className="cu-setup-card" role="group" aria-label="Set up computer use">
      <p className="cu-setup-title">The agent asks to use apps on this computer</p>
      {request.reason && <p className="cu-setup-reason">{request.reason}</p>}
      <p className={`cu-setup-line${view.kind === 'error' || view.kind === 'chosen' ? ' is-error' : ''}`} {...(view.kind === 'error' ? { role: 'alert' } : {})}>
        {line} <span className="cu-quiet">Applies to all agents in this profile.</span>
      </p>
      <div className="cu-setup-actions">
        <button type="button" className="composer-question-btn is-quiet" disabled={busy} onClick={() => void dismiss()}>Not now</button>
        {view.kind === 'enable' && <button type="button" className="composer-question-btn is-primary" disabled={busy} onClick={() => void enable()}>Enable</button>}
        {view.kind === 'install' && <button type="button" className="composer-question-btn is-primary" disabled={busy} onClick={() => void install()}>{view.enable ? 'Install & enable' : 'Install'}</button>}
        {view.kind === 'installing' && <button type="button" className="composer-question-btn" disabled>Installing Cua Driver…</button>}
        {view.kind === 'error' && view.reinstall && <button type="button" className="composer-question-btn" disabled={busy} onClick={() => void install()}>Reinstall</button>}
        {(view.kind === 'chosen' || view.kind === 'manual' || (view.kind === 'error' && !view.reinstall)) && <button type="button" className="composer-question-btn" onClick={settings}>Open Settings</button>}
      </div>
    </div>
  )
}

/**
 * The host a past request on another computer named, when the latest finished `computer_use_request` of the transcript
 * said setup was needed there; undefined otherwise (it said ready or declined, it failed, or there is none).
 */
export function pastSetupRequest(messages: readonly ChatMessage[] | undefined): { hostName?: string } | undefined {
  if (!messages) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    const activity = message.activity
    const name = activity?.toolName ?? message.toolCall?.toolName
    const input = (activity && 'input' in activity ? activity.input : undefined) ?? message.toolCall?.input
    if (!isComputerUseRequestCall(name, input)) continue
    if (activity?.status !== 'done') continue
    const outcome = parseComputerUseOutcome('output' in activity ? (activity as { output?: string }).output : undefined)
    return outcome?.outcome === 'setup_needed' ? { ...(outcome.hostName ? { hostName: outcome.hostName } : {}) } : undefined
  }
  return undefined
}

function RemoteComputerUseLine({ messages, hostName }: { messages?: readonly ChatMessage[]; hostName?: string }) {
  const past = pastSetupRequest(messages)
  if (!past) return null
  const host = hostName?.trim() || past.hostName || 'that computer'
  return (
    <div className="cu-setup-card is-line" role="status">
      <span className="cu-setup-text">The agent asked to set up computer use on {host}. Open Mousse on {host} → Settings → Computer use to enable or install Cua Driver.</span>
    </div>
  )
}
