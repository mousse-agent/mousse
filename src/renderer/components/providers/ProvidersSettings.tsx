import { useCallback, useEffect, useRef, useState } from 'react'
import type { LlmProviderOption, MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../../../shared/settings'
import type { ProviderLoginOption, ProviderLoginResult } from '../../../shared/providerAuth'
import { describeStatus, type InstanceSnapshot } from '../../../shared/harness/status'
import type { HarnessDriverKind, InstanceConfigPatch, ProviderScope } from '../../../shared/harness/types'
import { piProviderIdOf } from '../../../shared/providerInstances'
import { Plus, RefreshCw } from '../../lib/icons'
import { saveModelPrefs, useLegacyFavoritesImport } from '../../lib/modelFavorites'
import {
  DEVICE_SCOPE,
  applySnapshot,
  loadProviderSnapshots,
  projectScope,
  removeSnapshot,
  useProviderSnapshots,
  useProviderSnapshotsStore,
  useRunningOperation
} from '../../lib/providerSnapshots'
import { useAppStore } from '../../stores/appStore'
import { ProviderLoginModal } from '../ProviderLoginModal'
import { Select } from '../ui/Select'
import { AddProviderDialog, type AddProviderHandlers } from './AddProviderDialog'
import { ApiSetupRow } from './ApiSections'
import type { InstanceActions } from './CliSections'
import { AgentEditor, ApiEditor } from './ProviderEditor'
import { ProviderListRow, errorText, useAsyncAction, useRelativeTime } from './parts'
import { formatVersion, iconIdOf, isApiInstance, lastCheckedAt, sortSnapshots, switchStateOf } from './providerView'
import { SignInDialog } from './SignInDialog'
import '../../styles/providers.css'

export interface ProvidersSettingsProps {
  settings: MousseSettings
  refreshProviderData: () => Promise<{ opts: SettingsOptions }>
  updateSettings: (partial: MousseSettingsUpdate) => Promise<void>
  ensureValidProviderSelection: (next: MousseSettings, providers?: LlmProviderOption[]) => Promise<MousseSettings>
}

function ensureSignedIn(result: ProviderLoginResult, fallback: string): void {
  if (!result.success) throw new Error(result.error ?? fallback)
}

/**
 * Settings → Providers, after T3 Code's providers page: a provider list beside the selected
 * instance's editor. Everything shown comes from the daemon's instance snapshots for the chosen
 * scope (this device, or a project's overrides); every change goes through `providers.instances`.
 */
export function ProvidersSettings({ settings, refreshProviderData, updateSettings, ensureValidProviderSelection }: ProvidersSettingsProps) {
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const projects = useAppStore((state) => state.projects)

  /** '' is this device; otherwise a project id. */
  const [scopeId, setScopeId] = useState('')
  const scope: ProviderScope = projectScope(scopeId || null)
  const { snapshots, error: loadError, loading, reload } = useProviderSnapshots(scope)
  const { snapshots: deviceSnapshots } = useProviderSnapshots(DEVICE_SCOPE)
  useLegacyFavoritesImport()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [loginOptions, setLoginOptions] = useState<ProviderLoginOption[]>([])
  const [loginActive, setLoginActive] = useState(false)
  const [signIn, setSignIn] = useState<{ operationId: string; name: string } | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const refreshing = useAsyncAction()

  // Model APIs still connect through the provider login methods; their options say what is connected.
  const loadLoginOptions = useCallback(async () => {
    setLoginOptions(await window.mousse.providers.getLoginOptions())
  }, [])
  useEffect(() => {
    void loadLoginOptions().catch(() => {})
    return window.mousse.providers.onChanged(() => void loadLoginOptions().catch(() => {}))
  }, [loadLoginOptions])

  // A failed install or update reports here; a failed sign-in stays in its dialog.
  useEffect(
    () =>
      useProviderSnapshotsStore.subscribe((state, previous) => {
        for (const event of Object.values(state.operations)) {
          if (event.phase !== 'failed' || event.kind === 'sign_in' || previous.operations[event.operationId] === event) continue
          setPageError(event.error.message)
        }
      }),
    []
  )

  const sorted = sortSnapshots(snapshots ?? [])
  const selected = sorted.find((snapshot) => snapshot.instanceId === selectedId) ?? sorted[0] ?? null
  const operation = useRunningOperation(selected?.instanceId ?? '')

  /** Keep the default model on an instance that is still on. */
  const reconcileSelection = async () => {
    const { opts } = await refreshProviderData()
    const current = settingsRef.current
    const next = await ensureValidProviderSelection(current, opts.llmProviders)
    if (next.provider.llmProvider === current.provider.llmProvider && next.provider.model === current.provider.model) return
    await updateSettings({ provider: { llmProvider: next.provider.llmProvider, model: next.provider.model } })
  }

  const guard = async (action: () => Promise<void>) => {
    setPageError(null)
    try {
      await action()
    } catch (error) {
      setPageError(errorText(error))
    }
  }

  const runLogin = async (login: () => Promise<ProviderLoginResult>) => {
    setLoginActive(true)
    try {
      return await login()
    } finally {
      setLoginActive(false)
    }
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
      configure: async (patch) => applySnapshot(await instances.configure(id, patch))
    }
  }

  const refreshModels = (snapshot: InstanceSnapshot) => async () =>
    applySnapshot(await window.mousse.providers.instances.refreshModels(snapshot.instanceId))

  /** The header's refresh: check every instance again, as T3 Code's "Refresh provider status". */
  const refreshStatus = () =>
    void refreshing.run('refresh', async () => {
      if (!snapshots) return reload()
      const results = await Promise.allSettled(sorted.map((snapshot) => window.mousse.providers.instances.recheck(snapshot.instanceId)))
      for (const result of results) if (result.status === 'fulfilled') applySnapshot(result.value)
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
    })

  const addHandlers: AddProviderHandlers = {
    enable: async (snapshot, binaryPath) => {
      if (binaryPath) applySnapshot(await window.mousse.providers.instances.configure(snapshot.instanceId, { binaryPath }))
      await setEnabled(snapshot, DEVICE_SCOPE, true)
    },
    install: async (snapshot) => {
      if (!snapshot.enabled.device) await setEnabled(snapshot, DEVICE_SCOPE, true)
      await window.mousse.providers.instances.install(snapshot.instanceId)
    },
    add: async (driver: HarnessDriverKind, config: InstanceConfigPatch) => {
      const snapshot = await window.mousse.providers.instances.add({ driver, config })
      applySnapshot(snapshot)
      void loadProviderSnapshots(DEVICE_SCOPE)
      if (scope.kind === 'project') void reload()
      return snapshot.instanceId
    },
    onApiConnected: async (providerId) => {
      await loadLoginOptions().catch(() => {})
      await loadProviderSnapshots(DEVICE_SCOPE)
      if (scope.kind === 'project') void reload()
      const instance = useProviderSnapshotsStore.getState().scopes.device?.snapshots?.find((entry) => piProviderIdOf(entry.instanceId) === providerId)
      if (instance && !instance.enabled.device) await setEnabled(instance, DEVICE_SCOPE, true)
      else await reconcileSelection()
    },
    runLogin
  }

  const renderEditor = (snapshot: InstanceSnapshot) => {
    const status = describeStatus(snapshot)
    const onSaveModelPrefs = (patch: Parameters<typeof saveModelPrefs>[1]) => saveModelPrefs(snapshot.instanceId, patch)
    if (isApiInstance(snapshot)) {
      const providerId = piProviderIdOf(snapshot.instanceId) ?? snapshot.instanceId
      const option =
        loginOptions.find((entry) => entry.id === providerId && entry.configured) ?? loginOptions.find((entry) => entry.id === providerId)
      return (
        <ApiEditor
          snapshot={snapshot}
          removeHint={option?.ambient ? undefined : option?.authType === 'oauth' ? 'Signs out' : 'Deletes the saved key'}
          onRemove={async () => {
            await window.mousse.providers.logout(providerId)
            await reload()
            await reconcileSelection()
          }}
          setup={
            <ApiSetupRow
              providerId={providerId}
              label={snapshot.displayName}
              option={option}
              status={status}
              onReplaceKey={async (apiKey) => {
                if (apiKey) await window.mousse.providers.setApiKey(providerId, apiKey)
                else ensureSignedIn(await runLogin(() => window.mousse.providers.loginApiKey(providerId)), 'API key setup failed.')
                await reload()
              }}
              onSignIn={async () => {
                ensureSignedIn(await runLogin(() => window.mousse.providers.loginOAuth(providerId)), 'Sign-in failed.')
                await reload()
              }}
            />
          }
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
        onRemove={
          snapshot.builtIn
            ? undefined
            : async () => {
                await window.mousse.providers.instances.remove(snapshot.instanceId)
                removeSnapshot(snapshot.instanceId)
                setSelectedId(null)
                await reconcileSelection()
              }
        }
        onSaveModelPrefs={onSaveModelPrefs}
        onRefreshModels={refreshModels(snapshot)}
      />
    )
  }

  const checkedLabel = useRelativeTime(snapshots ? lastCheckedAt(snapshots) : null)
  const scopeOptions = [{ value: '', label: 'This device' }, ...projects.map((project) => ({ value: project.id, label: project.name }))]

  const openAdd = () => {
    setPageError(null)
    setAddOpen(true)
    void loadLoginOptions().catch(() => {})
  }

  return (
    <div className="prov-page">
      <ProviderLoginModal active={loginActive} onClose={() => setLoginActive(false)} />
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
          <button type="button" className="settings-icon-btn" title="Add provider" aria-label="Add provider" onClick={openAdd}>
            <Plus size={14} />
          </button>
        </span>
      </div>
      {scopeId && (
        <p className="prov-scope-note">Switches here apply to this project only. A provider turned off for the device stays off in every project.</p>
      )}
      {(pageError ?? refreshing.error) && <p className="prov-error">{pageError ?? refreshing.error}</p>}

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
                status={describeStatus(snapshot)}
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
        loginOptions={loginOptions}
        handlers={addHandlers}
        onClose={() => setAddOpen(false)}
        onFinished={setSelectedId}
      />
    </div>
  )
}
