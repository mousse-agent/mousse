import { Activity, Gauge } from '../lib/icons'
import { PillTabs, type PillTab } from './ui/PillTabs'

export type UsageTab = 'history' | 'limits'

const TABS: ReadonlyArray<PillTab<UsageTab>> = [
  { id: 'history', label: 'History', icon: Activity },
  { id: 'limits', label: 'Limits', icon: Gauge }
]
const TAB_KEY = 'mousse.usage.tab'

/** The tab the page opened on last time; History at first. */
export function readUsageTab(): UsageTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'limits' ? 'limits' : 'history'
  } catch {
    return 'history'
  }
}

export function rememberUsageTab(tab: UsageTab): void {
  try { localStorage.setItem(TAB_KEY, tab) } catch { /* private storage off */ }
}

/** The Usage page's tabs, centred in its header, in the app's pill tab bar. Panels are `usage-<tab>-panel`. */
export function UsageTabs({ tab, onTab }: { tab: UsageTab; onTab: (tab: UsageTab) => void }) {
  return <PillTabs tabs={TABS} value={tab} onSelect={onTab} ariaLabel="Usage" idPrefix="usage" className="usage-tabs" />
}
