import { useEffect, useMemo, useRef, useState } from 'react'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { HarnessDriverKind, InstanceConfigPatch } from '../../../shared/harness/types'
import type { ProviderLoginOption, ProviderLoginResult } from '../../../shared/providerAuth'
import { piInstanceId } from '../../../shared/providerInstances'
import { Check } from '../../lib/icons'
import { ProviderIcon } from '../../lib/providerIcons'
import { llmProviderOf } from '../../lib/providerSnapshots'
import { Modal } from '../ui/Modal'
import { Segmented, SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { BrowseButton, useAsyncAction } from './parts'
import { DRIVER_INFO, isApiInstance, nextInstanceLabel } from './providerView'

type ConnectKind = 'subscription' | 'api_key' | 'cloud'

/** How a model API connects, from its login option. */
function connectKind(option: ProviderLoginOption): ConnectKind {
  if (option.ambient) return 'cloud'
  return option.authType === 'oauth' ? 'subscription' : 'api_key'
}

/**
 * A choice in the Provider step. An agent is added as a new instance: the first on the user's own
 * setup, a further one (where the agent allows it) as another account. A model API is one choice
 * with each of its sign-in methods (`options`), picked in the Sign-in method step.
 */
export type AddChoice =
  | { kind: 'new'; key: string; label: string; iconId: string; group: string; driver: HarnessDriverKind; existing?: InstanceSnapshot }
  | { kind: 'api'; key: string; label: string; iconId: string; group: string; options: ProviderLoginOption[] }

const GROUP_ORDER = ['Agents', 'Subscriptions', 'API keys', 'Cloud credentials']
const API_GROUP: Record<ConnectKind, string> = { subscription: 'Subscriptions', api_key: 'API keys', cloud: 'Cloud credentials' }
/** Methods in the order they are offered; the first decides the provider's group. */
const KIND_ORDER: ConnectKind[] = ['subscription', 'api_key', 'cloud']
const METHOD_LABEL: Record<ConnectKind, string> = { subscription: 'Sign in', api_key: 'API key', cloud: 'Cloud credentials' }

/** A sign-in method's key, unique within its provider. */
export function methodKey(option: ProviderLoginOption): string {
  return `${option.authType}${option.ambient ? ':ambient' : ''}`
}

/** What the dialog offers, from the device snapshots and the model APIs not connected yet. */
export function addChoices(snapshots: readonly InstanceSnapshot[], loginOptions: readonly ProviderLoginOption[]): AddChoice[] {
  const choices: AddChoice[] = []
  for (const [driver, info] of Object.entries(DRIVER_INFO) as Array<[HarnessDriverKind, (typeof DRIVER_INFO)[HarnessDriverKind]]>) {
    if (info.family !== 'agent') continue
    // Every agent is an entry like any other: offered when there is none yet, or as another account.
    const existing = snapshots.find((snapshot) => snapshot.driver === driver)
    if (!existing || info.multiInstance) {
      choices.push({
        kind: 'new',
        key: `new:${driver}`,
        label: existing ? `${info.label} · another account` : info.label,
        iconId: info.iconId,
        group: 'Agents',
        driver,
        existing
      })
    }
  }
  // Agents sign in through their own instance; their login options are not model APIs.
  const agentProviders = new Set(snapshots.filter((snapshot) => !isApiInstance(snapshot)).map(llmProviderOf))
  const methods = new Map<string, ProviderLoginOption[]>()
  for (const option of loginOptions) {
    if (option.configured || agentProviders.has(option.id)) continue
    const listed = methods.get(option.id)
    if (!listed) methods.set(option.id, [option])
    else if (!listed.some((entry) => methodKey(entry) === methodKey(option))) listed.push(option)
  }
  // One entry per provider (T3 Code), under the group of its first method.
  for (const [id, options] of methods) {
    options.sort((a, b) => KIND_ORDER.indexOf(connectKind(a)) - KIND_ORDER.indexOf(connectKind(b)))
    choices.push({ kind: 'api', key: `api:${id}`, label: options[0]!.label, iconId: id, group: API_GROUP[connectKind(options[0]!)], options })
  }
  return choices
}

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase()
  return !q || fields.some((field) => field?.toLowerCase().includes(q))
}

