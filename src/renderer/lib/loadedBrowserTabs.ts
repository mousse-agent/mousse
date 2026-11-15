/** How many tabs used before the one on screen keep their page loaded. */
export const RECENT_BROWSER_TABS_KEPT = 3

/** Which Browser tabs have a live page. A tab without one shows the same in the tab strip and loads when shown. */
export interface LoadedBrowserTabs {
  /** Tab ids, the most recently used first. */
  readonly recent: readonly string[]
  /** Tabs whose page is loaded. */
  readonly loaded: ReadonlySet<string>
}

export interface LoadedBrowserTabsInput {
  /** Every open tab, in every thread, in the order they were opened. */
  readonly tabIds: readonly string[]
  /** The current thread's tab: the one on screen while the browser shows. */
  readonly activeTabId?: string
  /** The browser is on screen. */
  readonly shown: boolean
  /** Tabs opened since the window started. One counts as used when it opens, so it loads even out of sight. */
  readonly openedThisSession: ReadonlySet<string>
  /** Tabs an agent drives or that play media: they stay loaded however long ago they were used. */
  readonly busy: ReadonlySet<string>
}

export const NO_LOADED_BROWSER_TABS: LoadedBrowserTabs = { recent: [], loaded: new Set() }

/**
 * Keeps loaded the tab on screen, busy tabs, and the three tabs used before the one on screen; every other tab
 * unloads. A tab restored from an earlier session loads the first time it is shown. Applying it twice to the same
 * input changes nothing, so a render may run it again.
 */
export function nextLoadedBrowserTabs(previous: LoadedBrowserTabs, input: LoadedBrowserTabsInput): LoadedBrowserTabs {
  const open = new Set(input.tabIds)
  const known = previous.recent.filter((id) => open.has(id))
  const knownSet = new Set(known)
  const opened = input.tabIds.filter((id) => input.openedThisSession.has(id) && !knownSet.has(id)).reverse()
  let recent = [...opened, ...known]
  const active = input.activeTabId && open.has(input.activeTabId) ? input.activeTabId : undefined
  if (active && input.shown) recent = [active, ...recent.filter((id) => id !== active)]

  const loaded = new Set<string>()
  if (active && (input.shown || previous.loaded.has(active) || input.openedThisSession.has(active))) loaded.add(active)
  for (const id of input.busy) if (open.has(id)) loaded.add(id)
  for (const id of recent.filter((id) => id !== active).slice(0, RECENT_BROWSER_TABS_KEPT)) loaded.add(id)
  return { recent, loaded }
}
