import { useEffect, useRef, useState, type ReactNode } from 'react'
import type {
  CliProviderConfig,
  CliProviderInstanceId,
  ProviderLoginOption,
  ProviderLoginResult
} from '../../../shared/providerAuth'
import { Plus, X } from '../../lib/icons'
import { ProviderIcon } from '../../lib/providerIcons'
import { SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { SettingsSearch } from '../settings/SettingsSearch'
import type { CliProviderDefinition } from './cliProviders'
import { BrowseButton, useAsyncAction } from './parts'

type ConnectKind = 'subscription' | 'api_key' | 'cloud'

/** How a provider connects, from its login option. */
function connectKind(option: ProviderLoginOption): ConnectKind {
  if (option.ambient) return 'cloud'
  return option.authType === 'oauth' ? 'subscription' : 'api_key'
}

const API_GROUPS: ReadonlyArray<{ kind: ConnectKind; title: string; description: string }> = [
  { kind: 'subscription', title: 'Subscriptions', description: 'Sign in with a plan you already pay for' },
  { kind: 'api_key', title: 'API keys', description: 'Paste a key from the provider' },
  { kind: 'cloud', title: 'Cloud credentials', description: 'Reuse a cloud account you’re already signed in to' }
]

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase()
  return !q || fields.some((field) => field?.toLowerCase().includes(q))
}

const byName = <T extends { label: string }>(a: T, b: T) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })

function PickerRow({
  iconId,
  name,
  hint,
  open,
  control,
  children
}: {
  iconId: string
  name: string
  hint?: string
  open?: boolean
  control: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={`prov-row${open ? ' is-open' : ''}`}>
      <div className="prov-row-main is-static">
        <span className="prov-row-head">
          <span className="prov-logo">
            <ProviderIcon providerId={iconId} size={16} />
          </span>
          <span className="settings-item-text" title={hint}>
            <span className="settings-item-title">{name}</span>
          </span>
        </span>
        {control}
      </div>
      {open && children && <div className="prov-row-panel">{children}</div>}
    </div>
  )
}

/** Searchable list of providers not added yet, grouped by how they connect. */
export function AddProviderView({
  clis,
  cliConfigs,
  apis,
  onAddCli,
  onApiConnected,
  runLogin,
  onDone
}: {
  clis: readonly CliProviderDefinition[]
  /** Loaded executable settings; a missing entry is still loading or unavailable. */
  cliConfigs: Partial<Record<CliProviderInstanceId, CliProviderConfig>>
  apis: ProviderLoginOption[]
  /** Saves `binaryPath` first when given (rejects with the validation message), then adds the CLI. */
  onAddCli: (cli: CliProviderDefinition, binaryPath?: string) => Promise<void>
  onApiConnected: (providerId: string) => Promise<void>
  runLogin: (login: () => Promise<ProviderLoginResult>) => Promise<ProviderLoginResult>
  onDone: () => void
}) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const { busy, error, setError, run } = useAsyncAction()
  /** Opens or closes one item's connect step; an error belongs to the step it came from. */
  const choose = (key: string | null) => {
    setError(null)
    setSelected(key)
  }
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => searchRef.current?.focus(), [])

  const shownClis = clis.filter((cli) => matches(query, cli.label, cli.id)).sort(byName)
  const shownApis = apis.filter((option) => matches(query, option.label, option.id, option.description))
  const optionKey = (option: ProviderLoginOption) => `${option.id}:${option.authType}`
  const groups = API_GROUPS.map((group) => ({
    ...group,
    options: shownApis.filter((option) => connectKind(option) === group.kind).sort(byName)
  })).filter((group) => group.options.length > 0)

  return (
    <>
      <div className="prov-toolbar">
        <SettingsSearch
          className="prov-search"
          inputRef={searchRef}
          value={query}
          ariaLabel="Search providers"
          onChange={setQuery}
        />
        <div className="settings-group-action">
          <button type="button" className="settings-btn" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
      {error && !selected && <p className="prov-error">{error}</p>}

      {shownClis.length > 0 && (
        <SettingsGroup title="Agent CLIs" description="Coding agents you have installed, with their own sign-in">
          {shownClis.map((cli) => {
            const key = `cli:${cli.id}`
            const open = selected === key
            return (
              <PickerRow
                key={key}
                iconId={cli.iconId}
                name={cli.label}
                open={open}
                control={
                  <button
                    type="button"
                    className={open ? 'settings-icon-btn' : 'settings-icon-btn primary'}
                    title={open ? 'Cancel' : 'Add'}
                    aria-label={open ? 'Cancel' : `Add ${cli.label}`}
                    aria-expanded={open}
                    disabled={busy !== null}
                    onClick={() => choose(open ? null : key)}
                  >
                    {open ? <X size={14} /> : <Plus size={14} />}
                  </button>
                }
              >
                <CliConnectStep
                  cli={cli}
                  config={cliConfigs[cli.id]}
                  busy={busy === key}
                  disabled={busy !== null}
                  error={error}
                  onAdd={(binaryPath) => void run(key, () => onAddCli(cli, binaryPath))}
                />
              </PickerRow>
            )
          })}
        </SettingsGroup>
      )}

      {groups.map((group) => (
        <SettingsGroup key={group.kind} title={group.title} description={group.description}>
          {group.options.map((option) => {
            const key = optionKey(option)
            const open = selected === key
            return (
              <PickerRow
                key={key}
                iconId={option.id}
                name={option.label}
                hint={option.description}
                open={open}
                control={
                  <button
                    type="button"
                    className={open ? 'settings-icon-btn' : 'settings-icon-btn primary'}
                    title={open ? 'Cancel' : 'Add'}
                    aria-label={open ? 'Cancel' : `Add ${option.label}`}
                    aria-expanded={open}
                    disabled={busy !== null}
                    onClick={() => choose(open ? null : key)}
                  >
                    {open ? <X size={14} /> : <Plus size={14} />}
                  </button>
                }
              >
                <ConnectStep
                  option={option}
                  busy={busy === key}
                  disabled={busy !== null}
                  error={error}
                  onConnect={(connect) => void run(key, connect)}
                  onApiConnected={onApiConnected}
                  runLogin={runLogin}
                />
              </PickerRow>
            )
          })}
        </SettingsGroup>
      ))}

      {shownClis.length === 0 && groups.length === 0 && (
        <p className="settings-muted prov-empty">{query.trim() ? 'No matches' : 'Every provider is already added'}</p>
      )}
    </>
  )
}

