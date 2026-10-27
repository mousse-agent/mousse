import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { FOLDED_TARGETS, foldedInto, type FoldedTarget } from '../../../shared/harness/move'
import type { InstanceSnapshot } from '../../../shared/harness/status'
import type { AddOptionMethod, HarnessDriverKind, InstanceConfigPatch, ProviderAddOption, RegistryAgentView } from '../../../shared/harness/types'
import { Check } from '../../lib/icons'
import { ProviderIcon } from '../../lib/providerIcons'
import { llmProviderOf } from '../../lib/providerSnapshots'
import { Modal } from '../ui/Modal'
import { Segmented, SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { BrowseButton, useAsyncAction } from './parts'
import { commandLabel, DRIVER_INFO, isApiInstance, nextInstanceLabel, parseArgs, parseEnvLines, registrySourceOf } from './providerView'
import { RegistryAgentList, RegistryConfirmStep } from './RegistryAgents'

type ConnectKind = 'subscription' | 'api_key' | 'cloud'
export type CodexSetup = 'managed' | 'existing'

/** The setup step's two ways to run Codex. */
export const SETUP_INFO: Record<CodexSetup, { label: string; description: string }> = {
  managed: {
    label: 'Managed by Mousse (recommended)',
    description: "Mousse downloads OpenAI's Codex (about 160 MB) and keeps its settings separate from yours."
  },
  existing: {
    label: 'Use my Codex CLI',
    description: 'Your installed `codex`. The first entry shares your terminal sign-in; another one gets a home of its own and signs in from Mousse.'
  }
}

/** How a model API connects with one of its Add option's methods. */
const CONNECT_KIND: Record<AddOptionMethod, ConnectKind> = { oauth: 'subscription', api_key: 'api_key', ambient: 'cloud' }

/**
 * A choice in the Provider step. An agent is added as a new instance: the first on the user's own
 * setup, a further one (where the agent allows it) as another account. A model API is one choice
 * from `providers.catalog.addOptions`, with its sign-in methods picked in the Sign-in method step.
 */
export type AddChoice =
  | {
      kind: 'new'
      key: string
      label: string
      iconId: string
      group: string
      driver: HarnessDriverKind
      existing?: InstanceSnapshot
      /** The setups it can be added with (`DriverInfo.setups`), the recommended one first. */
      setups?: CodexSetup[]
      /** The user's own CLI is already added: a further entry on it is another account, with a home of its own. */
      ownSetup?: boolean
      /** The agent on a model API's key (`FOLDED_TARGETS`): Claude Code with an Anthropic API key. */
      target?: FoldedTarget
    }
  | { kind: 'api'; key: string; label: string; iconId: string; group: string; option: ProviderAddOption; methods: AddOptionMethod[] }
  /** An agent picked from the ACP registry, installed by Mousse as an entry of `driver`. */
  | { kind: 'registry'; key: string; label: string; iconId: string; group: string; driver: HarnessDriverKind }

const GROUP_ORDER = ['Agents', 'Subscriptions', 'API keys', 'Cloud credentials']
const API_GROUP: Record<ConnectKind, string> = { subscription: 'Subscriptions', api_key: 'API keys', cloud: 'Cloud credentials' }
/** Methods in the order they are offered; the first decides the provider's group. */
const KIND_ORDER: ConnectKind[] = ['subscription', 'api_key', 'cloud']
const METHOD_LABEL: Record<ConnectKind, string> = { subscription: 'Sign in', api_key: 'API key', cloud: 'Cloud credentials' }


/** An agent entry that runs on a model API's key (`FOLDED_TARGETS`), not on the agent's own sign-in. */
export function onFoldedKey(snapshot: Pick<InstanceSnapshot, 'driver' | 'config'>): boolean {
  return Object.entries(FOLDED_TARGETS).some(([providerId, target]) => foldedInto(providerId) === snapshot.driver && snapshot.config?.loginMethod === target.loginMethod)
}

/** What the dialog offers, from the device snapshots and the model APIs not added yet. */
export function addChoices(snapshots: readonly InstanceSnapshot[], addOptions: readonly ProviderAddOption[]): AddChoice[] {
  const choices: AddChoice[] = []
  for (const [driver, info] of Object.entries(DRIVER_INFO) as Array<[HarnessDriverKind, (typeof DRIVER_INFO)[HarnessDriverKind]]>) {
    if (info.family !== 'agent') continue
    // Every agent is an entry like any other: offered when there is none yet, or as another account.
    // An entry on a model API's key (`claude:api`) is not the agent's own setup.
    const existing = snapshots.find((snapshot) => snapshot.driver === driver && !onFoldedKey(snapshot))
    if (info.setups) {
      // The user's own CLI is added once on their home; a further entry is managed, or their CLI as another account with its own home.
      const ownSetup = snapshots.some((snapshot) => snapshot.driver === driver && snapshot.config?.setup !== 'managed')
      const managed = snapshots.some((snapshot) => snapshot.driver === driver && snapshot.config?.setup === 'managed')
      choices.push({
        kind: 'new',
        key: `new:${driver}`,
        label: managed ? `${info.label} · another account` : info.label,
        iconId: info.iconId,
        group: 'Agents',
        driver,
        existing,
        setups: ['managed', 'existing'],
        ...(ownSetup ? { ownSetup } : {})
      })
    } else if (!existing || info.multiInstance) {
      choices.push({
        kind: 'new',
        key: `new:${driver}`,
        label: info.addLabel ?? (existing ? `${info.label} · another account` : info.label),
        iconId: info.iconId,
        group: 'Agents',
        driver,
        existing
      })
    }
    // A registry agent is always a new entry, so this choice stays whatever is already added.
    if (info.registry) {
      choices.push({ kind: 'registry', key: `registry:${driver}`, label: info.registry.addLabel, iconId: info.iconId, group: 'Agents', driver })
    }
  }
  // A model API that runs as an agent on its key (Anthropic → Claude Code) is added as that entry,
  // with the key, under API keys; always a new entry with a home of its own.
  for (const [providerId, target] of Object.entries(FOLDED_TARGETS)) {
    const driver = foldedInto(providerId)
    if (!driver) continue
    choices.push({
      kind: 'new',
      key: `new:${driver}:${target.slug}`,
      label: target.displayName,
      iconId: providerId,
      group: API_GROUP.api_key,
      driver,
      // Its binary is the agent's: the user's own entry tells where it was found.
      existing: snapshots.find((snapshot) => snapshot.driver === driver && !onFoldedKey(snapshot)),
      target
    })
  }
  // Agents sign in through their own instance, so a provider one of them serves is not a model API
  // here. A model API that now runs as an agent (`FOLDED_INTO_AGENT`) is added as that agent only.
  const agentProviders = new Set(snapshots.filter((snapshot) => !isApiInstance(snapshot)).map(llmProviderOf))
  for (const option of addOptions) {
    if (option.added || !option.methods.length || agentProviders.has(option.id) || foldedInto(option.id)) continue
    // One entry per provider, under the group of its first method.
    const methods = [...option.methods].sort((a, b) => KIND_ORDER.indexOf(CONNECT_KIND[a]) - KIND_ORDER.indexOf(CONNECT_KIND[b]))
    choices.push({ kind: 'api', key: `api:${option.id}`, label: option.label, iconId: option.id, group: API_GROUP[CONNECT_KIND[methods[0]!]], option, methods })
  }
  return choices
}

/** The choice's tooltip: a model API's sign-in methods, an agent's one-line description. */
function choiceHint(choice: AddChoice): string | undefined {
  if (choice.kind === 'api') return choice.option.description
  if (choice.kind === 'registry') return DRIVER_INFO[choice.driver].registry?.description
  return DRIVER_INFO[choice.driver].description
}

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase()
  return !q || fields.some((field) => field?.toLowerCase().includes(q))
}

