import { useCallback, useEffect, useRef, useState } from 'react'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { LocalConnectInput, LocalConnectResult, LocalServerRow } from '../../../shared/localServers'
import { piInstanceId } from '../../../shared/providerInstances'
import { Check } from '../../lib/icons'
import { useProvidersComputer } from '../../lib/providersComputer'
import { DelayedLoader } from '../ui/DelayedLoader'
import { SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { errorText } from './parts'

/**
 * Add provider → Local models: the model servers running on the computer the page shows, found when this step opens
 * (never at start or on a timer), one line and one action each, then a row for a server at an address of its own.
 * A key field appears only after a server answered 401; plain http to another machine asks once.
 */
export function LocalModelsStep({
  snapshots,
  disabled,
  onConnected
}: {
  snapshots: readonly InstanceSnapshot[]
  disabled: boolean
  /** Adds the entry of a connected server (`pi:<providerId>`) and finishes the dialog. */
  onConnected: (providerId: string) => Promise<void>
}) {
  const { api } = useProvidersComputer()
  const [rows, setRows] = useState<LocalServerRow[] | null>(null)
  const [detectError, setDetectError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const generation = useRef(0)

  const detect = useCallback(async () => {
    const run = ++generation.current
    setChecking(true)
    setDetectError(null)
    try {
      const found = await api.local.detect()
      if (run === generation.current) setRows(found)
    } catch (error) {
      if (run === generation.current) {
        setDetectError(errorText(error))
        setRows((current) => current ?? [])
      }
    } finally {
      if (run === generation.current) setChecking(false)
    }
  }, [api])
  useEffect(() => {
    void detect()
    return () => {
      generation.current++
    }
  }, [detect])

  const added = (providerId: string | undefined) => Boolean(providerId && snapshots.some((snapshot) => snapshot.instanceId === piInstanceId(providerId)))
  const connect = (input: LocalConnectInput) => api.local.connect(input)

  return (
    <SettingsGroup>
      {rows === null ? (
        <div className="prov-local-loading">
          <DelayedLoader size="small" label="Looking for local model servers" />
        </div>
      ) : (
        <>
          {detectError && <p className="prov-error">{detectError}</p>}
          {rows.length === 0 && !detectError && <p className="settings-muted prov-local-empty">No model server is running on this computer.</p>}
          {rows.map((row) => (
            <DetectedRow
              key={`${row.kind}:${row.baseUrl ?? row.label}`}
              row={row}
              added={added(row.providerId)}
              checking={checking}
              disabled={disabled}
              onCheckAgain={() => void detect()}
              connect={connect}
              onConnected={onConnected}
            />
          ))}
        </>
      )}
      <AddressRow disabled={disabled} connect={connect} onConnected={onConnected} />
    </SettingsGroup>
  )
}

/** What a connect left to do on its row: nothing, a key to enter, or plain http to agree to. */
interface ConnectState {
  busy: boolean
  /** The one line that says what went wrong, or what the next action does. */
  message: string | null
  needsKey: boolean
  consent: boolean
}

const IDLE: ConnectState = { busy: false, message: null, needsKey: false, consent: false }

/** One connect attempt and what its answer asks of the row next. */
function useConnect(connect: (input: LocalConnectInput) => Promise<LocalConnectResult>, onConnected: (providerId: string) => Promise<void>) {
  const [state, setState] = useState<ConnectState>(IDLE)
  const run = async (input: LocalConnectInput) => {
    setState((current) => ({ ...current, busy: true, message: null }))
    try {
      const result = await connect(input)
      if (result.ok) {
        await onConnected(result.providerId)
        setState(IDLE)
        return
      }
      setState((current) => ({
        busy: false,
        // The first 401 opens the key field; a key that was refused says so.
        message: result.problem === 'needs_key' && !input.apiKey ? null : result.message,
        needsKey: current.needsKey || result.problem === 'needs_key',
        consent: result.problem === 'cleartext_consent'
      }))
    } catch (error) {
      setState((current) => ({ ...current, busy: false, message: errorText(error) }))
    }
  }
  return { state, setState, run }
}

function KeyField({ value, label, disabled, onChange, onSubmit }: { value: string; label: string; disabled: boolean; onChange: (value: string) => void; onSubmit: () => void }) {
  return (
    <input
      className="settings-input"
      type="password"
      value={value}
      autoFocus
      disabled={disabled}
      placeholder="Server key"
      aria-label={`${label} key`}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSubmit()
      }}
    />
  )
}

