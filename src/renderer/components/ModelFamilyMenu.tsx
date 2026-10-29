import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { ChevronRight, LayoutGrid, Star } from '../lib/icons'
import { SettingsSearch } from './settings/SettingsSearch'
import type { LlmProviderOption } from '../../shared/settings'
import {
  formatEffortLabel,
  getCurrentEffort,
  getEffortsForModel,
  groupProviderModels,
  parseModelVariant,
  parseThinkingSuffixFromModelId,
  resolveModelVariant,
  type ModelFamily
} from '../../shared/modelVariants'
import { ProviderIcon, normalizeProviderId } from '../lib/providerIcons'
import { instanceBadges, knownModelLabel } from '../lib/providerSnapshots'
import { listingKey, listingServes } from '../../shared/providerInstances'
import { useAppStore } from '../stores/appStore'
import { useCommandBindings, useCommandOverlay, useCommands } from '../commands/commandRegistry'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import { favoriteKey, useModelFavorites, type ModelFavoriteKey } from '../lib/modelFavorites'
import type { StatusDescription } from '../../shared/harness/status'
import { formatBinding, type CommandId } from '../../shared/commands'

/** The commands behind Ctrl/Cmd+1-5, in list order. */
const MODEL_PICK_COMMANDS: readonly CommandId[] = ['model.pick1', 'model.pick2', 'model.pick3', 'model.pick4', 'model.pick5']

interface ModelFamilyMenuProps {
  /** `status` (from the instance snapshot) is shown on the rows of a provider that is not ready. */
  providers: Array<LlmProviderOption & { status?: StatusDescription }>
  selectedProviderId: string
  /** The selected instance, when the selection names one; listings of one provider are told apart by it. */
  selectedInstanceId?: string
  selectedModelId: string
  /** `instanceId` is the chosen listing's instance, for a selection that names it. */
  onSelect: (providerId: string, modelId: string, instanceId?: string) => void
  onMenuScroll?: (event: React.UIEvent<HTMLElement>) => void
  emptyState?: React.ReactNode
  /** Anchor for fixed/portal positioning (avoids overflow clipping). */
  anchorRef?: RefObject<HTMLElement | null>
  /** Optional ref to the floating shell (outside-click handling). */
  contentRef?: RefObject<HTMLDivElement | null>
}

interface FlatModelEntry {
  providerId: string
  instanceId?: string
  /** The listing this entry belongs to (`listingKey`): its instance, else its provider. */
  listing: string
  /** The instance's name ("Claude Code 2"), with the model's maker for a multi-brand API. */
  providerLabel: string
  /** The instance's name alone. */
  providerName: string
  /** The model's maker ("DeepSeek") where it is worth naming: a multi-brand API, and not the provider itself. */
  makerLabel?: string
  /** Initials telling apart instances that share a logo (`instanceBadges`). */
  badge?: string
  /** Position of the provider, then of the family in the saved model order. */
  providerRank: number
  familyRank: number
  /** Shown under the model while the provider needs a step (e.g. "Not signed in"). */
  providerStatus?: string
  family: ModelFamily
  brandId: string
  brandLabel: string
  /** The provider lists models from several makers (a multi-brand API). */
  multiBrand: boolean
  key: ModelFavoriteKey
}

function getInitialVariantOptions(
  family: ModelFamily,
  selectedModelId: string,
  preferredEffort?: string
): { context?: string; effort?: string; speed?: string } {
  const { baseId, effort: effortFromId } = parseThinkingSuffixFromModelId(selectedModelId)
  const selected =
    family.variants.find((variant) => variant.id === selectedModelId) ??
    family.variants.find((variant) => variant.id === baseId)

  const effortCandidate = effortFromId ?? preferredEffort
  const effort =
    (effortCandidate && family.efforts.includes(effortCandidate) ? effortCandidate : undefined) ??
    selected?.effort ??
    family.efforts[0]

  if (!selected) {
    return {
      context: family.contexts[0],
      effort,
      speed: family.speeds[0]
    }
  }

  return {
    context: selected.context ?? family.contexts[0],
    effort,
    speed: selected.speed ?? family.speeds[0]
  }
}