/** A numbered step bar; finished steps show a check and can be revisited. */
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
  /** Adds a new instance (its id from `slug` when given); resolves with its id. */
  add: (driver: HarnessDriverKind, config: InstanceConfigPatch, slug?: string) => Promise<string>
  /**
   * Adds a model API (`option.add`), then saves `apiKey` or runs its sign-in with `method`
   * (nothing when a credential is saved on this device already); resolves with the entry's id.
   */
  connectApi: (option: ProviderAddOption, method: AddOptionMethod, apiKey: string) => Promise<string>
}

/**
 * The Add provider dialog: Provider → Identity → Config (or Sign in). Identity names a new
 * instance; a second Claude Code instance is always another account, with a private home it
 * signs in to apart from the user's terminal.
 */
export function AddProviderDialog({
  open,
  snapshots,
  addOptions,
  handlers,
  onClose,
  onFinished
}: {
  open: boolean
  snapshots: readonly InstanceSnapshot[]
  addOptions: readonly ProviderAddOption[]
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
  const [setup, setSetup] = useState<CodexSetup>('managed')
  /** The registry step: its search, the agent picked for the confirm panel, and an entry already added. */
  const [registryQuery, setRegistryQuery] = useState('')
  const [registryAgent, setRegistryAgent] = useState<RegistryAgentView | null>(null)
  const registryAdded = useRef<{ agentId: string; version: string; instanceId: string } | null>(null)
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
    setRegistryQuery('')
    setRegistryAgent(null)
    registryAdded.current = null
  }, [open, setError])

  const choices = useMemo(() => addChoices(snapshots, addOptions), [snapshots, addOptions])
  const shown = choices.filter((choice) => matches(query, choice.label, choice.key))
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: shown.filter((choice) => choice.group === group).sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  })).filter((group) => group.items.length > 0)
  const selected = choices.find((choice) => choice.key === selectedKey) ?? null
  /** The sign-in method of a model API: the one chosen in its step, else its first. */
  const apiMethod = selected?.kind === 'api' ? (selected.methods.find((entry) => entry === method) ?? selected.methods[0]!) : undefined

  const choose = (choice: AddChoice) => {
    setSelectedKey(choice.key)
    setError(null)
    setRegistryAgent(null)
    setMethod(choice.kind === 'api' ? choice.methods[0]! : '')
    if (choice.kind === 'new' && choice.setups) setSetup(choice.setups[0]!)
    if (choice.kind === 'new' && choice.target) {
      const base = choice.target.displayName
      setLabel(snapshots.some((snapshot) => snapshot.displayName.trim().toLowerCase() === base.toLowerCase()) ? nextInstanceLabel(base, snapshots) : base)
    } else if (choice.kind === 'new') {
      const base = DRIVER_INFO[choice.driver].label
      setLabel(choice.existing && !DRIVER_INFO[choice.driver].customCommand ? nextInstanceLabel(base, snapshots) : base)
    }
  }

  const signInStep = apiMethod !== undefined && CONNECT_KIND[apiMethod] === 'subscription'
  /** A middle step only when there is a real choice to make: the sign-in method of a model API. */
  const methodStep = selected?.kind === 'api' && selected.methods.length > 1
  const lastStep = signInStep ? 'Sign in' : selected?.kind === 'api' ? 'Connect' : selected?.kind === 'registry' ? 'Agent' : 'Add'
  const steps = methodStep ? ['Provider', 'Sign-in method', lastStep] : ['Provider', lastStep]
  const last = steps.length - 1
  const summaries = [selected?.label ?? null, ...(methodStep && apiMethod ? [METHOD_LABEL[CONNECT_KIND[apiMethod]]] : []), null]

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

  /** Back from the registry's confirm panel returns to its list, not to the Provider step. */
  const inRegistryConfirm = step === last && selected?.kind === 'registry' && registryAgent !== null
  const back = () => {
    if (step === 0) return onClose()
    if (inRegistryConfirm) {
      setError(null)
      setRegistryAgent(null)
      return
    }
    goTo(step - 1)
  }

  /** Adds the registry agent (once, even when the install is retried), then starts its install. */
  const addRegistryAgent = (choice: Extract<AddChoice, { kind: 'registry' }>, agent: RegistryAgentView) =>
    void run(choice.key, async () => {
      const source = registrySourceOf(agent)
      if (!source) throw new Error(agent.unsupported ?? `Mousse cannot install ${agent.name} on this computer.`)
      const added = registryAdded.current
      const instanceId =
        added && added.agentId === agent.id && added.version === agent.version
          ? added.instanceId
          : await handlers.add(choice.driver, { displayName: agent.name, source })
      registryAdded.current = { agentId: agent.id, version: agent.version, instanceId }
      await window.mousse.providers.instances.install(instanceId)
      finish(instanceId)
    })

  if (!open) return null

  const footer = (
    <>
      <button type="button" className="btn" disabled={busy !== null} onClick={back}>
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
                        title={choiceHint(choice)}
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

        {step === 1 && methodStep && selected?.kind === 'api' && apiMethod && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              <SettingsRow
                title="Sign-in method"
                description={selected.option.description && selected.option.description !== selected.option.label ? selected.option.description : undefined}
                control={
                  <Segmented
                    ariaLabel="Sign-in method"
                    value={apiMethod}
                    onChange={setMethod}
                    options={selected.methods.map((entry) => ({ value: entry, label: METHOD_LABEL[CONNECT_KIND[entry]] }))}
                  />
                }
              />
            </SettingsGroup>
          </div>
        )}

        {step === last && selected?.kind === 'new' && DRIVER_INFO[selected.driver].customCommand && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              <CustomCommandStep
                busy={busy === selected.key}
                disabled={busy !== null}
                error={error}
                onAdd={({ name, command, args, env }) =>
                  void run(selected.key, async () => {
                    finish(await handlers.add(selected.driver, { displayName: name, binaryPath: command, args, env }))
                  })
                }
              />
            </SettingsGroup>
          </div>
        )}

        {step === last && selected?.kind === 'registry' && (
          <div className="prov-wizard-panel">
            {registryAgent ? (
              <SettingsGroup>
                <RegistryConfirmStep
                  key={`${registryAgent.id}@${registryAgent.version}`}
                  agent={registryAgent}
                  busy={busy === selected.key}
                  disabled={busy !== null}
                  error={error}
                  onConfirm={() => addRegistryAgent(selected, registryAgent)}
                />
              </SettingsGroup>
            ) : (
              <RegistryAgentList
                iconId={selected.iconId}
                query={registryQuery}
                onQuery={setRegistryQuery}
                selectedId={null}
                disabled={busy !== null}
                onSelect={(agent) => {
                  setError(null)
                  setRegistryAgent(agent)
                }}
              />
            )}
          </div>
        )}

        {step === last && selected?.kind === 'new' && selected.setups && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              {selected.setups.length > 1 && (
                <SettingsRow
                  title="Setup"
                  description={SETUP_INFO[setup].description}
                  control={
                    <Segmented
                      ariaLabel="Setup"
                      value={setup}
                      onChange={(value) => setSetup(value as CodexSetup)}
                      options={selected.setups.map((value) => ({ value, label: SETUP_INFO[value].label }))}
                    />
                  }
                />
              )}
              {selected.existing && (setup === 'managed' || selected.ownSetup) && (
                <SettingsRow
                  title="Name"
                  description="A separate account, with its own sign-in. Shown in the provider list and the model picker."
                  control={<input className="settings-input" value={label} aria-label="Name" onChange={(event) => setLabel(event.target.value)} />}
                />
              )}
              {setup === 'managed' ? (
                <ManagedSetupStep
                  busy={busy === selected.key}
                  disabled={busy !== null}
                  error={error}
                  description={selected.setups.length > 1 ? undefined : SETUP_INFO.managed.description}
                  onAdd={() =>
                    void run(selected.key, async () => {
                      const instanceId = await handlers.add(selected.driver, { displayName: label.trim() || DRIVER_INFO[selected.driver].label, setup: 'managed' })
                      // The download starts at once; it shows in the downloads indicator and the editor.
                      await window.mousse.providers.instances.install(instanceId)
                      finish(instanceId)
                    })
                  }
                />
              ) : (
                <AgentConnectStep
                  choice={{ ...selected, existing: undefined }}
                  cliLabel="Codex"
                  busy={busy === selected.key}
                  disabled={busy !== null}
                  error={error}
                  onAdd={(binaryPath) =>
                    void run(selected.key, async () => {
                      // Another account on the user's CLI gets a home of its own, and is signed in from Mousse.
                      const another = selected.ownSetup === true
                      finish(
                        await handlers.add(selected.driver, {
                          displayName: (another ? label.trim() : '') || DRIVER_INFO[selected.driver].label,
                          setup: 'existing',
                          home: another ? 'private' : 'default',
                          ...(binaryPath ? { binaryPath } : {})
                        })
                      )
                    })
                  }
                />
              )}
            </SettingsGroup>
          </div>
        )}

        {step === last && selected?.kind === 'new' && !selected.setups && !DRIVER_INFO[selected.driver].customCommand && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              {selected.kind === 'new' && selected.target && (
                <SettingsRow
                  title="API key"
                  description={`${DRIVER_INFO[selected.driver].label} runs on your API key, in a home of its own. Your own ${DRIVER_INFO[selected.driver].label} setup stays as it is. Paste the key after adding.`}
                />
              )}
              {selected.kind === 'new' && selected.existing && !selected.target && (
                <SettingsRow
                  title="Name"
                  description="A separate account, with its own sign-in. Shown in the provider list and the model picker."
                  control={<input className="settings-input" value={label} aria-label="Name" onChange={(event) => setLabel(event.target.value)} />}
                />
              )}
              <AgentConnectStep
                choice={selected}
                cliLabel={selected.target ? DRIVER_INFO[selected.driver].label : undefined}
                busy={busy === selected.key}
                disabled={busy !== null}
                error={error}
                onAdd={(binaryPath) =>
                  void run(selected.key, async () => {
                    const target = selected.target
                    const config: InstanceConfigPatch = {
                      displayName: label.trim() || target?.displayName || DRIVER_INFO[selected.driver].label,
                      ...(binaryPath ? { binaryPath } : {})
                    }
                    if (target) {
                      // On the key, always in a home of its own (the gateway holds it to that too).
                      config.home = 'private'
                      config.loginMethod = target.loginMethod
                      finish(await handlers.add(selected.driver, config, target.slug))
                      return
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

        {step === last && selected?.kind === 'api' && apiMethod && (
          <div className="prov-wizard-panel">
            <SettingsGroup>
              <ConnectStep
                key={apiMethod}
                option={selected.option}
                method={apiMethod}
                busy={busy === selected.key}
                disabled={busy !== null}
                error={error}
                onConnect={(apiKey) =>
                  void run(selected.key, async () => {
                    finish(await handlers.connectApi(selected.option, apiMethod, apiKey))
                  })
                }
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
  cliLabel,
  onAdd
}: {
  choice: Extract<AddChoice, { kind: 'new' }>
  /** The CLI's name when the entry's label names something else ("ChatGPT subscription" runs Codex). */
  cliLabel?: string
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
  const label = cliLabel ?? DRIVER_INFO[choice.driver].label
  const bundled = DRIVER_INFO[choice.driver].bundled === true
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
            ) : bundled ? (
              `${label} ships with Mousse. Sign in after adding.`
            ) : detected ? (
              `Mousse found ${label}${version ? ` ${version}` : ''} on this computer.`
            ) : (
              `Mousse uses the ${label} it finds on this computer.`
            )
          }
          control={
            <>
              {!bundled && (
                <button type="button" className="prov-link" disabled={disabled} onClick={() => setManual(true)}>
                  Use a different executable
                </button>
              )}
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

/** The Add step of a Mousse-managed Codex: it is added, then its download starts. */
export function ManagedSetupStep({
  busy,
  disabled,
  error,
  description,
  onAdd
}: {
  busy: boolean
  disabled: boolean
  error: string | null
  description?: string
  onAdd: () => void
}) {
  return (
    <SettingsRow
      title="Ready to add"
      description={error ? <span className="prov-error">{error}</span> : (description ?? 'Mousse downloads Codex now. Continue with ChatGPT once it is installed.')}
      control={
        <button type="button" className="settings-btn" autoFocus disabled={disabled} onClick={onAdd}>
          {busy ? 'Adding…' : 'Add'}
        </button>
      }
    />
  )
}

/**
 * The Add step of an agent started from a command: the program (a path, or a name Mousse finds on
 * PATH; never run through a shell), its arguments and variables, and a name. Mousse checks that
 * the agent starts and answers ACP once it is added.
 */
export function CustomCommandStep({
  busy,
  disabled,
  error,
  onAdd
}: {
  busy: boolean
  disabled: boolean
  error: string | null
  onAdd: (input: { name: string; command: string; args: string[]; env: Record<string, string> }) => void
}) {
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [name, setName] = useState('')
  const entered = command.trim()
  const canAdd = !disabled && entered !== ''
  const add = () => {
    if (canAdd) onAdd({ name: name.trim() || commandLabel(entered) || 'ACP agent', command: entered, args: parseArgs(args), env: parseEnvLines(env) })
  }
  const submitOnEnter = (event: KeyboardEvent) => {
    if (event.key === 'Enter') add()
  }
  return (
    <>
      <SettingsRow
        title="Command"
        description={error ? <span className="prov-error">{error}</span> : 'The program that starts the agent in ACP mode: a full path, or a name on your PATH.'}
        control={
          <>
            <input
              className="settings-input prov-mono prov-wide"
              value={command}
              autoFocus
              disabled={disabled}
              placeholder="grok"
              aria-label="Command"
              aria-invalid={error ? true : undefined}
              aria-required
              spellCheck={false}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={submitOnEnter}
            />
            <BrowseButton title="Choose the agent's program" defaultPath={entered || undefined} disabled={disabled} onPick={setCommand} />
          </>
        }
      />
      <SettingsRow
        title="Arguments"
        description="Passed as they are, without a shell. Quote an argument that contains spaces."
        control={
          <input
            className="settings-input prov-mono prov-wide"
            value={args}
            disabled={disabled}
            placeholder="agent stdio"
            aria-label="Arguments"
            spellCheck={false}
            onChange={(event) => setArgs(event.target.value)}
            onKeyDown={submitOnEnter}
          />
        }
      />
      <SettingsRow
        title="Variables"
        description="Optional. One NAME=value per line, set for this agent only."
        control={
          <textarea
            className="settings-input prov-mono prov-wide"
            value={env}
            rows={2}
            disabled={disabled}
            placeholder="NAME=value"
            aria-label="Variables"
            spellCheck={false}
            onChange={(event) => setEnv(event.target.value)}
          />
        }
      />
      <SettingsRow
        title="Name"
        description="Shown in the provider list and the model picker."
        control={
          <>
            <input
              className="settings-input"
              value={name}
              disabled={disabled}
              placeholder={commandLabel(entered) || 'ACP agent'}
              aria-label="Name"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={submitOnEnter}
            />
            <button type="button" className="settings-btn" disabled={!canAdd} onClick={add}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </>
        }
      />
    </>
  )
}

/**
 * The one row under a chosen model API: what to enter or do, then the connect button. A credential
 * another profile saved on this device is used as it is; a pasted key replaces it.
 */
export function ConnectStep({
  option,
  method,
  busy,
  disabled,
  error,
  onConnect
}: {
  option: ProviderAddOption
  method: AddOptionMethod
  busy: boolean
  disabled: boolean
  error: string | null
  /** `apiKey` is the pasted key, or '' for a sign-in, a guided key or the saved credential. */
  onConnect: (apiKey: string) => void
}) {
  const [apiKey, setApiKey] = useState('')
  const kind = CONNECT_KIND[method]
  const keyField = kind === 'api_key' && !option.guidedKey
  const saved = option.hasSavedKey
  const connect = () => onConnect(keyField ? apiKey.trim() : '')

  const idle = saved && !(keyField && apiKey.trim()) ? 'Add' : kind === 'subscription' ? 'Sign in' : keyField || kind === 'cloud' ? 'Connect' : 'Set up'
  const action = (
    <button type="button" className="settings-btn" disabled={disabled} onClick={connect}>
      {busy ? 'Connecting…' : idle}
    </button>
  )
  const extra = option.description && option.description !== option.label ? option.description : undefined
  const savedNote = `${option.label} is already set up on this device. Add uses it.`
  const step: { title: string; description?: string } =
    kind === 'cloud'
      ? { title: 'Credentials', description: saved ? savedNote : option.ambientInfo?.instructions.join(' ') || undefined }
      : kind === 'subscription'
        ? { title: 'Sign-in', description: saved ? savedNote : extra }
        : keyField
          ? { title: 'API key', description: saved ? `A key for ${option.label} is saved on this device. Paste another to replace it.` : 'Leave blank for guided setup' }
          : { title: 'API key', description: saved ? savedNote : (extra ?? 'Guided setup') }

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
              placeholder={saved ? 'Saved key' : `${option.label} key`}
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