function DetectedRow({
  row,
  added,
  checking,
  disabled,
  onCheckAgain,
  connect,
  onConnected
}: {
  row: LocalServerRow
  added: boolean
  checking: boolean
  disabled: boolean
  onCheckAgain: () => void
  connect: (input: LocalConnectInput) => Promise<LocalConnectResult>
  onConnected: (providerId: string) => Promise<void>
}) {
  const { state, setState, run } = useConnect(connect, onConnected)
  const [key, setKey] = useState('')
  const address = row.baseUrl ?? ''
  const keyShown = state.needsKey
  const submit = () => {
    if (disabled || state.busy) return
    void run({ address, ...(key.trim() ? { apiKey: key.trim() } : {}), ...(state.consent ? { allowCleartext: true } : {}) })
  }
  const detail =
    row.state === 'running' ? `${row.count ?? 0} model${row.count === 1 ? '' : 's'}` : row.state === 'not_running' ? 'Not running' : row.state === 'connected' ? 'Connected' : undefined
  const title = (
    <span className="prov-local-title">
      {row.label}
      {detail && <span className="prov-local-detail"> · {detail}</span>}
    </span>
  )
  const description = state.message ? <span className="prov-error">{state.message}</span> : undefined
  const addAgain = async (providerId: string) => {
    setState({ ...IDLE, busy: true })
    try {
      await onConnected(providerId)
      setState(IDLE)
    } catch (error) {
      setState({ ...IDLE, message: errorText(error) })
    }
  }

  if (row.state === 'connected') {
    // Its entry exists: nothing to do. A server connected before whose entry was removed is added again.
    return (
      <SettingsRow
        title={title}
        disabled={added}
        description={description}
        control={
          added ? (
            <span className="prov-local-done" title="Added" aria-label="Added">
              <Check size={14} />
            </span>
          ) : (
            <button type="button" className="settings-btn" disabled={disabled || state.busy} onClick={() => row.providerId && void addAgain(row.providerId)}>
              {state.busy ? 'Adding…' : 'Add'}
            </button>
          )
        }
      />
    )
  }
  if (row.state === 'not_running') {
    return (
      <SettingsRow
        title={title}
        control={
          <button
            type="button"
            className="settings-btn"
            disabled={disabled || checking}
            title={`Open ${row.label} and start its server, then check again.`}
            onClick={onCheckAgain}
          >
            Check again
          </button>
        }
      />
    )
  }

  const action = state.consent ? 'Connect anyway' : row.state === 'needs_key' && !keyShown ? 'Enter key' : 'Connect'
  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <>
          {keyShown && <KeyField value={key} label={row.label} disabled={disabled || state.busy} onChange={setKey} onSubmit={submit} />}
          <button
            type="button"
            className="settings-btn"
            disabled={disabled || state.busy || (keyShown && !key.trim())}
            onClick={() => (action === 'Enter key' ? setState({ ...IDLE, needsKey: true }) : submit())}
          >
            {state.busy ? 'Connecting…' : action}
          </button>
        </>
      }
    />
  )
}

/** The last row: a server at an address of its own, on this computer or another one on the network. */
function AddressRow({
  disabled,
  connect,
  onConnected
}: {
  disabled: boolean
  connect: (input: LocalConnectInput) => Promise<LocalConnectResult>
  onConnected: (providerId: string) => Promise<void>
}) {
  const { state, setState, run } = useConnect(connect, onConnected)
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [key, setKey] = useState('')
  const entered = address.trim()
  const submit = () => {
    if (disabled || state.busy || !entered || (state.needsKey && !key.trim())) return
    void run({ address: entered, ...(key.trim() ? { apiKey: key.trim() } : {}), ...(state.consent ? { allowCleartext: true } : {}) })
  }
  if (!open) {
    return (
      <SettingsRow
        title="Server address"
        control={
          <button type="button" className="settings-btn" disabled={disabled} onClick={() => setOpen(true)}>
            Enter server address
          </button>
        }
      />
    )
  }
  return (
    <SettingsRow
      title="Server address"
      description={state.message ? <span className="prov-error">{state.message}</span> : undefined}
      control={
        <>
          <input
            className="settings-input prov-mono"
            value={address}
            autoFocus={!state.needsKey}
            disabled={disabled || state.busy}
            placeholder="192.168.1.20:11434"
            aria-label="Server address"
            spellCheck={false}
            onChange={(event) => {
              setAddress(event.target.value)
              // Another address is another server: its key and consent are asked again.
              setState(IDLE)
              setKey('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit()
            }}
          />
          {state.needsKey && <KeyField value={key} label="Server" disabled={disabled || state.busy} onChange={setKey} onSubmit={submit} />}
          <button type="button" className="settings-btn" disabled={disabled || state.busy || !entered || (state.needsKey && !key.trim())} onClick={submit}>
            {state.busy ? 'Connecting…' : state.consent ? 'Connect anyway' : 'Connect'}
          </button>
        </>
      }
    />
  )
}
