import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LlmProviderOption,
  MousseSettings,
  MousseSettingsUpdate,
  SettingsOptions
} from '../../../shared/settings'
import type {
  ClaudeLoginPolicy,
  ClaudeSubscriptionStatus,
  CliProviderConfig,
  CliProviderConfigPatch,
  CliProviderInstanceId,
  CodexStatus,
  ConfiguredProvider,
  ProviderLoginOption,
  ProviderLoginResult
} from '../../../shared/providerAuth'
import {
  piInstanceId,
  piProviderIdOf,
  readProviderInstances,
  type ProviderDriverKind
} from '../../../shared/providerInstances'
import { Plus } from '../../lib/icons'
import { ProviderLoginModal } from '../ProviderLoginModal'
import { SettingsGroup } from '../settings/SettingsRow'
import { AddProviderView } from './AddProviderView'
import { ApiProviderRow, type ApiProviderEntry } from './ApiProviderRow'
import { CliProviderRow } from './CliProviderRow'
import { CLI_LOGIN_IDS, CLI_PROVIDERS, cliHealth, type CliProviderDefinition } from './cliProviders'
import { errorText } from './parts'
import '../../styles/providers.css'

export interface ProvidersSettingsProps {
  settings: MousseSettings
  options: SettingsOptions
  configuredProviders: ConfiguredProvider[]
  refreshProviderData: () => Promise<{ configured: ConfiguredProvider[]; opts: SettingsOptions }>
  updateSettings: (partial: MousseSettingsUpdate) => Promise<void>
  ensureValidProviderSelection: (next: MousseSettings, providers?: LlmProviderOption[]) => Promise<MousseSettings>
}

function ensureSignedIn(result: ProviderLoginResult, fallback: string): void {
  if (!result.success) throw new Error(result.error ?? fallback)
}

