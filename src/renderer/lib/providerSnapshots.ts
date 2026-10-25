import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import { describeStatus, type InstanceSnapshot, type ProviderSnapshotsEvent, type StatusDescription } from '../../shared/harness/status'
import type { HarnessCaps, HarnessDriverKind, ProviderOperationEvent, ProviderScope, SignInPrompt } from '../../shared/harness/types'
import { legacyProviderForInstance } from '../../shared/providerInstances'
import type { LlmModelOption, LlmProviderOption } from '../../shared/settings'
import { useAppStore } from '../stores/appStore'
import { ipcErrorLine } from './errorText'

/**
 * Provider instance snapshots as the daemon reports them (`providers.snapshots`), kept per scope
 * and updated from `providers.onSnapshots`. The providers page, the composer picker and the model
 * menus all read status, capabilities and model preferences from here; nothing in the renderer
 * works out a provider's status on its own.
 */

export const DEVICE_SCOPE: ProviderScope = { kind: 'device' }

/** The scope a thread works in: its project's overrides, or the device when it has none. */
export function projectScope(projectId: string | null | undefined): ProviderScope {
  return projectId ? { kind: 'project', projectId } : DEVICE_SCOPE
}

export function scopeKey(scope: ProviderScope): string {
  return scope.kind === 'device' ? 'device' : `project:${scope.projectId}`
}

interface ScopeState {
  snapshots?: InstanceSnapshot[]
  error?: string
  loading: boolean
}

interface ProviderSnapshotsState {
  /** Snapshots belong to one profile; switching profiles starts over. */
  profileId: string | null
  scopes: Record<string, ScopeState>
  /** The latest event of each provider operation, by operation id. */
  operations: Record<string, ProviderOperationEvent>
  /** The latest sign-in step each operation asked for (progress events do not replace it). */
  prompts: Record<string, SignInPrompt>
}

export const useProviderSnapshotsStore = create<ProviderSnapshotsState>(() => ({ profileId: null, scopes: {}, operations: {}, prompts: {} }))

const scopesByKey = new Map<string, ProviderScope>()
let listening = false

function setScope(key: string, patch: Partial<ScopeState>): void {
  useProviderSnapshotsStore.setState((state) => ({
    scopes: { ...state.scopes, [key]: { ...(state.scopes[key] ?? { loading: false }), ...patch } }
  }))
}

/** Fetches the snapshots of `scope`; a failure keeps the last snapshots and records the error. */
export async function loadProviderSnapshots(scope: ProviderScope): Promise<void> {
  const key = scopeKey(scope)
  scopesByKey.set(key, scope)
  setScope(key, { loading: true })
  try {
    const snapshots = await window.mousse.providers.snapshots(scope)
    setScope(key, { snapshots, error: undefined, loading: false })
  } catch (error) {
    setScope(key, { error: ipcErrorLine(error) || String(error), loading: false })
  }
}

/** A pushed change: take it for its scope, and refetch the other scopes on screen. */
export function applySnapshotsEvent(event: ProviderSnapshotsEvent): void {
  const key = scopeKey(event.scope)
  scopesByKey.set(key, event.scope)
  setScope(key, { snapshots: event.snapshots, error: undefined })
  for (const [other, state] of Object.entries(useProviderSnapshotsStore.getState().scopes)) {
    const scope = scopesByKey.get(other)
    if (other !== key && scope && state.snapshots && !state.loading) void loadProviderSnapshots(scope)
  }
}

/** The snapshot a command returned, merged into its scope (it reaches other scopes by event). */
export function applySnapshot(snapshot: InstanceSnapshot): void {
  const key = scopeKey(snapshot.scope)
  const current = useProviderSnapshotsStore.getState().scopes[key]?.snapshots
  if (!current) return
  const index = current.findIndex((entry) => entry.instanceId === snapshot.instanceId)
  const next = index < 0 ? [...current, snapshot] : current.map((entry, at) => (at === index ? snapshot : entry))
  setScope(key, { snapshots: next })
}

export function removeSnapshot(instanceId: string): void {
  useProviderSnapshotsStore.setState((state) => ({
    scopes: Object.fromEntries(
      Object.entries(state.scopes).map(([key, value]) => [
        key,
        value.snapshots ? { ...value, snapshots: value.snapshots.filter((entry) => entry.instanceId !== instanceId) } : value
      ])
    )
  }))
}

export function applyOperationEvent(event: ProviderOperationEvent): void {
  useProviderSnapshotsStore.setState((state) => ({
    operations: { ...state.operations, [event.operationId]: event },
    prompts: event.phase === 'prompt' ? { ...state.prompts, [event.operationId]: event.prompt } : state.prompts
  }))
}

