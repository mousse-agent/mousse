import { useRef, type KeyboardEvent } from 'react'

export type UsageTab = 'tokens' | 'cost' | 'limits'

const TABS: ReadonlyArray<{ id: UsageTab; label: string; panel: string }> = [
  { id: 'tokens', label: 'Tokens', panel: 'usage-panel-history' },
  { id: 'cost', label: 'Cost', panel: 'usage-panel-history' },
  { id: 'limits', label: 'Limits', panel: 'usage-panel-limits' }
]
const TAB_KEY = 'mousse.usage.tab'

/** The tab the page opened on last time; Tokens at first. */
export function readUsageTab(): UsageTab {
  try {
    const stored = localStorage.getItem(TAB_KEY)
    return TABS.some((tab) => tab.id === stored) ? stored as UsageTab : 'tokens'
  } catch {
    return 'tokens'
  }
}

export function rememberUsageTab(tab: UsageTab): void {
  try { localStorage.setItem(TAB_KEY, tab) } catch { /* private storage off */ }
}

/** The Usage page's tabs, centred in its header: plain words, the picked one on a soft fill. */
export function UsageTabs({ tab, onTab }: { tab: UsageTab; onTab: (tab: UsageTab) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TABS.length - 1
    const target = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
      : event.key === 'Home' ? 0
      : event.key === 'End' ? last
      : null
    if (target === null) return
    event.preventDefault()
    onTab(TABS[target]!.id)
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[target]?.focus()
  }
  return <div ref={listRef} className="usage-tabs" role="tablist" aria-label="Usage">
    {TABS.map((entry, index) => <button
      key={entry.id}
      type="button"
      role="tab"
      className="usage-tab"
      data-testid={`usage-tab-${entry.id}`}
      aria-selected={entry.id === tab}
      aria-controls={entry.panel}
      tabIndex={entry.id === tab ? 0 : -1}
      onClick={() => onTab(entry.id)}
      onKeyDown={(event) => onKeyDown(event, index)}
    >{entry.label}</button>)}
  </div>
}