function VariantPanel({
  family,
  selectedModelId,
  preferredEffort,
  onSelect
}: {
  family: ModelFamily
  selectedModelId: string
  preferredEffort?: string
  onSelect: (modelId: string) => void
}) {
  const { context, effort, speed } = getInitialVariantOptions(
    family,
    selectedModelId,
    preferredEffort
  )

  const applyOption = (patch: { context?: string; effort?: string; speed?: string }) => {
    const resolved = resolveModelVariant(family, {
      context: patch.context ?? context,
      effort: patch.effort ?? effort,
      speed: patch.speed ?? speed
    })
    if (resolved) onSelect(resolved.id)
  }

  return (
    <div className="model-family-variant-panel" onMouseDown={(event) => event.stopPropagation()}>
      {family.contexts.length > 0 && (
        <div className="model-family-variant-section">
          <div className="model-family-variant-heading">Context</div>
          <div className="model-family-variant-options">
            {family.contexts.map((option) => (
              <button
                key={option}
                type="button"
                className={`model-family-variant-chip${context === option ? ' selected' : ''}`}
                onClick={() => applyOption({ context: option })}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}

function isFamilySelected(family: ModelFamily, selectedModelId: string): boolean {
  const { baseId } = parseThinkingSuffixFromModelId(selectedModelId)
  return (
    family.variants.some((variant) => variant.id === selectedModelId) ||
    family.variants.some((variant) => variant.id === baseId)
  )
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export function ModelFamilyMenu(props: ModelFamilyMenuProps) {
  const profileId = useAppStore((state) => state.profileId)
  return <ProfileModelFamilyMenu key={profileId} {...props} />
}

function ProfileModelFamilyMenu({
  providers,
  selectedProviderId,
  selectedInstanceId,
  selectedModelId,
  onSelect,
  onMenuScroll,
  emptyState,
  anchorRef,
  contentRef
}: ModelFamilyMenuProps) {
  const favorites = useModelFavorites()
  const { hiddenOf } = favorites
  const groupedProviders = useMemo(
    () => {
      // The daemon only returns configured providers, but keep this boundary
      // defensive: duplicate catalog rows must not become duplicate rail tabs.
      // An empty catalog is not an enabled provider for this picker.
      const uniqueProviders = new Map<string, ModelFamilyMenuProps['providers'][number]>()
      for (const listed of providers) {
        // Models hidden in Settings > Providers never reach a picker.
        const hidden = hiddenOf(listed.instanceId)
        const provider = hidden?.size ? { ...listed, models: listed.models.filter((model) => !hidden.has(model.id)) } : listed
        if (provider.models.length === 0) continue
        // Two accounts of one provider are two listings, told apart by their instance.
        const key = listingKey(provider)
        const existing = uniqueProviders.get(key)
        if (!existing) {
          uniqueProviders.set(key, provider)
          continue
        }
        const models = new Map(existing.models.map((model) => [model.id, model]))
        for (const model of provider.models) models.set(model.id, model)
        uniqueProviders.set(key, { ...existing, models: [...models.values()] })
      }
      const listed = [...uniqueProviders.values()]
      const badges = instanceBadges(listed.map((provider) => ({ key: listingKey(provider), iconKey: normalizeProviderId(provider.id), label: provider.label })))
      return listed.map((provider) => {
        const grouped = groupProviderModels(provider.id, provider.label, provider.models)
        // Families follow the saved model order (Settings > Providers), not a newest-first guess.
        const modelRank = new Map(provider.models.map((model, index) => [model.id, index]))
        const rankOf = (family: ModelFamily) =>
          Math.min(
            ...family.variants.map(
              (variant) => modelRank.get(variant.id) ?? modelRank.get(parseThinkingSuffixFromModelId(variant.id).baseId) ?? Number.MAX_SAFE_INTEGER
            )
          )
        return {
          ...grouped,
          familyRanks: new Map(grouped.families.map((family) => [family.familyId, rankOf(family)])),
          multiBrand: new Set(grouped.families.map((family) => family.brandId)).size > 1,
          instanceId: provider.instanceId,
          listing: listingKey(provider),
          badge: badges.get(listingKey(provider)),
          status: provider.status && provider.status.tone !== 'ready' ? provider.status.headline : undefined
        }
      })
    },
    [providers, hiddenOf]
  )

  const allEntries = useMemo((): FlatModelEntry[] => {
    const entries: FlatModelEntry[] = []
    groupedProviders.forEach((provider, providerRank) => {
      for (const family of provider.families) {
        const maker = provider.multiBrand ? makerLabelOf(provider.providerId, provider.label, family) : undefined
        entries.push({
          providerId: provider.providerId,
          instanceId: provider.instanceId,
          listing: provider.listing,
          providerLabel: maker ? `${provider.label} · ${maker}` : provider.label,
          providerName: provider.label,
          makerLabel: maker,
          badge: provider.badge,
          providerRank,
          familyRank: provider.familyRanks.get(family.familyId) ?? Number.MAX_SAFE_INTEGER,
          providerStatus: provider.status,
          family,
          brandId: family.brandId,
          brandLabel: family.brandLabel,
          multiBrand: Boolean(provider.multiBrand),
          key: favoriteKey(provider.instanceId ?? provider.providerId, family.familyId)
        })
      }
    })
    return entries
  }, [groupedProviders])

  const { isFavorite: isProviderFavorite } = favorites
  const isEntryFavorite = useCallback(
    (entry: FlatModelEntry) => isProviderFavorite({ id: entry.providerId, instanceId: entry.instanceId }, entry.family),
    [isProviderFavorite]
  )

  const railItems = useMemo(() => {
    // The rail is a provider filter, never a model-brand/family filter. The
    // catalog above has already removed empty and duplicate provider entries.
    return groupedProviders.map((provider) => ({ key: provider.listing, iconId: provider.providerId, label: provider.label, badge: provider.badge }))
  }, [groupedProviders])

  const [searchQuery, setSearchQuery] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [railFilter, setRailFilter] = useState<string | null>(null)
  const [highlightIndex, setHighlightIndex] = useState(0)
  const [activeFamily, setActiveFamily] = useState<{
    entry: FlatModelEntry
    family: ModelFamily
  } | null>(null)
  const [panelTop, setPanelTop] = useState(0)
  const [panelSide, setPanelSide] = useState<'right' | 'left'>('right')

  const localShellRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const scrollHighlightRef = useRef(true)
  // Mounted only while the picker is open, so it owns the keyboard for as long as it exists.
  useCommandOverlay('model-picker', true)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const variantPanelRef = useRef<HTMLElement>(null)
  const activeRowRef = useRef<HTMLElement | null>(null)
  const hideTimerRef = useRef<number | null>(null)
  const portaled = Boolean(anchorRef)

  const preferredEffort = parseThinkingSuffixFromModelId(selectedModelId).effort

  const setShellNode = useCallback(
    (node: HTMLDivElement | null) => {
      localShellRef.current = node
      if (contentRef) {
        ;(contentRef as React.MutableRefObject<HTMLDivElement | null>).current = node
      }
    },
    [contentRef]
  )

  const floatingStyle = useFloatingPosition({
    open: portaled,
    anchorRef: anchorRef ?? localShellRef,
    contentRef: localShellRef,
    placement: 'above-start',
    deps: [providers.length, activeFamily?.family.familyId, panelSide, searchQuery, railFilter]
  })

  const isEntrySelected = useCallback(
    (entry: FlatModelEntry) =>
      listingServes({ id: entry.providerId, instanceId: entry.instanceId }, { instanceId: selectedInstanceId, llmProvider: selectedProviderId }) &&
      isFamilySelected(entry.family, selectedModelId),
    [selectedInstanceId, selectedProviderId, selectedModelId]
  )

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()

    const list = allEntries.filter((entry) => {
      if (favoritesOnly && !isEntryFavorite(entry)) return false
      if (railFilter) {
        if (entry.listing !== railFilter) return false
      }
      if (!query) return true
      const haystack = [
        entry.family.familyLabel,
        entry.brandLabel,
        entry.providerLabel,
        ...entry.family.variants.map((variant) => variant.id),
        ...entry.family.variants.map((variant) => variant.label)
      ]
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })

    // As in Settings > Providers: favorites first, then providers in their order, then each
    // provider's models in the saved order.
    return sortPickerEntries(list, isEntryFavorite)
  }, [allEntries, isEntryFavorite, favoritesOnly, railFilter, searchQuery])

  useLayoutEffect(() => {
    const selectedIndex = filteredEntries.findIndex((entry) => isEntrySelected(entry))
    scrollHighlightRef.current = true
    setHighlightIndex(Math.max(0, selectedIndex))
  }, [filteredEntries, isEntrySelected])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const syncPanelPosition = useCallback(() => {
    const shell = localShellRef.current
    const row = activeRowRef.current
    const panel = variantPanelRef.current
    const menu = menuRef.current

    if (!shell || !row || !activeFamily) {
      setPanelTop(0)
      return
    }

    const shellRect = shell.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const menuHeight = menu?.offsetHeight ?? shell.offsetHeight
    const panelHeight = panel?.offsetHeight ?? 0
    const panelWidth = panel?.offsetWidth ?? 220

    let top = rowRect.top - shellRect.top
    if (panelHeight > 0) {
      top = Math.max(0, Math.min(top, menuHeight - panelHeight))
    }

    const spaceRight = window.innerWidth - shellRect.right - 8
    setPanelSide(spaceRight >= panelWidth ? 'right' : 'left')
    setPanelTop(top)
  }, [activeFamily])

  useLayoutEffect(() => {
    syncPanelPosition()
    const frame = window.requestAnimationFrame(syncPanelPosition)
    return () => window.cancelAnimationFrame(frame)
  }, [activeFamily, syncPanelPosition])

  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
  }

  const scheduleHide = () => {
    clearHideTimer()
    hideTimerRef.current = window.setTimeout(() => setActiveFamily(null), 180)
  }

  useEffect(() => () => clearHideTimer(), [])

  const selectEntry = useCallback(
    (entry: FlatModelEntry) => {
      const resolved = resolveModelVariant(
        entry.family,
        getInitialVariantOptions(entry.family, selectedModelId, preferredEffort)
      )
      if (resolved) onSelect(entry.providerId, resolved.id, entry.instanceId)
    },
    [onSelect, preferredEffort, selectedModelId]
  )

  const handleToggleFavorite = (entry: FlatModelEntry, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    favorites.toggle({ id: entry.providerId, instanceId: entry.instanceId }, entry.family)
  }

  const bindings = useCommandBindings()
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''

  // Ctrl/Cmd+1-5 pick the nth listed model. The registry runs them while this picker is the topmost
  // overlay; a slot with no model is disabled, so the key goes on to the focused element.
  useCommands(
    MODEL_PICK_COMMANDS.map((id, index) => ({
      id,
      run: () => {
        const entry = filteredEntries[index]
        if (entry) selectEntry(entry)
      },
      enabled: () => Boolean(filteredEntries[index])
    }))
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return

      // Focused controls own their keyboard activation, including effort chips,
      // favorites, provider filters, and model rows.
      if (
        (event.target instanceof HTMLElement && event.target.closest('button')) ||
        (isEditableTarget(event.target) && event.target !== searchInputRef.current)
      ) {
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        scrollHighlightRef.current = true
        setHighlightIndex((index) =>
          filteredEntries.length === 0 ? 0 : Math.min(index + 1, filteredEntries.length - 1)
        )
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        scrollHighlightRef.current = true
        setHighlightIndex((index) => Math.max(index - 1, 0))
        return
      }
      if (event.key === 'Enter') {
        const entry = filteredEntries[highlightIndex]
        if (entry) {
          event.preventDefault()
          selectEntry(entry)
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [filteredEntries, highlightIndex, selectEntry])

  useLayoutEffect(() => {
    if (!scrollHighlightRef.current) return
    scrollHighlightRef.current = false
    const menu = menuRef.current
    const row = menu?.querySelector<HTMLElement>(`[data-model-index="${highlightIndex}"]`)
    if (!menu || !row) return
    const menuRect = menu.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    if (rowRect.top < menuRect.top || rowRect.bottom > menuRect.bottom) {
      menu.scrollTop += rowRect.top - menuRect.top - (menu.clientHeight - rowRect.height) / 2
    }
  }, [highlightIndex, filteredEntries])

  const handleMenuScroll = (event: React.UIEvent<HTMLElement>) => {
    onMenuScroll?.(event)
    syncPanelPosition()
  }

  if (providers.length === 0) {
    return <>{emptyState}</>
  }

  // Rows filtered to one single-maker provider drop the logo and provider line, which would only
  // repeat the selected rail item on every row. A multi-brand API keeps them: the logo is the maker.
  const oneProvider =
    (railFilter !== null || railItems.length <= 1) &&
    filteredEntries.length > 0 &&
    filteredEntries.every((entry) => entry.listing === filteredEntries[0]!.listing)
  const compactRows = oneProvider && filteredEntries.every((entry) => !entry.multiBrand)

  const renderEntry = (entry: FlatModelEntry, index: number) => {
    const selected = isEntrySelected(entry)
    const isFavorite = isEntryFavorite(entry)
    const binding = index < MODEL_PICK_COMMANDS.length ? bindings[MODEL_PICK_COMMANDS[index]] : null
    const shortcut = binding ? formatBinding(binding, platform) : null
    const isHighlighted = index === highlightIndex
    const subtitle = modelRowSubtitle(entry, oneProvider)
    const isActive =
      activeFamily?.entry.listing === entry.listing &&
      activeFamily.family.familyId === entry.family.familyId

    const openVariantPanel = (element: HTMLElement) => {
      if (!(entry.family.contexts.length > 1)) {
        clearHideTimer()
        activeRowRef.current = null
        setActiveFamily(null)
        return
      }
      clearHideTimer()
      activeRowRef.current = element
      setActiveFamily({ entry, family: entry.family })
    }

    return (
      <div
        key={entry.key}
        data-model-index={index}
        className={`model-picker-row${compactRows ? ' compact' : ''}${!compactRows && !subtitle && !entry.providerStatus ? ' bare' : ''}${isActive ? ' active' : ''}${
          isHighlighted ? ' highlighted' : ''
        }${selected ? ' selected' : ''}`}
        onMouseEnter={(event) => {
          setHighlightIndex(index)
          openVariantPanel(event.currentTarget)
        }}
        onMouseLeave={scheduleHide}
      >
        <button
          type="button"
          role="option"
          aria-selected={selected}
          className="model-picker-row-main"
          title={[entry.family.familyLabel, entry.providerLabel, entry.providerStatus].filter(Boolean).join(' · ')}
          onFocus={(event) => {
            setHighlightIndex(index)
            openVariantPanel(event.currentTarget.parentElement!)
          }}
          onClick={() => selectEntry(entry)}
        >
          {compactRows ? null : (
            <span className="model-picker-row-icon">
              <ProviderIcon providerId={entry.brandId === 'anthropic' ? 'claude' : entry.brandId} size={16} />
              {entry.badge ? <span className="model-picker-instance-badge" aria-hidden="true">{entry.badge}</span> : null}
            </span>
          )}
          <span className="model-picker-row-text">
            <span className="model-picker-row-title">{entry.family.familyLabel}</span>
            {!subtitle && !entry.providerStatus ? null : (
              <span className="model-picker-row-subtitle">
                {subtitle ? <span className="model-picker-row-provider">{subtitle}</span> : null}
                {entry.providerStatus ? <span className="model-picker-row-status">{entry.providerStatus}</span> : null}
              </span>
            )}
          </span>
          {(entry.family.contexts.length > 1) ? (
            <ChevronRight size={12} className="model-picker-row-chevron" />
          ) : null}
          {shortcut ? <span className="model-picker-shortcut">{shortcut}</span> : null}
        </button>
        <button
          type="button"
          className={`model-picker-star${isFavorite ? ' active' : ''}`}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          title={isFavorite ? 'Unfavorite' : 'Favorite'}
          onClick={(event) => handleToggleFavorite(entry, event)}
        >
          <Star size={14} strokeWidth={2} fill={isFavorite ? 'currentColor' : 'none'} />
        </button>
      </div>
    )
  }

  const shell = (
    <div
      className={`composer-model-picker-shell model-picker-shell${
        portaled ? ' composer-model-picker-shell-floating' : ''
      }`}
      ref={setShellNode}
      style={portaled ? floatingStyle : undefined}
    >
      <div className="model-picker-panel">
        <div className="model-picker-search">
          <button
            type="button"
            className={`model-picker-favorites-toggle${favoritesOnly ? ' active' : ''}`}
            aria-pressed={favoritesOnly}
            aria-label={favoritesOnly ? 'Show all models' : 'Show favorites only'}
            title={favoritesOnly ? 'Show all models' : 'Show favorites only'}
            onClick={() => setFavoritesOnly((value) => !value)}
          >
            <Star size={14} strokeWidth={2} fill={favoritesOnly ? 'currentColor' : 'none'} />
          </button>
          <SettingsSearch
            className="model-picker-search-field"
            inputRef={searchInputRef}
            placeholder="Search models"
            ariaLabel="Search models"
            value={searchQuery}
            onChange={setSearchQuery}
          />
        </div>

        <div className="model-picker-body">
          {railItems.length > 1 ? (
            <div
              className="model-picker-rail"
              role="tablist"
              aria-label="Filter by provider"
              data-tooltip-placement="outside-left"
            >
              <button
                type="button"
                role="tab"
                aria-selected={railFilter === null}
                className={`model-picker-rail-item${railFilter === null ? ' selected' : ''}`}
                title="All models"
                onClick={() => setRailFilter(null)}
              >
                <LayoutGrid size={16} className="model-picker-rail-all" aria-hidden />
              </button>
              {railItems.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={railFilter === item.key}
                  className={`model-picker-rail-item${railFilter === item.key ? ' selected' : ''}`}
                  title={item.label}
                  aria-label={item.label}
                  onClick={() => setRailFilter((current) => (current === item.key ? null : item.key))}
                >
                  <ProviderIcon providerId={item.iconId} size={16} />
                  {item.badge ? <span className="model-picker-instance-badge" aria-hidden="true">{item.badge}</span> : null}
                </button>
              ))}
            </div>
          ) : null}

          <div
            ref={menuRef}
            className="composer-model-menu model-picker-list scrollbar-ultra-thin"
            role="listbox"
            aria-label="Select model"
            onScroll={handleMenuScroll}
          >
            {filteredEntries.length === 0 ? (
              <div className="model-picker-empty">
                {favoritesOnly ? 'No favorite models yet.' : 'No models match your search.'}
              </div>
            ) : (
              filteredEntries.map((entry, index) => renderEntry(entry, index))
            )}
          </div>
        </div>
      </div>

      {(activeFamily && activeFamily.family.contexts.length > 1) && (
        <aside
          ref={variantPanelRef}
          className={`composer-model-variant-panel composer-model-variant-panel-${panelSide}`}
          style={{ top: panelTop }}
          onMouseEnter={clearHideTimer}
          onMouseLeave={scheduleHide}
        >
          <VariantPanel
            family={activeFamily.family}
            selectedModelId={selectedModelId}
            preferredEffort={preferredEffort}
            onSelect={(modelId) => onSelect(activeFamily.entry.providerId, modelId, activeFamily.entry.instanceId)}
          />
        </aside>
      )}
    </div>
  )

  if (portaled) {
    return <FloatingPortal>{shell}</FloatingPortal>
  }

  return shell
}

/** Brand ids that are the provider's own, so naming them would only repeat the provider. */
function sameMaker(providerId: string, providerLabel: string, family: Pick<ModelFamily, 'brandId' | 'brandLabel'>): boolean {
  const provider = normalizeProviderId(providerId)
  const brand = normalizeProviderId(family.brandId)
  return (
    brand === provider ||
    (provider === 'claude' && brand === 'anthropic') ||
    family.brandLabel.trim().toLowerCase() === providerLabel.trim().toLowerCase()
  )
}

/**
 * The maker to name under a model of a multi-brand API: its display name ("DeepSeek"), never a raw
 * id ("vercel-ai-gateway", which is all the catalog knows for an unrecognised model), and not the
 * provider itself.
 */
export function makerLabelOf(
  providerId: string,
  providerLabel: string,
  family: Pick<ModelFamily, 'brandId' | 'brandLabel'>
): string | undefined {
  if (family.brandLabel === family.brandId || family.brandId === 'other') return undefined
  return sameMaker(providerId, providerLabel, family) ? undefined : family.brandLabel
}

/**
 * The line under a model's name. In a list of one provider the provider is already the selected rail
 * item, so only the maker is named; across providers the provider stays so the same model from two of
 * them can be told apart.
 */
export function modelRowSubtitle(entry: { providerName: string; makerLabel?: string }, oneProvider: boolean): string | undefined {
  if (oneProvider) return entry.makerLabel
  return [entry.providerName, entry.makerLabel].filter(Boolean).join(' · ')
}

/** Favorites first, then by provider, then by the provider's saved model order. */
export function sortPickerEntries<T extends { providerRank: number; familyRank: number }>(entries: readonly T[], isFavorite: (entry: T) => boolean): T[] {
  return entries
    .map((entry, index) => ({ entry, index, favorite: isFavorite(entry) }))
    .sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.entry.providerRank - b.entry.providerRank || a.entry.familyRank - b.entry.familyRank || a.index - b.index)
    .map(({ entry }) => entry)
}

export function getGroupedModelButtonParts(
  providerId: string,
  modelId: string,
  providers: LlmProviderOption[],
  includeEffort = true,
  /** The selection's instance: picks the right listing when one provider has several. */
  instanceId?: string
): string[] {
  if (!providerId) return ['Select model']
  const provider = providers.find((entry) => listingServes(entry, { instanceId, llmProvider: providerId }))
  const { baseId } = parseThinkingSuffixFromModelId(modelId)
  const model =
    provider?.models.find((entry) => entry.id === modelId) ??
    provider?.models.find((entry) => entry.id === baseId)
  if (!provider || !model) {
    // A model the picker does not offer (hidden, or its provider is off) keeps its listed name.
    const known = knownModelLabel({ providerId, instanceId }, modelId)
    if (known) {
      const parsed = parseModelVariant({ id: baseId, label: known })
      return parsed.context ? [parsed.familyLabel, parsed.context] : [parsed.familyLabel]
    }
    return [modelId || provider?.label || 'Select model']
  }

  const parsed = parseModelVariant(model)
  const bits = [parsed.familyLabel]
  if (parsed.context) bits.push(parsed.context)
  const effort = getCurrentEffort(modelId, provider.models, providerId)
  if (includeEffort && effort && getEffortsForModel(providerId, modelId, provider.models).length > 0) {
    bits.push(formatEffortLabel(effort))
  }
  return bits
}