export function clearOperation(operationId: string): void {
  useProviderSnapshotsStore.setState((state) => {
    const operations = { ...state.operations }
    const prompts = { ...state.prompts }
    delete operations[operationId]
    delete prompts[operationId]
    return { operations, prompts }
  })
}

function ensureListening(): void {
  if (listening || typeof window === 'undefined' || !window.mousse?.providers?.onSnapshots) return
  listening = true
  window.mousse.providers.onSnapshots(applySnapshotsEvent)
  window.mousse.providers.onOperation(applyOperationEvent)
}

function ensureProfile(profileId: string): void {
  if (useProviderSnapshotsStore.getState().profileId === profileId) return
  scopesByKey.clear()
  useProviderSnapshotsStore.setState({ profileId, scopes: {}, operations: {}, prompts: {} })
}

export interface ProviderSnapshotsView {
  /** Undefined until the first load finishes (or when it failed and there is nothing older). */
  snapshots: InstanceSnapshot[] | undefined
  error: string | undefined
  loading: boolean
  reload: () => Promise<void>
}

/** The snapshots of `scope`, loaded on first use and kept current by pushed changes. */
export function useProviderSnapshots(scope: ProviderScope): ProviderSnapshotsView {
  const profileId = useAppStore((state) => state.profileId)
  const key = scopeKey(scope)
  const state = useProviderSnapshotsStore((store) => (store.profileId === profileId ? store.scopes[key] : undefined))
  const projectId = scope.kind === 'project' ? scope.projectId : undefined
  const reload = useCallback(() => loadProviderSnapshots(projectScope(projectId)), [projectId])
  useEffect(() => {
    ensureProfile(profileId)
    ensureListening()
    const current = useProviderSnapshotsStore.getState().scopes[key]
    if (!current?.snapshots && !current?.loading) void reload()
  }, [profileId, key, reload])
  return { snapshots: state?.snapshots, error: state?.error, loading: state?.loading ?? true, reload }
}

/** An operation of the instance that is still running (progress or waiting on a prompt). */
export function useRunningOperation(instanceId: string): ProviderOperationEvent | undefined {
  return useProviderSnapshotsStore((store) =>
    Object.values(store.operations).find((event) => event.instanceId === instanceId && (event.phase === 'progress' || event.phase === 'prompt'))
  )
}

// ---------------------------------------------------------------------------------------------
// Model pickers

/** A catalog entry with what the instance's snapshot reports, when there is one. */
export type ProviderWithStatus = LlmProviderOption & { caps?: HarnessCaps; status?: StatusDescription }

/** A picker entry: one provider instance and its visible models, with what the daemon reports. */
export interface PickerProvider extends LlmProviderOption {
  instanceId?: string
  /** The `llmProvider` name a selection on this instance stores. */
  llmProvider: string
  caps?: HarnessCaps
  status?: StatusDescription
}

/** The context gauge shows unless the instance reports no context usage (never a made-up figure). */
export function showsContextGauge(provider: ProviderWithStatus | undefined): boolean {
  return provider?.caps?.contextUsage !== 'none'
}

/**
 * The `llmProvider` name for an instance. Seeded instances keep the picker id they always had
 * (`claude-subscription`, `codex`, a pi-ai provider id), so stored favorites and selections still
 * match; added instances are told apart by their instance id.
 */
export function llmProviderOf(snapshot: Pick<InstanceSnapshot, 'instanceId' | 'driver'>): string {
  return legacyProviderForInstance(snapshot.instanceId, snapshot) ?? snapshot.instanceId
}

export function pickerIdOf(snapshot: Pick<InstanceSnapshot, 'instanceId' | 'driver' | 'builtIn'>): string {
  return snapshot.builtIn ? llmProviderOf(snapshot) : snapshot.instanceId
}

function pickerModel(model: InstanceSnapshot['models']['entries'][number], catalog: LlmModelOption | undefined): LlmModelOption {
  const efforts = model.capabilities.efforts.length > 0 ? model.capabilities.efforts : catalog?.efforts
  return {
    id: model.id,
    label: model.label,
    ...(efforts && efforts.length > 0 ? { efforts } : {}),
    ...(catalog?.speed ? { speed: catalog.speed } : {})
  }
}

/** Mousse's provider order, the same on the providers page and in every model picker. */
const DRIVER_ORDER: Record<HarnessDriverKind, number> = { claude: 0, codex: 1, antigravity: 2, pi: 3 }

