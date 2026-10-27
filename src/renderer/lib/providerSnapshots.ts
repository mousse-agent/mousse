import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import { describeStatus, type InstanceSnapshot, type ProviderSnapshotsEvent, type StatusDescription } from '../../shared/harness/status'
import type { HarnessCaps, HarnessDriverKind, ProviderOperationEvent, ProviderOperationStarted, ProviderScope, SignInPrompt } from '../../shared/harness/types'
import { formatEffortLabel, parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import type { PermissionLimits } from '../../shared/permissionMode'
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

/**
 * The profile binding of this window when a request was made. The window can be bound to another
 * profile without reloading the renderer, so a deferred request or a late reply checks it first.
 */
export interface ProfileBinding {
  readonly profileId: string
  readonly epoch: number
}

let bindingEpoch = 0
let switchingProfiles = 0
useAppStore.subscribe((state, previous) => {
  if (state.profileId !== previous.profileId) bindingEpoch += 1
})

export function currentProfileBinding(): ProfileBinding {
  return { profileId: useAppStore.getState().profileId, epoch: bindingEpoch }
}

/** Still the window's binding: no profile switch since, and none under way. */
export function isCurrentProfileBinding(binding: ProfileBinding): boolean {
  return switchingProfiles === 0 && binding.epoch === bindingEpoch && binding.profileId === useAppStore.getState().profileId
}

/**
 * The window starts binding another profile: requests made before are dropped, and so are those
 * made until the switch ends. Call the returned function when it ends, saying whether it switched.
 */
export function beginProfileSwitch(): (switched: boolean) => void {
  bindingEpoch += 1
  switchingProfiles += 1
  let ended = false
  return (switched) => {
    if (ended) return
    ended = true
    switchingProfiles -= 1
    if (switched) bindingEpoch += 1
  }
}

/**
 * The snapshot a command returned, merged into its scope (it reaches other scopes by event). With
 * the binding the command was sent in, a reply from before a profile switch is dropped.
 */
export function applySnapshot(snapshot: InstanceSnapshot, binding?: ProfileBinding): void {
  if (binding && !isCurrentProfileBinding(binding)) return
  const state = useProviderSnapshotsStore.getState()
  if (state.profileId !== useAppStore.getState().profileId) return
  const key = scopeKey(snapshot.scope)
  const current = state.scopes[key]?.snapshots
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

type FinishedOperation = Extract<ProviderOperationEvent, { phase: 'completed' | 'failed' | 'cancelled' }>

function finished(event: ProviderOperationEvent | undefined): event is FinishedOperation {
  return event?.phase === 'completed' || event?.phase === 'failed' || event?.phase === 'cancelled'
}

/** What a model listing reads from a snapshot: install progress and check times are left out. */
function listingSignature(event: ProviderSnapshotsEvent): string {
  return JSON.stringify(
    event.snapshots.map((snapshot) => [
      snapshot.instanceId,
      snapshot.displayName,
      snapshot.enabled.effective,
      snapshot.auth.state,
      snapshot.install.state,
      snapshot.models.entries.map((model) => [model.id, model.hidden, model.favorite])
    ])
  )
}

/** How long a burst of snapshot events is gathered before listings are read again. */
export const LISTING_RELOAD_DELAY_MS = 250

/**
 * Calls `reload` when what the model listings show may have changed: a snapshots event whose
 * instances, switches, sign-ins, installs or models differ from the last one of its scope. Bursts
 * (a probe per instance, a download's progress) are gathered into one call.
 */
export function onProviderListingsChanged(reload: () => void, delayMs = LISTING_RELOAD_DELAY_MS): () => void {
  const last = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const unsubscribe = window.mousse.providers.onSnapshots((event) => {
    const key = scopeKey(event.scope)
    const signature = listingSignature(event)
    if (last.get(key) === signature) return
    last.set(key, signature)
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      reload()
    }, delayMs)
  })
  return () => {
    if (timer) clearTimeout(timer)
    unsubscribe()
  }
}

/** Operations someone waits on (`operationOutcome`), so a lost connection can end them. */
const awaited = new Map<string, ProviderOperationStarted>()

/**
 * Resolves with the operation's last event once it completed, failed or was cancelled. The event
 * may arrive before the call that started the operation returned, so the store is read first. An
 * operation the service can no longer finish (it restarted, or the profile switched) ends as failed.
 */
export function operationOutcome(started: ProviderOperationStarted): Promise<FinishedOperation> {
  ensureListening()
  const { operationId } = started
  const current = useProviderSnapshotsStore.getState().operations[operationId]
  if (finished(current)) return Promise.resolve(current)
  awaited.set(operationId, started)
  return new Promise((resolve) => {
    const unsubscribe = useProviderSnapshotsStore.subscribe((state) => {
      const event = state.operations[operationId]
      if (!finished(event)) return
      unsubscribe()
      awaited.delete(operationId)
      resolve(event)
    })
  })
}

/**
 * Ends every running or awaited operation as failed: the service that ran them restarted (its
 * operations are gone), or the window moved to another profile. Their dialogs stop waiting.
 */
export function failRunningOperations(message: string): void {
  const { operations } = useProviderSnapshotsStore.getState()
  const running = new Map<string, ProviderOperationStarted>(awaited)
  for (const event of Object.values(operations)) {
    if (event.phase === 'progress' || event.phase === 'prompt') running.set(event.operationId, event)
  }
  for (const { operationId, instanceId, kind } of running.values()) {
    applyOperationEvent({ operationId, instanceId, kind, phase: 'failed', error: { code: 'protocol', message, instanceId } })
  }
}

