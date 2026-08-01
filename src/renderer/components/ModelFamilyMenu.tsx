import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { ChevronRight, Search, Star } from 'lucide-react'
import type { LlmProviderOption } from '../../shared/settings'
import {
  compareModelsNewestFirst,
  groupProviderModels,
  parseModelVariant,
  parseThinkingSuffixFromModelId,
  resolveModelVariant,
  type ModelFamily
} from '../../shared/modelVariants'
import { ProviderIcon } from '../lib/providerIcons'
import { FloatingPortal, useFloatingPosition } from '../lib/floatingLayer'
import {
  favoriteKey,
  loadModelFavorites,
  toggleModelFavorite,
  type ModelFavoriteKey
} from '../lib/modelFavorites'

interface ModelFamilyMenuProps {
  providers: LlmProviderOption[]
  selectedProviderId: string
  selectedModelId: string
  onSelect: (providerId: string, modelId: string) => void
  onMenuScroll?: (event: React.UIEvent<HTMLElement>) => void
  emptyState?: React.ReactNode
  /** Anchor for fixed/portal positioning (avoids overflow clipping). */
  anchorRef?: RefObject<HTMLElement | null>
  /** Optional ref to the floating shell (outside-click handling). */
  contentRef?: RefObject<HTMLDivElement | null>
}

interface FlatModelEntry {
  providerId: string
  providerLabel: string
  family: ModelFamily
  brandId: string
  brandLabel: string
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