/**
 * The sub-row under a chosen agent CLI: its executable, then Add. A path is optional when Mousse
 * found the CLI (shown as the placeholder) and required when it didn't.
 */
function CliConnectStep({
  cli,
  config,
  busy,
  disabled,
  error,
  onAdd
}: {
  cli: CliProviderDefinition
  config?: CliProviderConfig
  busy: boolean
  disabled: boolean
  error: string | null
  onAdd: (binaryPath?: string) => void
}) {
  const [path, setPath] = useState('')
  const detected = config?.resolvedBinaryPath
  const missing = config !== undefined && !detected
  const entered = path.trim()
  const canAdd = !disabled && (entered !== '' || !missing)
  const add = () => {
    if (canAdd) onAdd(entered || undefined)
  }
  const description = error ? (
    <span className="prov-error">{error}</span>
  ) : busy && entered ? (
    'Checking the executable…'
  ) : missing ? (
    'Not found automatically — choose the executable'
  ) : undefined

  return (
    <SettingsRow
      indent
      title="Executable"
      description={description}
      control={
        <>
          <input
            className="settings-input prov-mono prov-wide"
            value={path}
            autoFocus
            disabled={disabled}
            placeholder={detected ?? 'Path to the executable'}
            title={detected}
            aria-label={`${cli.label} executable path`}
            aria-invalid={error ? true : undefined}
            aria-required={missing || undefined}
            spellCheck={false}
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') add()
            }}
          />
          <BrowseButton
            title={`Choose the ${cli.label} executable`}
            defaultPath={entered || detected}
            disabled={disabled}
            onPick={setPath}
          />
          <button type="button" className="settings-btn" disabled={!canAdd} onClick={() => add()}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      }
    />
  )
}

/** The one sub-row under a chosen provider: what to enter or do, then the connect button. */
function ConnectStep({
  option,
  busy,
  disabled,
  error,
  onConnect,
  onApiConnected,
  runLogin
}: {
  option: ProviderLoginOption
  busy: boolean
  disabled: boolean
  error: string | null
  onConnect: (connect: () => Promise<void>) => void
  onApiConnected: (providerId: string) => Promise<void>
  runLogin: (login: () => Promise<ProviderLoginResult>) => Promise<ProviderLoginResult>
}) {
  const [apiKey, setApiKey] = useState('')
  const [instructions, setInstructions] = useState<string[]>([])
  useEffect(() => {
    if (!option.ambient) return
    void window.mousse.providers
      .getAmbientInfo(option.id)
      .then((info) => setInstructions(info?.instructions ?? []))
      .catch(() => {})
  }, [option.ambient, option.id])

  const ensure = (result: ProviderLoginResult, fallback: string) => {
    if (!result.success) throw new Error(result.error ?? fallback)
  }
  const kind = connectKind(option)
  const keyField = kind === 'api_key' && !option.guidedLogin
  const connect = () =>
    onConnect(async () => {
      if (kind === 'cloud') {
        ensure(await window.mousse.providers.verifyAmbient(option.id), 'Could not verify the credentials.')
      } else if (kind === 'subscription') {
        ensure(await runLogin(() => window.mousse.providers.loginOAuth(option.id)), 'Sign-in failed.')
      } else if (!keyField || !apiKey.trim()) {
        ensure(await runLogin(() => window.mousse.providers.loginApiKey(option.id)), 'API key setup failed.')
      } else {
        await window.mousse.providers.setApiKey(option.id, apiKey.trim())
      }
      await onApiConnected(option.id)
    })

  const idle = kind === 'subscription' ? 'Sign in' : keyField || kind === 'cloud' ? 'Connect' : 'Set up'
  const action = (
    <button type="button" className="settings-btn" disabled={disabled} onClick={connect}>
      {busy ? 'Connecting…' : idle}
    </button>
  )
  const extra = option.description && option.description !== option.label ? option.description : undefined
  const step: { title: string; description?: string } =
    kind === 'cloud'
      ? { title: 'Credentials', description: instructions.join(' ') || undefined }
      : kind === 'subscription'
        ? { title: 'Sign-in', description: extra }
        : keyField
          ? { title: 'API key', description: 'Leave blank for guided setup' }
          : { title: 'API key', description: extra ?? 'Guided setup' }

  return (
    <SettingsRow
      indent
      title={step.title}
      description={error ? <span className="prov-error">{error}</span> : step.description}
      control={
        keyField ? (
          <>
            <input
              className="settings-input"
              type="password"
              value={apiKey}
              autoFocus
              placeholder={`${option.label} key`}
              aria-label={`${option.label} API key`}
              onChange={(event) => setApiKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !disabled) connect()
              }}
            />
            {action}
          </>
        ) : (
          action
        )
      }
    />
  )
}