function ensureListening(): void {
  if (listening || typeof window === 'undefined' || !window.mousse?.providers?.onSnapshots) return
  listening = true
  window.mousse.providers.onSnapshots(applySnapshotsEvent)
  window.mousse.providers.onOperation(applyOperationEvent)
  window.mousse.providers.onServiceRestarted?.(() => failRunningOperations('The connection to the Mousse service was lost. Start the sign-in again.'))
}

function ensureProfile(profileId: string): void {
  if (useProviderSnapshotsStore.getState().profileId === profileId) return
  // Operations of the other profile are not reported here any more: whoever waits on one stops.
  failRunningOperations('The profile changed before the sign-in finished.')
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
export type ProviderWithStatus = LlmProviderOption & { caps?: HarnessCaps; permissionLimits?: PermissionLimits; status?: StatusDescription }

/** A picker entry: one provider instance and its visible models, with what the daemon reports. */
export interface PickerProvider extends LlmProviderOption {
  instanceId?: string
  /** The `llmProvider` name a selection on this instance stores. */
  llmProvider: string
  caps?: HarnessCaps
  permissionLimits?: PermissionLimits
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
  // Drivers without a legacy name (`''`) are named by their instance.
  return legacyProviderForInstance(snapshot.instanceId, snapshot) || snapshot.instanceId
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

/**
 * Mousse's provider order, the same on the providers page and in every model picker. A data
 * table: model APIs (many instances of one driver) sort by name, agents keep their seeded order.
 */
const DRIVER_ORDER: Record<HarnessDriverKind, { rank: number; byName: boolean }> = {
  claude: { rank: 0, byName: false },
  codex: { rank: 1, byName: false },
  antigravity: { rank: 2, byName: false },
  cursor: { rank: 3, byName: true },
  grok: { rank: 4, byName: true },
  acp: { rank: 5, byName: true },
  pi: { rank: 6, byName: true }
}

/**
 * Instances in display order: agents by driver (Claude Code, Codex, Antigravity), each seeded
 * instance before the accounts added after it, then model APIs by name.
 */
export function sortInstances<T extends Pick<InstanceSnapshot, 'driver' | 'builtIn' | 'displayName'>>(snapshots: readonly T[]): T[] {
  return snapshots
    .map((snapshot, index) => ({ snapshot, index }))
    .sort((a, b) => {
      const order = DRIVER_ORDER[a.snapshot.driver]
      const byDriver = order.rank - DRIVER_ORDER[b.snapshot.driver].rank
      if (byDriver !== 0) return byDriver
      if (order.byName) return a.snapshot.displayName.localeCompare(b.snapshot.displayName, undefined, { sensitivity: 'base' })
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
      ...(snapshot.permissionLimits ? { permissionLimits: snapshot.permissionLimits } : {}),
      status: describeStatus(snapshot)
    })
  }
  return providers
}

/**
 * The name an instance lists a model under, hidden models included, from the snapshots of any
 * scope on hand. `providerId` is a picker id or provider name; `instanceId`, when known, decides.
 * The effort an id carries (`haiku:low`) is not part of the name. Undefined when none lists it.
 */
export function knownModelLabel(selection: { providerId: string; instanceId?: string }, modelId: string): string | undefined {
  if (!modelId) return undefined
  const { baseId } = parseThinkingSuffixFromModelId(modelId)
  for (const scope of Object.values(useProviderSnapshotsStore.getState().scopes)) {
    for (const snapshot of scope.snapshots ?? []) {
      const serves = selection.instanceId
        ? snapshot.instanceId === selection.instanceId
        : pickerIdOf(snapshot) === selection.providerId || llmProviderOf(snapshot) === selection.providerId
      if (!serves) continue
      const entries = snapshot.models.entries
      const model = entries.find((entry) => entry.id === modelId) ?? entries.find((entry) => entry.id === baseId)
      if (model?.label) return model.label
    }
  }
  return undefined
}

/** Claude's model families, which Claude Code lists without the brand ("Sonnet 5.5"). */
const CLAUDE_FAMILY = /^(?:claude[- ])?(opus|sonnet|haiku|fable)(?:[- ](\d+)(?:[-.](\d{1,2}))?(?![\d.]))?/i

/** A name for a model no loaded list names: "claude-haiku-5-5" → "Claude Haiku 5.5", "sonnet" → "Claude Sonnet". */
function modelNameFromId(baseId: string): string {
  const claude = CLAUDE_FAMILY.exec(baseId)
  if (!claude) return baseId
  const family = claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1).toLowerCase()
  const version = claude[2] ? ` ${claude[2]}${claude[3] ? `.${claude[3]}` : ''}` : ''
  return `Claude ${family}${version}`
}

/**
 * A model as a transcript names it: its listed name with the brand, and the effort its id carries
 * ("Claude Haiku 4.5 · Low"). Without a loaded list the name comes from the id itself.
 */
export function modelDisplayName(providerId: string, modelId: string): string {
  const { baseId, effort } = parseThinkingSuffixFromModelId(modelId)
  const label = knownModelLabel({ providerId }, modelId)
  const name = !label ? modelNameFromId(baseId) : CLAUDE_FAMILY.test(label) && !/^claude/i.test(label) ? `Claude ${label}` : label
  return effort ? `${name} · ${formatEffortLabel(effort)}` : name
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
 * Instance badges: where two picker entries share a logo (two Claude Code accounts), every
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
