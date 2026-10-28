import { useCallback, useEffect, useRef, useState } from 'react'
import type { LlmProviderOption, MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../../../shared/settings'
import { describeStatus, type InstanceSnapshot } from '../../../shared/harness/status'
import type { AddOptionMethod, HarnessDriverKind, InstanceConfigPatch, ProviderAddOption, ProviderScope } from '../../../shared/harness/types'
import { Plus, RefreshCw, Sparkles } from '../../lib/icons'
import { saveModelPrefs, useLegacyFavoritesImport } from '../../lib/modelFavorites'
import {
  DEVICE_SCOPE,
  applySnapshot,
  loadProviderSnapshots,
  modelPrefsByInstance,
  onProviderListingsChanged,
  operationOutcome,
  projectScope,
  removeSnapshot,
  sortInstances,
  useProviderSnapshots,
  useProviderSnapshotsStore,
  useRunningOperation
} from '../../lib/providerSnapshots'
import { useAppStore } from '../../stores/appStore'
import { Select } from '../ui/Select'
import { AddProviderDialog, type AddProviderHandlers } from './AddProviderDialog'
import { ApiSetupRow } from './ApiSections'
import type { InstanceActions } from './CliSections'
import { MoveNotice } from './MoveProviderDialog'
import { AgentEditor, ApiEditor } from './ProviderEditor'
import { ProviderListRow, errorText, useAsyncAction, useRelativeTime } from './parts'
import { formatVersion, iconIdOf, isApiInstance, lastCheckedAt, modelsFreshness, switchStateOf, usedByLabel } from './providerView'
import { SignInDialog } from './SignInDialog'
import '../../styles/providers.css'

export interface ProvidersSettingsProps {
  settings: MousseSettings
  refreshProviderData: () => Promise<{ opts: SettingsOptions }>
  updateSettings: (partial: MousseSettingsUpdate) => Promise<void>
  ensureValidProviderSelection: (next: MousseSettings, providers?: LlmProviderOption[]) => Promise<MousseSettings>
}

/** The scope last chosen on this page, kept while the app runs. */
let lastScopeId = ''

/** The catalog less the models hidden in Settings, as the pickers offer it. */
function withoutHiddenModels(providers: LlmProviderOption[]): LlmProviderOption[] {
  const prefs = modelPrefsByInstance(useProviderSnapshotsStore.getState().scopes.device?.snapshots)
  return providers
    .map((provider) => {
      const hidden = provider.instanceId ? prefs.get(provider.instanceId)?.hidden : undefined
      return hidden?.size ? { ...provider, models: provider.models.filter((model) => !hidden.has(model.id)) } : provider
    })
    .filter((provider) => provider.models.length > 0)
}

/** How a model API entry signs in again: by its saved credential, else by its Add option's first method. */
function apiMethodOf(snapshot: InstanceSnapshot, option: ProviderAddOption | undefined): AddOptionMethod | undefined {
  const credential = snapshot.auth.credential
  if (credential === 'subscription') return 'oauth'
  if (credential === 'ambient') return 'ambient'
  if (credential === 'api_key') return 'api_key'
  return option?.methods[0]
}

/** What Remove does to the entry's credential, which pi-ai keeps for every profile on this device. */
function apiRemoveHint(name: string, method: AddOptionMethod | undefined, retired: boolean): string {
  if (method === 'ambient') return `Removes ${name}. Your cloud credentials stay as they are.`
  if (method === 'oauth' || retired) return `Removes ${name} and signs it out. Other profiles on this device that use this sign-in lose it too.`
  return `Removes ${name} and deletes its saved key. Other profiles on this device that use the key lose it too.`
}

/**
 * Settings → Providers: a provider list beside the selected
 * instance's editor. Everything shown comes from the daemon's instance snapshots for the chosen
 * scope (this device, or a project's overrides); every change goes through `providers.instances`.
 */
export function ProvidersSettings({ settings, refreshProviderData, updateSettings, ensureValidProviderSelection }: ProvidersSettingsProps) {
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const projects = useAppStore((state) => state.projects)

  /** '' is this device; otherwise a project id. A removed project falls back to the device. */
  const [chosenScopeId, setChosenScopeId] = useState(lastScopeId)
  const scopeId = chosenScopeId && projects.some((project) => project.id === chosenScopeId) ? chosenScopeId : ''
  const setScopeId = (next: string) => {
    lastScopeId = next
    setChosenScopeId(next)
  }
  const scope: ProviderScope = projectScope(scopeId || null)
  const { snapshots, error: loadError, loading, reload } = useProviderSnapshots(scope)
  const { snapshots: deviceSnapshots } = useProviderSnapshots(DEVICE_SCOPE)
  useLegacyFavoritesImport()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [addOptions, setAddOptions] = useState<ProviderAddOption[]>([])
  const [signIn, setSignIn] = useState<{ operationId: string; name: string } | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  /** Something a finished action wants the user to know (files kept after a remove). */
  const [pageNotice, setPageNotice] = useState<string | null>(null)
  const refreshing = useAsyncAction()
  const refreshingModels = useAsyncAction()

  // What Add provider offers for model APIs, and how each one signs in; a change to any entry may change `added`.
  const loadAddOptions = useCallback(async () => {
    setAddOptions(await window.mousse.providers.catalog.addOptions())
  }, [])
  useEffect(() => {
    void loadAddOptions().catch(() => {})
    return onProviderListingsChanged(() => void loadAddOptions().catch(() => {}))
  }, [loadAddOptions])

  // A failed install or update reports here; a failed sign-in stays in its dialog. A sign-in that
  // finished with a warning (its old sign-in still waits to be revoked) says so here once its
  // dialog has closed.
  useEffect(
    () =>
      useProviderSnapshotsStore.subscribe((state, previous) => {
        for (const event of Object.values(state.operations)) {
          if (previous.operations[event.operationId] === event) continue
          if (event.phase === 'completed' && event.kind === 'sign_in' && event.warning) setPageNotice(event.warning)
          if (event.phase !== 'failed' || event.kind === 'sign_in') continue
          setPageError(event.error.message)
        }
      }),
    []
  )

  const sorted = sortInstances(snapshots ?? [])
  const selected = sorted.find((snapshot) => snapshot.instanceId === selectedId) ?? sorted[0] ?? null
  const operation = useRunningOperation(selected?.instanceId ?? '')

  /** Keep the default model on an instance that is still on, and on a model it still offers. */
  const reconcileSelection = async () => {
    const { opts } = await refreshProviderData()
    const current = settingsRef.current
    const next = await ensureValidProviderSelection(current, withoutHiddenModels(opts.llmProviders))
    const { instanceId, llmProvider, model } = next.provider
    if (instanceId === current.provider.instanceId && llmProvider === current.provider.llmProvider && model === current.provider.model) return
    await updateSettings({ provider: { ...(instanceId ? { instanceId } : {}), llmProvider, model } })
  }

  const guard = async (action: () => Promise<void>) => {
    setPageError(null)
    setPageNotice(null)
    try {
      await action()
    } catch (error) {
      setPageError(errorText(error))
    }
  }

  /**
   * Starts the instance's sign-in and waits for its outcome. A browser sign-in or a guided key shows
   * its prompts in the sign-in dialog; the environment's credentials are only checked.
   */
  const runSignIn = async (instanceId: string, name: string, method: AddOptionMethod) => {
    const started = await window.mousse.providers.instances.signIn(instanceId, method)
    if (method !== 'ambient') setSignIn({ operationId: started.operationId, name })
    const outcome = await operationOutcome(started)
    if (outcome.phase === 'failed') throw new Error(outcome.error.message || (method === 'ambient' ? 'Could not verify the credentials.' : 'Sign-in failed.'))
    if (outcome.phase === 'cancelled') throw new Error('Sign-in was cancelled.')
  }

  const setEnabled = async (snapshot: InstanceSnapshot, target: ProviderScope, enabled: boolean | null) => {
    applySnapshot(await window.mousse.providers.instances.setEnabled(snapshot.instanceId, target, enabled))
    if (target.kind === 'device') await reconcileSelection()
  }

  const actionsFor = (snapshot: InstanceSnapshot): InstanceActions => {
    const { instances } = window.mousse.providers
    const id = snapshot.instanceId
    return {
      // Off on the device is a ceiling: turning on starts there, a project override only narrows.
      enable: () => setEnabled(snapshot, snapshot.enabled.device ? scope : DEVICE_SCOPE, true),
      install: async () => {
        await instances.install(id)
      },
      cancelInstall: async (operationId) => {
        await instances.cancelInstall(operationId)
      },
      update: async () => {
        await instances.update(id)
      },
      signIn: async () => {
        const started = await instances.signIn(id)
        setSignIn({ operationId: started.operationId, name: snapshot.displayName })
      },
      signOut: async () => applySnapshot(await instances.signOut(id)),
      recheck: async () => applySnapshot(await instances.recheck(id)),
      allowKnownProblem: async (version) => applySnapshot(await instances.allowKnownProblem(id, version)),
      configure: async (patch) => applySnapshot(await instances.configure(id, patch)),
      removeInstall: (force) => instances.removeInstall(id, force)
    }
  }

  const refreshModels = (snapshot: InstanceSnapshot) => async () =>
    applySnapshot(await window.mousse.providers.instances.refreshModels(snapshot.instanceId))

  /** The header's refresh: checks every instance again. */
  const refreshStatus = () =>
    void refreshing.run('refresh', async () => {
      if (!snapshots) return reload()
      const results = await Promise.allSettled(sorted.map((snapshot) => window.mousse.providers.instances.recheck(snapshot.instanceId)))
      for (const result of results) if (result.status === 'fulfilled') applySnapshot(result.value)
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
    })

  /**
   * The header's "Refresh models": every enabled provider's list, in one call. A provider that is
   * not signed in or has a chat running is left alone; one that fails is named with the reason.
   */
  const refreshAllModels = () =>
    void refreshingModels.run('models', async () => {
      const results = await window.mousse.providers.instances.refreshAllModels()
      for (const result of results) applySnapshot(result.snapshot)
      const failed = results.filter((result) => result.outcome === 'failed')
      if (failed.length)
        throw new Error(`Could not refresh models: ${failed.map((result) => `${result.snapshot.displayName} (${result.message ?? 'failed'})`).join('; ')}`)
    })

  const addHandlers: AddProviderHandlers = {
    add: async (driver: HarnessDriverKind, config: InstanceConfigPatch, slug?: string) => {
      const snapshot = await window.mousse.providers.instances.add({ driver, config, ...(slug ? { slug } : {}) })
      applySnapshot(snapshot)
      void loadProviderSnapshots(DEVICE_SCOPE)
      if (scope.kind === 'project') void reload()
      return snapshot.instanceId
    },
    // Add (idempotent: a retry after a failed sign-in finds the entry), then the pasted key or the
    // sign-in. A credential saved on this device already (by another profile) needs neither. Cloud
    // credentials are checked before the entry is added, so a failed check adds nothing.
    connectApi: async (option, method, apiKey) => {
      const { instances } = window.mousse.providers
      const ambient = method === 'ambient' && !option.hasSavedKey
      const added = await instances.add(ambient ? { ...option.add, signIn: 'ambient' } : option.add)
      applySnapshot(added)
      if (method === 'api_key' && apiKey) applySnapshot(await instances.setSecret(added.instanceId, apiKey))
      else if (!ambient && !option.hasSavedKey) await runSignIn(added.instanceId, added.displayName, method)
      await loadAddOptions().catch(() => {})
      await loadProviderSnapshots(DEVICE_SCOPE)
      if (scope.kind === 'project') void reload()
      const instance = useProviderSnapshotsStore.getState().scopes.device?.snapshots?.find((entry) => entry.instanceId === added.instanceId)
      if (instance && !instance.enabled.device) await setEnabled(instance, DEVICE_SCOPE, true)
      else await reconcileSelection()
      return added.instanceId
    }
  }

  const renderEditor = (snapshot: InstanceSnapshot) => {
    const status = describeStatus(snapshot)
    // Hiding a model may hide the default one; move the default to a model that is still offered.
    const onSaveModelPrefs = async (patch: Parameters<typeof saveModelPrefs>[1]) => {
      await saveModelPrefs(snapshot.instanceId, patch)
      if (patch.hidden || patch.hide?.length) await reconcileSelection()
    }
    if (isApiInstance(snapshot)) {
      const { instances } = window.mousse.providers
      const option = addOptions.find((entry) => entry.instanceId === snapshot.instanceId)
      const method = apiMethodOf(snapshot, option)
      const retired = snapshot.nextStep?.action === 'move'
      return (
        <ApiEditor
          snapshot={snapshot}
          removeHint={apiRemoveHint(snapshot.displayName, method, retired)}
          onRemove={async () => {
            await instances.remove(snapshot.instanceId)
            removeSnapshot(snapshot.instanceId)
            setSelectedId(null)
            await reconcileSelection()
          }}
          setup={
            <ApiSetupRow
              label={snapshot.displayName}
              method={method}
              guidedKey={option?.guidedKey === true}
              ambientInstructions={option?.ambientInfo?.instructions}
              status={status}
              retired={retired}
              onReplaceKey={async (apiKey) => {
                if (apiKey) applySnapshot(await instances.setSecret(snapshot.instanceId, apiKey))
                else await runSignIn(snapshot.instanceId, snapshot.displayName, 'api_key')
                await reload()
              }}
              onSignIn={async () => {
                await runSignIn(snapshot.instanceId, snapshot.displayName, 'oauth')
                await reload()
              }}
            />
          }
          banner={<MoveNotice variant="banner" snapshot={snapshot} snapshots={sorted} onMoved={reload} />}
          move={<MoveNotice snapshot={snapshot} snapshots={sorted} onMoved={reload} />}
          onSaveModelPrefs={onSaveModelPrefs}
          onRefreshModels={refreshModels(snapshot)}
        />
      )
    }
    return (
      <AgentEditor
        snapshot={snapshot}
        status={status}
        operation={operation}
        actions={actionsFor(snapshot)}
        onRemove={async ({ deleteFiles }) => {
          const { instances } = window.mousse.providers
          setPageNotice(null)
          // Deleting the files comes first: if it fails, nothing is removed. Files other entries
          // use stay; the entry is removed anyway and the page says why the files are still there.
          const files = deleteFiles ? await instances.removeInstall(snapshot.instanceId) : undefined
          await instances.remove(snapshot.instanceId)
          removeSnapshot(snapshot.instanceId)
          setSelectedId(null)
          if (files && !files.removed) {
            setPageNotice(`The downloaded files of ${snapshot.displayName} stay because other entries use them: ${files.usedBy.map(usedByLabel).join(', ')}.`)
          }
          await reconcileSelection()
        }}
        onSaveModelPrefs={onSaveModelPrefs}
        onRefreshModels={refreshModels(snapshot)}
      />
    )
  }

  const checkedLabel = useRelativeTime(snapshots ? lastCheckedAt(snapshots) : null)
  const scopeOptions = [{ value: '', label: 'This device' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]

  const openAdd = () => {
    setPageError(null)
    setPageNotice(null)
    setAddOpen(true)
    void loadAddOptions().catch(() => {})
  }

  return (
    <div className="prov-page">
      <SignInDialog operationId={signIn?.operationId ?? null} name={signIn?.name ?? ''} onClose={() => setSignIn(null)} />

      <div className="prov-toolbar">
        <span className="prov-scope">
          <span className="prov-scope-label">Applying settings for</span>
          <Select ariaLabel="Settings scope" size="small" value={scopeId} onChange={setScopeId} options={scopeOptions} />
        </span>
        <span className="prov-toolbar-actions">
          <button
            type="button"
            className="prov-ghost-btn"
            title="Refresh provider status"
            aria-busy={refreshing.busy !== null}
            disabled={refreshing.busy !== null}
            onClick={refreshStatus}
          >
            <RefreshCw size={13} className={refreshing.busy ? 'icon-spin' : undefined} />
            <span className="sr-only">Refresh provider status</span>
            <span>{refreshing.busy ? 'Refreshing providers' : checkedLabel ? `Checked ${checkedLabel}` : 'Checking'}</span>
          </button>
          <button
            type="button"
            className="prov-ghost-btn"
            title="Refresh models"
            aria-busy={refreshingModels.busy !== null}
            disabled={refreshingModels.busy !== null}
            onClick={refreshAllModels}
          >
            {refreshingModels.busy ? <RefreshCw size={13} className="icon-spin" /> : <Sparkles size={13} />}
            <span>{refreshingModels.busy ? 'Refreshing models' : 'Refresh models'}</span>
          </button>
        </span>
      </div>
      {scopeId && (
        <p className="prov-scope-note">Switches here apply to this project only. A provider turned off for the device stays off in every project. Setup, runtime, environment and models apply to this device.</p>
      )}
      {(pageError ?? refreshing.error ?? refreshingModels.error) && <p className="prov-error">{pageError ?? refreshing.error ?? refreshingModels.error}</p>}
      {pageNotice && <p className="prov-notice">{pageNotice}</p>}

      {!snapshots ? (
        loadError && !loading ? (
          <div className="prov-load-error">
            <p className="prov-error">Provider status isn&apos;t available: {loadError}</p>
            <button type="button" className="settings-btn" onClick={() => void reload()}>
              Try again
            </button>
          </div>
        ) : (
          <p className="settings-muted prov-empty">Checking providers…</p>
        )
      ) : (
        <div className="prov-pane">
          <div className="prov-pane-list">
            {sorted.map((snapshot) => (
              <ProviderListRow
                key={snapshot.instanceId}
                iconId={iconIdOf(snapshot)}
                name={snapshot.displayName}
                version={formatVersion(snapshot.binary?.version)}
                update={
                  snapshot.update && snapshot.update.kind !== 'notice'
                    ? {
                        label: `Update ${snapshot.displayName}${snapshot.update.latestVersion ? ` to ${formatVersion(snapshot.update.latestVersion)}` : ''}`,
                        // One click where Mousse knows who installed it; otherwise the editor shows the command.
                        onClick:
                          snapshot.update.kind === 'one_click'
                            ? () => guard(() => actionsFor(snapshot).update())
                            : () => setSelectedId(snapshot.instanceId)
                      }
                    : undefined
                }
                status={describeStatus(snapshot)}
                models={modelsFreshness(snapshot)}
                toggle={switchStateOf(snapshot, scope)}
                selected={selected?.instanceId === snapshot.instanceId}
                onSelect={() => setSelectedId(snapshot.instanceId)}
                onToggle={(next) => guard(() => setEnabled(snapshot, scope, next))}
                onReset={scope.kind === 'project' ? () => guard(() => setEnabled(snapshot, scope, null)) : undefined}
              />
            ))}
            <button type="button" className="prov-add-row" onClick={openAdd}>
              <Plus size={16} />
              Add provider
            </button>
          </div>
          <div className="prov-pane-editor">
            {selected ? (
              <div key={selected.instanceId} className="prov-editor">
                {renderEditor(selected)}
              </div>
            ) : (
              <p className="prov-pane-empty">No providers configured.</p>
            )}
          </div>
        </div>
      )}

      <AddProviderDialog
        open={addOpen}
        snapshots={deviceSnapshots ?? []}
        addOptions={addOptions}
        handlers={addHandlers}
        onClose={() => setAddOpen(false)}
        onFinished={setSelectedId}
      />
    </div>
  )
}