/** T3 Code's numbered step bar; finished steps show a check and can be revisited. */
function WizardSteps({
  steps,
  current,
  summaries,
  disabled,
  onStep
}: {
  steps: readonly string[]
  current: number
  summaries: ReadonlyArray<string | null>
  disabled: boolean
  onStep: (step: number) => void
}) {
  return (
    <ol className="prov-steps" aria-label="Steps">
      {steps.map((step, index) => (
        <li key={step}>
          <button
            type="button"
            className={`prov-step${index === current ? ' is-current' : ''}${index < current ? ' is-done' : ''}`}
            aria-current={index === current ? 'step' : undefined}
            disabled={disabled || index > current}
            onClick={() => onStep(index)}
          >
            <span className="prov-step-num">{index < current ? <Check size={13} /> : index + 1}</span>
            <span className="prov-step-label">
              {step}
              {index < current && summaries[index] ? `: ${summaries[index]}` : ''}
            </span>
          </button>
        </li>
      ))}
    </ol>
  )
}

export interface AddProviderHandlers {
  /** Adds a new instance; resolves with its id. */
  add: (driver: HarnessDriverKind, config: InstanceConfigPatch) => Promise<string>
  onApiConnected: (providerId: string) => Promise<void>
  runLogin: (login: () => Promise<ProviderLoginResult>) => Promise<ProviderLoginResult>
}

/**
 * T3 Code's Add provider dialog: Provider → Identity → Config (or Sign in). Identity names a new
 * instance; a second Claude Code instance is always another account, with a private home it
 * signs in to apart from the user's terminal.
 */
