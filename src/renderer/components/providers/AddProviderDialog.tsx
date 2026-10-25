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
 * A choice in the Provider step. An agent whose seeded instance is switched off is turned back on;
 * otherwise, where a second account makes sense, the dialog adds a new instance.
 */
export type AddChoice =
  | { kind: 'enable'; key: string; label: string; iconId: string; group: string; snapshot: InstanceSnapshot }
  | { kind: 'new'; key: string; label: string; iconId: string; group: string; driver: HarnessDriverKind; existing?: InstanceSnapshot }
  | { kind: 'api'; key: string; label: string; iconId: string; group: string; option: ProviderLoginOption }

const GROUP_ORDER = ['Agents', 'Subscriptions', 'API keys', 'Cloud credentials']
const API_GROUP: Record<ConnectKind, string> = { subscription: 'Subscriptions', api_key: 'API keys', cloud: 'Cloud credentials' }

/** What the dialog offers, from the device snapshots and the model APIs not connected yet. */
export function addChoices(snapshots: readonly InstanceSnapshot[], loginOptions: readonly ProviderLoginOption[]): AddChoice[] {
  const choices: AddChoice[] = []
  for (const [driver, info] of Object.entries(DRIVER_INFO) as Array<[HarnessDriverKind, (typeof DRIVER_INFO)[HarnessDriverKind]]>) {
    if (info.family !== 'agent') continue
    const seeded = snapshots.find((snapshot) => snapshot.builtIn && snapshot.driver === driver)
    if (seeded && !seeded.enabled.device) {
      choices.push({ kind: 'enable', key: `enable:${seeded.instanceId}`, label: info.label, iconId: info.iconId, group: 'Agents', snapshot: seeded })
    } else if (!seeded || info.multiInstance) {
      choices.push({
        kind: 'new',
        key: `new:${driver}`,
        label: seeded ? `${info.label} · another account` : info.label,
        iconId: info.iconId,
        group: 'Agents',
        driver,
        existing: seeded
      })
    }
  }
  // Agents sign in through their own instance; their login options are not model APIs.
  const agentProviders = new Set(snapshots.filter((snapshot) => !isApiInstance(snapshot)).map(llmProviderOf))
  for (const option of loginOptions) {
    if (option.configured || agentProviders.has(option.id)) continue
    choices.push({
      kind: 'api',
      key: `api:${option.id}:${option.authType}`,
      label: option.label,
      iconId: option.id,
      group: API_GROUP[connectKind(option)],
      option
    })
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
  /** Turns a switched-off seeded agent back on, saving `binaryPath` first when given. */
  enable: (snapshot: InstanceSnapshot, binaryPath?: string) => Promise<void>
  /** Turns it on and starts its install; progress continues in the editor. */
  install: (snapshot: InstanceSnapshot) => Promise<void>
  /** Adds a new instance; resolves with its id. */
  add: (driver: HarnessDriverKind, config: InstanceConfigPatch) => Promise<string>
  onApiConnected: (providerId: string) => Promise<void>
  runLogin: (login: () => Promise<ProviderLoginResult>) => Promise<ProviderLoginResult>
}

/**
 * T3 Code's Add provider dialog: Provider → Identity → Config (or Sign in). Identity names a new
 * instance and picks its home: a second Claude Code account gets a private home and signs in
 * there, apart from the user's terminal.
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
  const [home, setHome] = useState<'default' | 'private'>('private')
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

  const choose = (choice: AddChoice) => {
    setSelectedKey(choice.key)
    setError(null)
    if (choice.kind === 'new') {
      const base = DRIVER_INFO[choice.driver].label
      setLabel(choice.existing ? nextInstanceLabel(base, snapshots) : base)
      // The seeded instance already uses the shared home; a second one only helps with its own.
      setHome(choice.existing ? 'private' : 'default')
    }
  }

  const signInStep = selected?.kind === 'api' && connectKind(selected.option) === 'subscription'
  const steps = ['Provider', 'Identity', signInStep ? 'Sign in' : 'Config'] as const
  const summaries = [selected?.label ?? null, selected?.kind === 'new' ? label.trim() || null : (selected?.label ?? null), null]

  const goTo = (next: number) => {
    setError(null)
    if (next > 0 && !selected) {
      setError('Choose a provider.')
      return
    }
    if (next > 1 && selected?.kind === 'new' && !label.trim()) {
      setError('Enter a label.')
      return
    }
    setStep(Math.max(0, Math.min(steps.length - 1, next)))
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
      {step < 2 && (
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
        {error && step < 2 && <p className="prov-error">{error}</p>}

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
                        title={choice.kind === 'api' ? choice.option.description : choice.kind === 'new' ? DRIVER_INFO[choice.driver].description : undefined}
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

        {step === 1 && selected && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              {selected.kind === 'new' ? (
                <>
                  <SettingsRow
                    title="Label"
                    description="Shown in the provider list and the model picker."
                    control={
                      <input
                        className="settings-input"
                        value={label}
                        autoFocus
                        aria-label="Label"
                        onChange={(event) => setLabel(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') goTo(2)
                        }}
                      />
                    }
                  />
                  {DRIVER_INFO[selected.driver].multiInstance && (
                    <SettingsRow
                      title="Account"
                      description={
                        home === 'private'
                          ? 'Mousse keeps a private home for this instance. Sign in to another account there; your terminal is not touched.'
                          : `Uses your own setup${DRIVER_INFO[selected.driver].homeHint ? ` (${DRIVER_INFO[selected.driver].homeHint})` : ''}, signed in the way your terminal is.`
                      }
                      control={
                        <Segmented
                          ariaLabel="Account home"
                          value={home}
                          onChange={setHome}
                          options={[
                            { value: 'private', label: 'Separate account' },
                            { value: 'default', label: 'Your own' }
                          ]}
                        />
                      }
                    />
                  )}
                </>
              ) : (
                <SettingsRow
                  title="Label"
                  description={
                    selected.kind === 'enable'
                      ? 'This provider is set up already and switched off. Adding turns it back on.'
                      : 'Shown in the provider list.'
                  }
                  control={<input className="settings-input" value={selected.label} readOnly disabled aria-label="Label" />}
                />
              )}
            </SettingsGroup>
          </div>
        )}

        {step === 2 && selected && selected.kind !== 'api' && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              <AgentConnectStep
                choice={selected}
                busy={busy === selected.key}
                disabled={busy !== null}
                error={error}
                onAdd={(binaryPath) =>
                  void run(selected.key, async () => {
                    if (selected.kind === 'enable') {
                      await handlers.enable(selected.snapshot, binaryPath)
                      finish(selected.snapshot.instanceId)
                    } else {
                      const config: InstanceConfigPatch = { displayName: label.trim(), ...(binaryPath ? { binaryPath } : {}) }
                      if (DRIVER_INFO[selected.driver].multiInstance) config.home = home
                      finish(await handlers.add(selected.driver, config))
                    }
                  })
                }
                onInstall={
                  selected.kind === 'enable'
                    ? () =>
                        void run(selected.key, async () => {
                          await handlers.install(selected.snapshot)
                          finish(selected.snapshot.instanceId)
                        })
                    : undefined
                }
              />
            </SettingsGroup>
          </div>
        )}

        {step === 2 && selected?.kind === 'api' && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              <ConnectStep
                option={selected.option}
                busy={busy === selected.key}
                disabled={busy !== null}
                error={error}
                onConnect={(connect) =>
                  void run(selected.key, async () => {
                    await connect()
                    await handlers.onApiConnected(selected.option.id)
                    finish(piInstanceId(selected.option.id))
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
 * The Config step of an agent: its executable, then Add. A path is optional when Mousse found the
 * CLI (shown as the placeholder) and required when it did not. An agent Mousse can install itself
 * (Antigravity) offers Install first; an existing binary is the smaller option.
 */
export function AgentConnectStep({
  choice,
  busy,
  disabled,
  error,
  onAdd,
  onInstall
}: {
  choice: Extract<AddChoice, { kind: 'enable' | 'new' }>
  busy: boolean
  disabled: boolean
  error: string | null
  onAdd: (binaryPath?: string) => void
  onInstall?: () => void
}) {
  const [path, setPath] = useState('')
  const [manual, setManual] = useState(false)
  const known = choice.kind === 'enable' ? choice.snapshot : choice.existing
  const detected = known?.binary?.source === 'override' ? undefined : known?.binary?.path
  const checked = Boolean(known && (known.checkedAt || known.stale))
  const missing = checked && known?.install.state === 'not_installed'
  const offerInstall = Boolean(onInstall) && choice.kind === 'enable' && missing && choice.snapshot.install.canInstall
  const showPath = !offerInstall || manual
  const entered = path.trim()
  const canAdd = !disabled && (entered !== '' || !missing)
  const label = choice.kind === 'enable' ? choice.label : DRIVER_INFO[choice.driver].label
  const add = () => {
    if (canAdd) onAdd(entered || undefined)
  }
  const pathError = showPath ? error : null

  return (
    <>
      {offerInstall && (
        <SettingsRow
          title="Install"
          description={
            !manual && error ? (
              <span className="prov-error">{error}</span>
            ) : busy && !manual ? (
              'Starting the install…'
            ) : (
              `Mousse downloads and installs ${label} for you. You can follow the progress in its settings.`
            )
          }
          control={
            <>
              <button type="button" className="prov-link" disabled={disabled} onClick={() => setManual((value) => !value)}>
                {manual ? 'Hide existing binary' : 'Use an existing binary'}
              </button>
              <button type="button" className="settings-btn" disabled={disabled} onClick={onInstall}>
                Install
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