/**
 * Instances in display order: agents by driver (Claude Code, Codex, Antigravity), each seeded
 * instance before the accounts added after it, then model APIs by name.
 */
export function sortInstances<T extends Pick<InstanceSnapshot, 'driver' | 'builtIn' | 'displayName'>>(snapshots: readonly T[]): T[] {
  return snapshots
    .map((snapshot, index) => ({ snapshot, index }))
    .sort((a, b) => {
      const byDriver = DRIVER_ORDER[a.snapshot.driver] - DRIVER_ORDER[b.snapshot.driver]
      if (byDriver !== 0) return byDriver
      if (a.snapshot.driver === 'pi') return a.snapshot.displayName.localeCompare(b.snapshot.displayName, undefined, { sensitivity: 'base' })
      if (a.snapshot.builtIn !== b.snapshot.builtIn) return a.snapshot.builtIn ? -1 : 1
      return a.index - b.index
    })
    .map((entry) => entry.snapshot)
}

/**
 * The composer picker's providers: every instance switched on in the scope, in display order, with
 * its models less the hidden ones in the saved order. Before the first snapshot arrives (or when the daemon cannot report one) the
 * daemon's catalog is shown as it is.
 */
export function pickerProviders(snapshots: readonly InstanceSnapshot[] | undefined, catalog: readonly LlmProviderOption[]): PickerProvider[] {
  if (!snapshots) return catalog.map((provider) => ({ ...provider, llmProvider: provider.id }))
  const providers: PickerProvider[] = []
  for (const snapshot of sortInstances(snapshots)) {
    if (!snapshot.enabled.effective) continue
    const listed = catalog.find((provider) => provider.instanceId === snapshot.instanceId)
    const models = snapshot.models.entries
      .filter((model) => !model.hidden)
      .map((model) => pickerModel(model, listed?.models.find((entry) => entry.id === model.id)))
    if (models.length === 0) continue
    providers.push({
      id: pickerIdOf(snapshot),
      instanceId: snapshot.instanceId,
      llmProvider: llmProviderOf(snapshot),
      label: snapshot.displayName,
      models,
      caps: snapshot.caps,
      status: describeStatus(snapshot)
    })
  }
  return providers
}

/** The picker entry a stored selection names: by instance first, then by its provider name. */
export function pickerIdFor(selection: { instanceId?: string; llmProvider: string }, providers: readonly PickerProvider[]): string {
  if (selection.instanceId) {
    const byInstance = providers.find((provider) => provider.instanceId === selection.instanceId)
    if (byInstance) return byInstance.id
  }
  return selection.llmProvider
}

/** Model ids hidden or starred per instance, from device snapshots (prefs are not per project). */
export function modelPrefsByInstance(snapshots: readonly InstanceSnapshot[] | undefined): Map<string, { hidden: Set<string>; favorites: Set<string> }> {
  const prefs = new Map<string, { hidden: Set<string>; favorites: Set<string> }>()
  for (const snapshot of snapshots ?? []) {
    prefs.set(snapshot.instanceId, {
      hidden: new Set(snapshot.models.entries.filter((model) => model.hidden).map((model) => model.id)),
      favorites: new Set(snapshot.models.entries.filter((model) => model.favorite).map((model) => model.id))
    })
  }
  return prefs
}

/** Initials for a name: "Work" → "W", "Personal Max" → "PM", "2" → "2". */
function initials(words: readonly string[]): string {
  if (words.length === 1 && /^\d+$/.test(words[0]!)) return words[0]!.slice(0, 2)
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? '')
    .join('')
}

/**
 * T3 Code's instance badge: where two picker entries share a logo (two Claude Code accounts), every
 * entry after the first gets a small badge with what sets its name apart ("Claude Code 2" → "2").
 * Keyed by entry key; entries with a logo of their own get none.
 */
export function instanceBadges(entries: ReadonlyArray<{ key: string; iconKey: string; label: string }>): Map<string, string> {
  const badges = new Map<string, string>()
  const firstByIcon = new Map<string, string>()
  for (const entry of entries) {
    const first = firstByIcon.get(entry.iconKey)
    if (first === undefined) {
      firstByIcon.set(entry.iconKey, entry.label)
      continue
    }
    const words = entry.label.trim().split(/\s+/u).filter(Boolean)
    const shared = new Set(first.trim().toLowerCase().split(/\s+/u))
    const distinct = words.filter((word) => !shared.has(word.toLowerCase()))
    const badge = initials(distinct.length > 0 ? distinct : words)
    if (badge) badges.set(entry.key, badge)
  }
  return badges
}