/** Settings → Providers: the agent CLIs and model APIs this device uses. */
export function ProvidersSettings({
  settings,
  options,
  configuredProviders,
  refreshProviderData,
  updateSettings,
  ensureValidProviderSelection
}: ProvidersSettingsProps) {
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const [mode, setMode] = useState<'list' | 'add'>('list')
  const [openRow, setOpenRow] = useState<string | null>(null)
  /** CLIs switched off during this visit stay listed (dimmed) so the switch can turn them back on. */
  const [keptCli, setKeptCli] = useState<ReadonlySet<string>>(() => new Set())
  const [loginOptions, setLoginOptions] = useState<ProviderLoginOption[]>([])
  const [claudeStatus, setClaudeStatus] = useState<ClaudeSubscriptionStatus | null>(null)
  const [codexStatus, setCodexStatus] = useState<CodexStatus | null>(null)
  const [cliConfigs, setCliConfigs] = useState<Partial<Record<CliProviderInstanceId, CliProviderConfig>>>({})
  const [loginActive, setLoginActive] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)

  const loadLoginOptions = useCallback(async () => {
    setLoginOptions(await window.mousse.providers.getLoginOptions())
  }, [])
  const loadStatuses = useCallback(() => {
    void window.mousse.providers.claudeStatus().then(setClaudeStatus).catch(() => {})
    void window.mousse.providers.codexStatus().then(setCodexStatus).catch(() => {})
  }, [])
  const loadCliConfigs = useCallback(async () => {
    const loaded = await Promise.all(
      CLI_PROVIDERS.map(async (cli) => [cli.id, await window.mousse.providers.cliConfig(cli.id).catch(() => undefined)] as const)
    )
    setCliConfigs(Object.fromEntries(loaded.filter(([, config]) => config)))
  }, [])

  useEffect(() => {
    void loadLoginOptions().catch(() => {})
    loadStatuses()
    void loadCliConfigs()
    return window.mousse.providers.onChanged(() => {
      void loadLoginOptions().catch(() => {})
      loadStatuses()
    })
  }, [loadLoginOptions, loadStatuses, loadCliConfigs])

  const instances = useMemo(() => readProviderInstances(settings.provider.instances), [settings.provider.instances])
  const cliEnabled = (id: string) => instances[id]?.enabled ?? true

  const modelsFor = (instanceId: string, providerId: string) =>
    options.llmProviders.find((provider) => provider.instanceId === instanceId)?.models ??
    options.llmProviders.find((provider) => provider.id === providerId)?.models ??
    []

  /** Keep the default model on a provider that is still listed. */
  const reconcileSelection = async (providers: LlmProviderOption[]) => {
    const current = settingsRef.current
    const next = await ensureValidProviderSelection(current, providers)
    if (next.provider.llmProvider === current.provider.llmProvider && next.provider.model === current.provider.model) return
    await updateSettings({ provider: { llmProvider: next.provider.llmProvider, model: next.provider.model } })
  }

  const refreshAll = async () => {
    const { opts } = await refreshProviderData()
    await reconcileSelection(opts.llmProviders)
    loadStatuses()
    await loadLoginOptions().catch(() => {})
  }

  const setInstanceEnabled = async (instanceId: string, driver: ProviderDriverKind, enabled: boolean) => {
    const existing = readProviderInstances(settingsRef.current.provider.instances)[instanceId]
    await updateSettings({ provider: { instances: { [instanceId]: { ...(existing ?? { driver }), enabled } } } })
    await refreshAll()
  }

  const runLogin = async (login: () => Promise<ProviderLoginResult>) => {
    setLoginActive(true)
    try {
      return await login()
    } finally {
      setLoginActive(false)
    }
  }

  const guard = (action: () => Promise<void>) => async () => {
    setPageError(null)
    try {
      await action()
    } catch (error) {
      setPageError(errorText(error))
    }
  }

  // Rows that throw keep their own error line; switches report here.
  const toggleCli = (cli: CliProviderDefinition) => (enabled: boolean) =>
    guard(async () => {
      await setInstanceEnabled(cli.id, cli.id, enabled)
      setKeptCli((current) => new Set(current).add(cli.id))
    })()

  const removeCli = (cli: CliProviderDefinition) => async () => {
    await setInstanceEnabled(cli.id, cli.id, false)
    setKeptCli((current) => {
      const next = new Set(current)
      next.delete(cli.id)
      return next
    })
    setOpenRow(null)
  }

  const saveCliConfig = (cli: CliProviderDefinition) => async (patch: CliProviderConfigPatch) => {
    const config = await window.mousse.providers.setCliConfig(cli.id, patch)
    setCliConfigs((current) => ({ ...current, [cli.id]: config }))
    if ('binaryPath' in patch) {
      loadStatuses()
      void refreshProviderData()
    }
  }

  const refreshModels = (providerId: string) => async () => {
    await window.mousse.providers.refreshModels(providerId)
    await refreshProviderData()
  }

  const signInCli = (cli: CliProviderDefinition) => async () => {
    ensureSignedIn(await runLogin(() => window.mousse.providers.loginOAuth(cli.providerId)), 'Sign-in failed.')
    await refreshAll()
  }

  const recheckCli = (cli: CliProviderDefinition) => async () => {
    if (cli.id === 'claude') setClaudeStatus(await window.mousse.providers.claudeStatus(true))
    else if (cli.id === 'codex') setCodexStatus(await window.mousse.providers.codexStatus(true))
    await refreshProviderData()
  }

  const setClaudePolicy = async (policy: ClaudeLoginPolicy) => {
    setClaudeStatus(await window.mousse.providers.claudeSetLoginPolicy(policy))
    await refreshAll()
  }

  /** A rejected path throws before the CLI is turned on, so the add step can show why. */
  const addCli = async (cli: CliProviderDefinition, binaryPath?: string) => {
    if (binaryPath) {
      const config = await window.mousse.providers.setCliConfig(cli.id, { binaryPath })
      setCliConfigs((current) => ({ ...current, [cli.id]: config }))
    }
    await setInstanceEnabled(cli.id, cli.id, true)
    setMode('list')
    setOpenRow(`cli:${cli.id}`)
  }

  const apiConnected = async (providerId: string) => {
    const instanceId = piInstanceId(providerId)
    if (readProviderInstances(settingsRef.current.provider.instances)[instanceId]?.enabled === false) {
      await setInstanceEnabled(instanceId, 'pi', true)
    } else {
      await refreshAll()
    }
    setMode('list')
    setOpenRow(`api:${providerId}`)
  }

  const removeApi = (entry: ApiProviderEntry) => async () => {
    await window.mousse.providers.logout(entry.providerId)
    await refreshAll()
    setOpenRow(null)
  }

  const replaceApiKey = (entry: ApiProviderEntry) => async (apiKey: string) => {
    if (apiKey) await window.mousse.providers.setApiKey(entry.providerId, apiKey)
    else ensureSignedIn(await runLogin(() => window.mousse.providers.loginApiKey(entry.providerId)), 'API key setup failed.')
    await refreshAll()
  }

  const signInApi = (entry: ApiProviderEntry) => async () => {
    ensureSignedIn(await runLogin(() => window.mousse.providers.loginOAuth(entry.providerId)), 'Sign-in failed.')
    await refreshAll()
  }

  const cliRows = CLI_PROVIDERS.filter((cli) => cliEnabled(cli.id) || keptCli.has(cli.id))

  const apiRows = useMemo(() => {
    const rows = new Map<string, ApiProviderEntry>()
    for (const provider of configuredProviders) {
      if (CLI_LOGIN_IDS.has(provider.id)) continue
      rows.set(provider.id, {
        providerId: provider.id,
        instanceId: provider.instanceId ?? piInstanceId(provider.id),
        label: provider.label,
        authType: provider.authType,
        source: provider.source,
        enabled: true
      })
    }
    // Switched-off APIs drop out of `listConfigured` but keep their credential; list them dimmed.
    for (const [instanceId, entry] of Object.entries(instances)) {
      const providerId = piProviderIdOf(instanceId)
      if (entry.driver !== 'pi' || entry.enabled || !providerId || rows.has(providerId)) continue
      const option = loginOptions.find((item) => item.id === providerId && item.configured)
      if (!option) continue
      rows.set(providerId, { providerId, instanceId, label: option.label, authType: option.authType, enabled: false })
    }
    return [...rows.values()]
  }, [configuredProviders, instances, loginOptions])

  const addableClis = CLI_PROVIDERS.filter((cli) => !cliEnabled(cli.id))
  const addableApis = loginOptions.filter((option) => !option.configured && !CLI_LOGIN_IDS.has(option.id))

  const toggleOpen = (key: string) => (open: boolean) => setOpenRow(open ? key : null)

  return (
    <>
      <ProviderLoginModal active={loginActive} onClose={() => setLoginActive(false)} />
      {mode === 'list' && (
        <div className="prov-toolbar">
          {/* Same slot and sizing as the group actions on other pages ("Add skill", "Add device"). */}
          <div className="settings-group-action">
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                setPageError(null)
                setMode('add')
                void loadLoginOptions().catch(() => {})
                // Catch a CLI installed since the page opened.
                void loadCliConfigs()
              }}
            >
              <Plus size={14} />Add provider
            </button>
          </div>
        </div>
      )}
      {pageError && <p className="prov-error">{pageError}</p>}

      {mode === 'add' ? (
        <AddProviderView
          clis={addableClis}
          cliConfigs={cliConfigs}
          apis={addableApis}
          onAddCli={addCli}
          onApiConnected={apiConnected}
          runLogin={runLogin}
          onDone={() => setMode('list')}
        />
      ) : (
        <>
          {cliRows.length > 0 && (
            <SettingsGroup title="Agent CLIs">
              {cliRows.map((cli) => {
                const enabled = cliEnabled(cli.id)
                const config = cliConfigs[cli.id]
                return (
                  <CliProviderRow
                    key={cli.id}
                    cli={cli}
                    enabled={enabled}
                    open={openRow === `cli:${cli.id}`}
                    onOpenChange={toggleOpen(`cli:${cli.id}`)}
                    state={cliHealth(cli, {
                      claude: claudeStatus,
                      codex: codexStatus,
                      config,
                      configured: configuredProviders.some((provider) => provider.instanceId === cli.id || provider.id === cli.providerId)
                    })}
                    config={config}
                    models={modelsFor(cli.id, cli.providerId)}
                    claudeStatus={cli.id === 'claude' ? claudeStatus : undefined}
                    onToggle={toggleCli(cli)}
                    onRemove={removeCli(cli)}
                    onSaveConfig={saveCliConfig(cli)}
                    onRefreshModels={refreshModels(cli.providerId)}
                    onSignIn={signInCli(cli)}
                    onRecheck={recheckCli(cli)}
                    onSetLoginPolicy={setClaudePolicy}
                  />
                )
              })}
            </SettingsGroup>
          )}

          {apiRows.length > 0 && (
            <SettingsGroup title="Model APIs">
              {apiRows.map((entry) => (
                <ApiProviderRow
                  key={entry.providerId}
                  entry={entry}
                  option={loginOptions.find((option) => option.id === entry.providerId && option.authType === entry.authType)}
                  models={modelsFor(entry.instanceId, entry.providerId)}
                  open={openRow === `api:${entry.providerId}`}
                  onOpenChange={toggleOpen(`api:${entry.providerId}`)}
                  onToggle={(enabled) => guard(() => setInstanceEnabled(entry.instanceId, 'pi', enabled))()}
                  onRemove={removeApi(entry)}
                  onReplaceKey={replaceApiKey(entry)}
                  onSignIn={signInApi(entry)}
                  onRefreshModels={refreshModels(entry.providerId)}
                />
              ))}
            </SettingsGroup>
          )}

          {cliRows.length === 0 && apiRows.length === 0 && (
            <p className="settings-muted prov-empty">No providers yet</p>
          )}
        </>
      )}
    </>
  )
}