  const applyOption = (patch: { context?: string; speed?: string }) => {
    const resolved = resolveModelVariant(family, {
      context: patch.context ?? context,
      effort,
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

      {family.speeds.length > 0 && (
        <div className="model-family-variant-section">
          <div className="model-family-variant-heading">Speed</div>
          <div className="model-family-variant-options">
            {family.speeds.map((option) => (
              <button
                key={option}
                type="button"
                className={`model-family-variant-chip${speed === option ? ' selected' : ''}`}
                onClick={() => applyOption({ speed: option })}
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

export function ModelFamilyMenu({
  providers,
  selectedProviderId,
  selectedModelId,
  onSelect,
  onMenuScroll,
  emptyState,
  anchorRef,
  contentRef
}: ModelFamilyMenuProps) {
  const groupedProviders = useMemo(
    () => providers.map((provider) => groupProviderModels(provider.id, provider.label, provider.models)),
    [providers]
  )

  const allEntries = useMemo((): FlatModelEntry[] => {
    const entries: FlatModelEntry[] = []
    for (const provider of groupedProviders) {
      for (const family of provider.families) {
        entries.push({
          providerId: provider.providerId,
          providerLabel: provider.label,
          family,
          brandId: family.brandId,
          brandLabel: family.brandLabel,
          key: favoriteKey(provider.providerId, family.familyId)
        })
      }
    }
    return entries
  }, [groupedProviders])

  const railItems = useMemo(() => {
    // Prefer brand filters when any multi-vendor catalog is present; otherwise provider filters.
    const multiBrand = groupedProviders.some((provider) => provider.brandSections.length > 1)
    if (multiBrand) {
      const seen = new Map<string, { id: string; label: string }>()
      for (const entry of allEntries) {
        if (!seen.has(entry.brandId)) {
          seen.set(entry.brandId, { id: entry.brandId, label: entry.brandLabel })
        }
      }
      return [...seen.values()]
    }
    return groupedProviders.map((provider) => ({
      id: provider.providerId,
      label: provider.label
    }))
  }, [allEntries, groupedProviders])

  const [favorites, setFavorites] = useState<Set<ModelFavoriteKey>>(() => loadModelFavorites())
  const [searchQuery, setSearchQuery] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [railFilter, setRailFilter] = useState<string | null>(null)
  const [highlightIndex, setHighlightIndex] = useState(0)
  const [activeFamily, setActiveFamily] = useState<{
    providerId: string
    family: ModelFamily
  } | null>(null)
  const [panelTop, setPanelTop] = useState(0)
  const [panelSide, setPanelSide] = useState<'right' | 'left'>('right')

  const localShellRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
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

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    const multiBrand = groupedProviders.some((provider) => provider.brandSections.length > 1)

    const list = allEntries.filter((entry) => {
      if (favoritesOnly && !favorites.has(entry.key)) return false
      if (railFilter) {
        const matchesRail = multiBrand
          ? entry.brandId === railFilter
          : entry.providerId === railFilter
        if (!matchesRail) return false
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

    // Newest versions first (e.g. GPT 5.6 above GPT 5.5 / older catalog order).
    return [...list].sort((a, b) => {
      const aKey = `${a.family.familyLabel} ${a.family.variants[0]?.id ?? ''}`
      const bKey = `${b.family.familyLabel} ${b.family.variants[0]?.id ?? ''}`
      return compareModelsNewestFirst(aKey, bKey)
    })
  }, [allEntries, favorites, favoritesOnly, groupedProviders, railFilter, searchQuery])

  useEffect(() => {
    setHighlightIndex(0)
  }, [searchQuery, railFilter, favoritesOnly, filteredEntries.length])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus()
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
      if (resolved) onSelect(entry.providerId, resolved.id)
    },
    [onSelect, preferredEffort, selectedModelId]
  )

  const handleToggleFavorite = (key: ModelFavoriteKey, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setFavorites((current) => toggleModelFavorite(current, key))
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') return

      const mod = event.ctrlKey || event.metaKey
      if (mod && !event.altKey && !event.shiftKey) {
        const digit = Number(event.key)
        if (digit >= 1 && digit <= 5) {
          const entry = filteredEntries[digit - 1]
          if (entry) {
            event.preventDefault()
            selectEntry(entry)
          }
          return
        }
      }

      if (isEditableTarget(event.target) && event.target !== searchInputRef.current) {
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlightIndex((index) =>
          filteredEntries.length === 0 ? 0 : Math.min(index + 1, filteredEntries.length - 1)
        )
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
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

  useEffect(() => {
    const row = menuRef.current?.querySelector<HTMLElement>(
      `[data-model-index="${highlightIndex}"]`
    )
    row?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex])

  const handleMenuScroll = (event: React.UIEvent<HTMLElement>) => {
    onMenuScroll?.(event)
    syncPanelPosition()
  }

  if (providers.length === 0) {
    return <>{emptyState}</>
  }

  const renderEntry = (entry: FlatModelEntry, index: number) => {
    const selected =
      entry.providerId === selectedProviderId && isFamilySelected(entry.family, selectedModelId)
    const isFavorite = favorites.has(entry.key)
    const shortcut = index < 5 ? `Ctrl+${index + 1}` : null
    const isHighlighted = index === highlightIndex
    const isActive =
      activeFamily?.providerId === entry.providerId &&
      activeFamily.family.familyId === entry.family.familyId

    const openVariantPanel = (element: HTMLElement) => {
      if (!entry.family.hasSubOptions) {
        clearHideTimer()
        activeRowRef.current = null
        setActiveFamily(null)
        return
      }
      clearHideTimer()
      activeRowRef.current = element
      setActiveFamily({ providerId: entry.providerId, family: entry.family })
    }

    return (
      <div
        key={entry.key}
        data-model-index={index}
        className={`model-picker-row${isActive ? ' active' : ''}${isHighlighted ? ' highlighted' : ''}${
          selected ? ' selected' : ''
        }`}
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
          onClick={() => selectEntry(entry)}
        >
          <span className="model-picker-row-icon">
            <ProviderIcon providerId={entry.brandId} size={16} />
          </span>
          <span className="model-picker-row-text">
            <span className="model-picker-row-title">{entry.family.familyLabel}</span>
            <span className="model-picker-row-subtitle">
              <ProviderIcon providerId={entry.brandId} size={10} />
              <span>{entry.brandLabel}</span>
            </span>
          </span>
          {entry.family.hasSubOptions ? (
            <ChevronRight size={12} className="model-picker-row-chevron" />
          ) : null}
          {shortcut ? <span className="model-picker-shortcut">{shortcut}</span> : null}
        </button>
        <button
          type="button"
          className={`model-picker-star${isFavorite ? ' active' : ''}`}
          aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          title={isFavorite ? 'Unfavorite' : 'Favorite'}
          onClick={(event) => handleToggleFavorite(entry.key, event)}
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
          <div className="model-picker-search-field">
            <Search size={14} className="model-picker-search-icon" aria-hidden />
            <input
              ref={searchInputRef}
              type="search"
              className="model-picker-search-input"
              placeholder="Search models..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              aria-label="Search models"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="model-picker-body">
          {railItems.length > 1 ? (
            <div className="model-picker-rail" role="tablist" aria-label="Filter by provider">
              <button
                type="button"
                role="tab"
                aria-selected={railFilter === null}
                className={`model-picker-rail-item${railFilter === null ? ' selected' : ''}`}
                title="All models"
                onClick={() => setRailFilter(null)}
              >
                <span className="model-picker-rail-all">All</span>
              </button>
              {railItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={railFilter === item.id}
                  className={`model-picker-rail-item${railFilter === item.id ? ' selected' : ''}`}
                  title={item.label}
                  onClick={() => setRailFilter((current) => (current === item.id ? null : item.id))}
                >
                  <ProviderIcon providerId={item.id} size={16} />
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

      {activeFamily?.family.hasSubOptions && (
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
            onSelect={(modelId) => onSelect(activeFamily.providerId, modelId)}
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

export function getGroupedModelButtonLabel(
  providerId: string,
  modelId: string,
  providers: LlmProviderOption[]
): string {
  if (!providerId) return 'Select model'
  const provider = providers.find((entry) => entry.id === providerId)
  const { baseId } = parseThinkingSuffixFromModelId(modelId)
  const model =
    provider?.models.find((entry) => entry.id === modelId) ??
    provider?.models.find((entry) => entry.id === baseId)
  if (!model) return modelId || provider?.label || 'Select model'

  const parsed = parseModelVariant(model)
  const bits = [parsed.familyLabel]
  if (parsed.context) bits.push(parsed.context)
  if (parsed.speed) bits.push(parsed.speed)
  return bits.join(' · ')
}