export function AddProviderDialog({
  open,
  snapshots,
  loginOptions,
  handlers,
  onClose,
  onFinished
}: {
  open: boolean
  snapshots: readonly InstanceSnapshot[]
  loginOptions: readonly ProviderLoginOption[]
  handlers: AddProviderHandlers
  onClose: () => void
  /** The instance that was added or turned on; select it in the list. */
  onFinished: (instanceId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [step, setStep] = useState(0)
  const [label, setLabel] = useState('')
  const [method, setMethod] = useState('')
  const { busy, error, setError, run } = useAsyncAction()
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open && step === 0) searchRef.current?.focus()
  }, [open, step])
  useEffect(() => {
    if (open) return
    setQuery('')
    setSelectedKey(null)
    setStep(0)
    setError(null)
  }, [open, setError])

  const choices = useMemo(() => addChoices(snapshots, loginOptions), [snapshots, loginOptions])
  const shown = choices.filter((choice) => matches(query, choice.label, choice.key))
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: shown.filter((choice) => choice.group === group).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  })).filter((group) => group.items.length > 0)
  const selected = choices.find((choice) => choice.key === selectedKey) ?? null
  /** The sign-in method of a model API: the one chosen in Identity, else its first. */
  const apiOption = selected?.kind === 'api' ? (selected.options.find((option) => methodKey(option) === method) ?? selected.options[0]!) : undefined

  const choose = (choice: AddChoice) => {
    setSelectedKey(choice.key)
    setError(null)
    setMethod(choice.kind === 'api' ? methodKey(choice.options[0]!) : '')
    if (choice.kind === 'new') {
      const base = DRIVER_INFO[choice.driver].label
      setLabel(choice.existing ? nextInstanceLabel(base, snapshots) : base)
    }
  }

  const signInStep = apiOption !== undefined && connectKind(apiOption) === 'subscription'
  /** A middle step only when there is a real choice to make: the sign-in method of a model API. */
  const methodStep = selected?.kind === 'api' && selected.options.length > 1
  const lastStep = signInStep ? 'Sign in' : selected?.kind === 'api' ? 'Connect' : 'Add'
  const steps = methodStep ? ['Provider', 'Sign-in method', lastStep] : ['Provider', lastStep]
  const last = steps.length - 1
  const summaries = [selected?.label ?? null, ...(methodStep && apiOption ? [METHOD_LABEL[connectKind(apiOption)]] : []), null]

  const goTo = (next: number) => {
    setError(null)
    if (next > 0 && !selected) {
      setError('Choose a provider.')
      return
    }
    setStep(Math.max(0, Math.min(last, next)))
  }

  const finish = (instanceId: string) => {
    onFinished(instanceId)
    onClose()
  }

  if (!open) return null

  const footer = (
    <>
      <button type="button" className="btn" disabled={busy !== null} onClick={() => (step === 0 ? onClose() : goTo(step - 1))}>
        {step === 0 ? 'Cancel' : 'Back'}
      </button>
      {step < last && (
        <button type="button" className="btn btn-primary" disabled={!selected} onClick={() => goTo(step + 1)}>
          Next
        </button>
      )}
    </>
  )

  return (
    <Modal open title="Add provider" onClose={onClose} className="prov-wizard-overlay" footer={footer}>
      <div className="prov-wizard">
        <p className="prov-wizard-desc">Add an account or configure a provider on this device.</p>
        <WizardSteps steps={steps} current={step} summaries={summaries} disabled={busy !== null} onStep={goTo} />
        {error && step < last && <p className="prov-error">{error}</p>}

        {step === 0 && (
          <div className="prov-wizard-panel">
            <input
              ref={searchRef}
              className="settings-input prov-wizard-search"
              value={query}
              placeholder="Search providers"
              aria-label="Search providers"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
            {groups.length === 0 && (
              <p className="settings-muted prov-empty">{query.trim() ? 'No matches' : 'Every provider is already added'}</p>
            )}
            {groups.map(({ group, items }) => (
              <div key={group} className="prov-choice-group">
                <div className="prov-choice-heading">{group}</div>
                <div className="prov-choice-grid" role="radiogroup" aria-label={group}>
                  {items.map((choice) => {
                    const checked = choice.key === selectedKey
                    return (
                      <button
                        key={choice.key}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        className={`prov-choice${checked ? ' is-checked' : ''}`}
                        title={choice.kind === 'api' ? choice.options.map((option) => option.description).filter(Boolean).join(' · ') || undefined : choice.kind === 'new' ? DRIVER_INFO[choice.driver].description : undefined}
                        onClick={() => choose(choice)}
                        onDoubleClick={() => {
                          choose(choice)
                          setStep(1)
                        }}
                      >
                        <ProviderIcon providerId={choice.iconId} size={16} />
                        <span className="prov-choice-label">{choice.label}</span>
                        {checked && (
                          <span className="prov-choice-check" aria-hidden="true">
                            <Check size={12} />
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {step === 1 && methodStep && selected?.kind === 'api' && apiOption && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              <SettingsRow
                title="Sign-in method"
                description={apiOption.description && apiOption.description !== apiOption.label ? apiOption.description : undefined}
                control={
                  <Segmented
                    ariaLabel="Sign-in method"
                    value={methodKey(apiOption)}
                    onChange={setMethod}
                    options={selected.options.map((option) => ({ value: methodKey(option), label: METHOD_LABEL[connectKind(option)] }))}
                  />
                }
              />
            </SettingsGroup>
          </div>
        )}

        {step === last && selected && selected.kind !== 'api' && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              {selected.kind === 'new' && selected.existing && (
                <SettingsRow
                  title="Name"
                  description="A separate account, with its own sign-in. Shown in the provider list and the model picker."
                  control={<input className="settings-input" value={label} aria-label="Name" onChange={(event) => setLabel(event.target.value)} />}
                />
              )}
              <AgentConnectStep
                choice={selected}
                busy={busy === selected.key}
                disabled={busy !== null}
                error={error}
                onAdd={(binaryPath) =>
                  void run(selected.key, async () => {
                    const config: InstanceConfigPatch = {
                      displayName: label.trim() || DRIVER_INFO[selected.driver].label,
                      ...(binaryPath ? { binaryPath } : {})
                    }
                    // A second instance of an agent is another account, so it gets its own home.
                    if (DRIVER_INFO[selected.driver].multiInstance) config.home = selected.existing ? 'private' : 'default'
                    finish(await handlers.add(selected.driver, config))
                  })
                }
              />
            </SettingsGroup>
          </div>
        )}

        {step === last && selected?.kind === 'api' && apiOption && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              <ConnectStep
                key={methodKey(apiOption)}
                option={apiOption}
                busy={busy === selected.key}
                disabled={busy !== null}
                error={error}
                onConnect={(connect) =>
                  void run(selected.key, async () => {
                    await connect()
                    await handlers.onApiConnected(apiOption.id)
                    finish(piInstanceId(apiOption.id))
                  })
                }
                runLogin={handlers.runLogin}
              />
            </SettingsGroup>
          </div>
        )}
      </div>
    </Modal>
  )
}

/**
 * The Add step of an agent: "Ready to add" when Mousse found the CLI, with a different executable
 * on request; the executable is required when it was not found. An agent that is not installed yet
 * offers Install in its editor once added.
 */
export function AgentConnectStep({
  choice,
  busy,
  disabled,
  error,
  onAdd
}: {
  choice: Extract<AddChoice, { kind: 'new' }>
  busy: boolean
  disabled: boolean
  error: string | null
  onAdd: (binaryPath?: string) => void
}) {
  const [path, setPath] = useState('')
  const [manual, setManual] = useState(false)
  const known = choice.existing
  const detected = known?.binary?.source === 'override' ? undefined : known?.binary?.path
  const checked = Boolean(known && (known.checkedAt || known.stale))
  const missing = checked && known?.install.state === 'not_installed'
  // Most people never need the executable field: it shows only when nothing was found or on request.
  const showPath = missing || manual
  const version = known?.binary?.version
  const entered = path.trim()
  const canAdd = !disabled && (entered !== '' || !missing)
  const label = DRIVER_INFO[choice.driver].label
  const add = () => {
    if (canAdd) onAdd(entered || undefined)
  }
  const pathError = showPath ? error : null

  return (
    <>
      {!showPath && (
        <SettingsRow
          title="Ready to add"
          description={
            error ? (
              <span className="prov-error">{error}</span>
            ) : detected ? (
              `Mousse found ${label}${version ? ` ${version}` : ''} on this computer.`
            ) : (
              `Mousse uses the ${label} it finds on this computer.`
            )
          }
          control={
            <>
              <button type="button" className="prov-link" disabled={disabled} onClick={() => setManual(true)}>
                Use a different executable
              </button>
              <button type="button" className="settings-btn" autoFocus disabled={!canAdd} onClick={() => add()}>
                {busy ? 'Adding…' : 'Add'}
              </button>
            </>
          }
        />
      )}
      {showPath && (
        <SettingsRow
          title="Executable"
          description={
            pathError ? (
              <span className="prov-error">{pathError}</span>
            ) : busy && entered ? (
              'Checking the executable…'
            ) : missing ? (
              'Not found automatically. Choose the executable.'
            ) : (
              'Optional. Leave empty to use the one Mousse finds.'
            )
          }
          control={
            <>
              {!missing && (
                <button
                  type="button"
                  className="prov-link"
                  disabled={disabled}
                  onClick={() => {
                    setManual(false)
                    setPath('')
                  }}
                >
                  Use the one Mousse found
                </button>
              )}
              <input
                className="settings-input prov-mono prov-wide"
                value={path}
                autoFocus
                disabled={disabled}
                placeholder={detected ?? 'Path to the executable'}
                title={detected}
                aria-label={`${label} executable path`}
                aria-invalid={pathError ? true : undefined}
                aria-required={missing || undefined}
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') add()
                }}
              />
              <BrowseButton title={`Choose the ${label} executable`} defaultPath={entered || detected} disabled={disabled} onPick={setPath} />
              <button type="button" className="settings-btn" disabled={!canAdd} onClick={() => add()}>
                {busy ? 'Adding…' : 'Add'}
              </button>
            </>
          }
        />
      )}
    </>
  )
}

/** The one row under a chosen model API: what to enter or do, then the connect button. */
export function ConnectStep({
  option,
  busy,
  disabled,
  error,
  onConnect,
  runLogin
}: {
  option: ProviderLoginOption
  busy: boolean
  disabled: boolean
  error: string | null
  onConnect: (connect: () => Promise<void>) => void
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
