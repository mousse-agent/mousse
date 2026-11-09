import { STORAGE_RULE_COPY } from './storageCopy'

/** The Settings pages, in nav order. */
export const SETTINGS_SECTION_IDS = ['general', 'appearance', 'activity', 'providers', 'agents', 'integrations', 'speech', 'shortcuts', 'connections', 'storage'] as const
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number]

/**
 * One setting the Settings search finds: its title as the page shows it, the page, and the anchor
 * (`anchor` on SettingsRow or SettingsGroup) that Enter focuses. Titles and words only: a search
 * never reads setting values, so nothing secret is indexed.
 */
export interface SettingsSearchEntry {
  title: string
  section: SettingsSectionId
  anchor: string
  /** Other words people search for it by. */
  keywords?: readonly string[]
  /**
   * For a setting the page shows only once something else is set up: the anchor of that prerequisite
   * (where the search lands instead) and the line that says why the setting is not there.
   */
  needs?: { anchor: string; reason: string }
}

/** Every setting the search finds. Rows that exist once per item (a provider, a shortcut, a device) are found by their page. */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  { title: 'Color theme', section: 'appearance', anchor: 'appearance-theme', keywords: ['appearance', 'dark', 'light', 'high contrast'] },
  { title: 'Accent color', section: 'appearance', anchor: 'appearance-accent', keywords: ['colour', 'appearance'] },
  { title: 'Acrylic glass', section: 'appearance', anchor: 'appearance-acrylic', keywords: ['translucent', 'transparent', 'blur', 'window'] },
  { title: 'Glass intensity', section: 'appearance', anchor: 'appearance-glass-intensity', keywords: ['acrylic', 'blur', 'opacity'] },
  { title: 'Frosted composer', section: 'appearance', anchor: 'appearance-frosted-composer', keywords: ['glass', 'blur', 'translucent', 'transparent', 'opacity', 'color boost'] },
  { title: 'Render math', section: 'appearance', anchor: 'appearance-render-math', keywords: ['latex', 'equations'] },
  { title: 'Interface font', section: 'appearance', anchor: 'appearance-interface-font', keywords: ['typeface', 'text', 'google fonts'] },
  { title: 'Code font', section: 'appearance', anchor: 'appearance-code-font', keywords: ['monospace', 'typeface', 'terminal', 'editor'] },
  { title: 'Project colors on threads', section: 'appearance', anchor: 'appearance-project-colors', keywords: ['tint', 'color'] },
  { title: 'Changed files after each turn', section: 'appearance', anchor: 'appearance-turn-changed-files', keywords: ['edits', 'summary', 'diff'] },
  { title: 'Default permission mode', section: 'general', anchor: 'general-permission-mode', keywords: ['permissions', 'approvals', 'ask'] },
  { title: 'Start new threads in a worktree', section: 'general', anchor: 'general-worktree-default', keywords: ['branch', 'chats'] },
  { title: 'Resume after usage limits reset', section: 'general', anchor: 'general-resume', keywords: ['rate limit', 'paused', 'continue'] },
  { title: 'When a thread finishes', section: 'general', anchor: 'general-notify-finished', keywords: ['notifications', 'completion sound', 'toast', 'system notification', 'done'] },
  { title: 'When a thread needs you', section: 'general', anchor: 'general-notify-needs-you', keywords: ['notifications', 'question', 'approval', 'toast', 'sound'] },
  { title: 'When a thread stops', section: 'general', anchor: 'general-notify-stopped', keywords: ['notifications', 'interrupted', 'failed', 'usage limit', 'toast', 'sound'] },
  { title: 'Delete private threads after', section: 'general', anchor: 'general-private-expiry', keywords: ['private', 'expire', 'expiry', 'auto delete', 'timer', 'incognito', 'chats'] },
  { title: 'All threads on my other computers', section: 'general', anchor: 'general-remote-notifications', keywords: ['notifications', 'remote'] },
  { title: 'Version and updates', section: 'general', anchor: 'general-updates', keywords: ['check for updates', 'about', 'upgrade'] },

  { title: 'Mousse ID', section: 'connections', anchor: 'account-mousse-id', keywords: ['sign in', 'login'] },
  { title: 'Phones', section: 'connections', anchor: 'account-phones', keywords: ['mobile', 'pair'], needs: { anchor: 'account-mousse-id', reason: 'Phones appear once you sign in to Mousse ID.' } },
  { title: 'Activity', section: 'activity', anchor: 'account-activity', keywords: ['heatmap', 'line edits'] },
  { title: 'Token usage', section: 'activity', anchor: 'account-token-usage', keywords: ['tokens'] },

  { title: 'Telemetry', section: 'providers', anchor: 'providers-telemetry', keywords: ['privacy', 'tracking'] },
  { title: 'API key', section: 'providers', anchor: 'providers-api-key', keywords: ['key'] },
  { title: 'Executable path', section: 'providers', anchor: 'providers-executable', keywords: ['binary', 'cli'] },
  { title: 'Launch arguments', section: 'providers', anchor: 'providers-arguments', keywords: ['flags', 'args'] },
  { title: 'Variables', section: 'providers', anchor: 'providers-variables', keywords: ['environment', 'env'] },
  { title: 'Display name', section: 'providers', anchor: 'providers-display-name', keywords: ['rename'] },

  { title: 'Default model', section: 'agents', anchor: 'agents-default-model', keywords: ['reasoning', 'effort', 'speed', 'fast'] },
  { title: 'Thread titles', section: 'agents', anchor: 'agents-title-model', keywords: ['title model', 'naming', 'chat titles'] },
  { title: 'Bot model', section: 'agents', anchor: 'agents-bot-model', keywords: ['bot model', 'bots', 'personal bots'] },
  { title: 'Compact context', section: 'agents', anchor: 'agents-context-compaction', keywords: ['compaction', 'tokens', 'summarize'] },
  { title: 'When the cache expires', section: 'agents', anchor: 'agents-idle-compaction', keywords: ['cache', 'idle', 'compact', 'suggest'] },
  { title: 'Agent access', section: 'agents', anchor: 'agents-access', keywords: ['reach beyond their own threads', 'read other threads', 'manage threads', 'access level'] },
  { title: 'Automations agents add', section: 'agents', anchor: 'agents-automations', keywords: ['automations', 'schedule', 'scheduled tasks', 'agent jobs', 'limits', 'allow', 'keep'] },
  { title: 'Agents may answer approvals on other threads', section: 'agents', anchor: 'agents-access-approvals', keywords: ['permissions'] },
  { title: 'Let agents start subagents on your other devices', section: 'agents', anchor: 'agents-remote-subagents', keywords: ['computers', 'remote', 'create subagents on other devices'] },
  { title: 'Give each subagent its own worktree', section: 'agents', anchor: 'agents-subagent-worktrees', keywords: ['experimental', 'branch'] },

  { title: 'Skills', section: 'integrations', anchor: 'integrations-skills' },
  { title: 'MCP servers', section: 'integrations', anchor: 'integrations-mcp', keywords: ['tools'] },
  { title: 'Available to main agent', section: 'integrations', anchor: 'integrations-main-agent', keywords: ['skill defaults'] },
  { title: 'Let other agents use your MCP servers', section: 'integrations', anchor: 'integrations-share', keywords: ['relay', 'mcp', 'share with other agents'] },
  { title: 'Web search', section: 'integrations', anchor: 'integrations-web-search', keywords: ['search tool'] },

  { title: 'Read aloud', section: 'speech', anchor: 'speech-read-aloud', keywords: ['text to speech'] },
  { title: 'Voice', section: 'speech', anchor: 'speech-voice', keywords: ['read aloud'], needs: { anchor: 'speech-read-aloud', reason: 'Voice appears once you choose a read aloud model that has voices.' } },
  { title: 'Speed', section: 'speech', anchor: 'speech-speed', keywords: ['read aloud', 'rate'], needs: { anchor: 'speech-read-aloud', reason: 'Speed appears once you choose a read aloud model.' } },
  { title: 'Dictation', section: 'speech', anchor: 'speech-dictation', keywords: ['microphone', 'speech to text'] },
  { title: 'Reduce background noise', section: 'speech', anchor: 'speech-noise', keywords: ['dictation', 'microphone'], needs: { anchor: 'speech-dictation', reason: 'Reduce background noise appears once you choose a dictation model.' } },
  { title: 'Vocabulary', section: 'speech', anchor: 'speech-vocabulary', keywords: ['dictation', 'names', 'spelling'], needs: { anchor: 'speech-dictation', reason: 'Vocabulary appears once you choose a dictation model that uses it, such as Parakeet.' } },

  { title: 'Device name', section: 'connections', anchor: 'devices-name', keywords: ['computer name'] },
  { title: 'Networking', section: 'connections', anchor: 'devices-networking', keywords: ['network', 'connection'] },
  { title: 'Let other computers work here', section: 'connections', anchor: 'devices-inbound', keywords: ['remote', 'sharing', "let my other computers work on this computer's threads"] },
  { title: 'Passphrase', section: 'connections', anchor: 'devices-passphrase', keywords: ['unlock', 'network keys'] },
  { title: 'My devices', section: 'connections', anchor: 'devices-list', keywords: ['pair', 'add device', 'computers'] },
  { title: 'Let my editor reach my other computers', section: 'connections', anchor: 'devices-editors', keywords: ['editors', 'ssh'] },
  { title: 'Tailscale Serve', section: 'connections', anchor: 'devices-tailscale-serve' },
  { title: 'Connection add-ons', section: 'connections', anchor: 'devices-addons', keywords: ['tunnel', 'relay', 'ssh'] },
  { title: 'Connection checks', section: 'connections', anchor: 'devices-checks', keywords: ['diagnostics', 'features'] },

  { title: 'Disk usage', section: 'storage', anchor: 'storage-usage', keywords: ['space', 'size'] },
  { title: 'Cleanup', section: 'storage', anchor: 'storage-cleanup', keywords: ['clean up', 'free space'] },
  { title: 'Worktree folder', section: 'storage', anchor: 'storage-worktree-folder', keywords: ['drive', 'location'] },
  { title: STORAGE_RULE_COPY.inactive.title, section: 'storage', anchor: 'storage-inactive', keywords: ['cleanup', 'retention'] },
  { title: STORAGE_RULE_COPY.merged.title, section: 'storage', anchor: 'storage-merged', keywords: ['cleanup'] },
  { title: STORAGE_RULE_COPY.captures.title, section: 'storage', anchor: 'storage-captures', keywords: ['browser data', 'screenshots'] }
]

/** Settings that exist only when this build has the Mousse ID service. */
export const MOUSSE_ID_ANCHORS: readonly string[] = ['account-mousse-id', 'account-phones']

/** The settings the search offers: Mousse ID rows only when this build has the service. */
export function searchIndex(mousseIdAvailable: boolean): readonly SettingsSearchEntry[] {
  return mousseIdAvailable ? SETTINGS_SEARCH_INDEX : SETTINGS_SEARCH_INDEX.filter((entry) => !MOUSSE_ID_ANCHORS.includes(entry.anchor))
}

/** The index entry for an anchor, if the search knows it. */
export function settingsSearchEntry(anchor: string): SettingsSearchEntry | undefined {
  return SETTINGS_SEARCH_INDEX.find((entry) => entry.anchor === anchor)
}

/** A page as the search sees it: its name and the words it is found by. */
export interface SettingsSearchPage {
  id: SettingsSectionId
  label: string
  keywords: readonly string[]
}

/** A search result: a setting (with its anchor) or a whole page. */
export interface SettingsSearchResult {
  title: string
  section: SettingsSectionId
  anchor?: string
}

/** How well `text` matches `query`: 3 starts with it, 2 a word starts with it, 1 contains it, 0 not at all. */
function matchScore(text: string, query: string): number {
  const lower = text.toLowerCase()
  if (lower.startsWith(query)) return 3
  if (lower.includes(` ${query}`)) return 2
  return lower.includes(query) ? 1 : 0
}

/**
 * The settings and pages matching `query`, best first: a title match before a keyword match, and a
 * setting before a page at the same strength. Every word of the query must match.
 */
export function searchSettings(query: string, pages: readonly SettingsSearchPage[], index: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX): SettingsSearchResult[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return []
  const words = q.split(' ')
  const pageLabel = new Map(pages.map((page) => [page.id, page.label]))
  const score = (title: string, keywords: readonly string[], context: string): number => {
    const haystack = [title, ...keywords, context].join(' ').toLowerCase()
    if (!words.every((word) => haystack.includes(word))) return 0
    const titled = matchScore(title, q)
    if (titled) return 10 + titled
    return Math.max(1, ...keywords.map((keyword) => matchScore(keyword, q)))
  }
  const scored: Array<SettingsSearchResult & { score: number; order: number }> = []
  index.forEach((entry, order) => {
    if (!pageLabel.has(entry.section)) return
    const value = score(entry.title, entry.keywords ?? [], pageLabel.get(entry.section) ?? '')
    if (value) scored.push({ title: entry.title, section: entry.section, anchor: entry.anchor, score: value + 0.5, order })
  })
  pages.forEach((page, order) => {
    const value = score(page.label, page.keywords, '')
    if (value) scored.push({ title: page.label, section: page.id, score: value, order: index.length + order })
  })
  return scored
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ title, section, anchor }) => (anchor ? { title, section, anchor } : { title, section }))
}

const FOCUSABLE = [
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  'a[href]',
  '[tabindex]:not(:disabled)'
].map((selector) => `${selector}:not([tabindex="-1"])`).join(', ')

/**
 * Brings a search result's setting into view: opens the disclosures around it, scrolls to it and
 * focuses its control (the row itself when the control is disabled). False when it is not on the page.
 */
export function revealSettingsAnchor(root: ParentNode, anchor: string): boolean {
  const target = root.querySelector<HTMLElement>(`[data-settings-anchor="${anchor}"]`)
  if (!target) return false
  for (let details = target.closest('details'); details; details = details.parentElement?.closest('details') ?? null) {
    details.open = true
  }
  const control = target.querySelector(':scope > .settings-item-control')?.querySelector<HTMLElement>(FOCUSABLE)
    ?? target.querySelector<HTMLElement>(FOCUSABLE)
  const focusable = control ?? target
  if (!control && !target.hasAttribute('tabindex')) target.tabIndex = -1
  target.scrollIntoView?.({ block: 'center' })
  focusable.focus({ preventScroll: true })
  return true
}

/** What landing on a search result reports back to the page. */
export interface SettingsAnchorLanding {
  /**
   * The setting is not on the page: `note` says why. `focused` is true when focus went to the
   * prerequisite it needs; otherwise the page should focus the note.
   */
  onMissing(note: string, focused: boolean): void
  /** The setting showed after all, after onMissing: the note can go. */
  onFound(): void
  /** The wait is over, either way. Called once. */
  onDone(): void
}

/** How long the page must stay unchanged before a missing setting counts as not there. */
const ANCHOR_QUIET_MS = 800
/** How long a page that loads its own data may take to show the setting. */
const ANCHOR_WAIT_MS = 3000

/**
 * Lands on a search result's setting in `root`. A page that loads its own data shows the setting
 * later, so this waits for it. Once the page has settled without it, focus goes to what the setting
 * needs (`needs` in the index) and `onMissing` says why; if the setting then shows within the wait,
 * focus moves to it. Returns a function that stops waiting.
 */
export function landOnSettingsAnchor(
  root: HTMLElement,
  anchor: string,
  landing: SettingsAnchorLanding,
  { quietMs = ANCHOR_QUIET_MS, waitMs = ANCHOR_WAIT_MS }: { quietMs?: number; waitMs?: number } = {}
): () => void {
  if (revealSettingsAnchor(root, anchor)) {
    landing.onDone()
    return () => {}
  }
  let missing = false
  let quiet: ReturnType<typeof setTimeout> | undefined
  let wait: ReturnType<typeof setTimeout> | undefined
  const observer = new MutationObserver(() => {
    if (revealSettingsAnchor(root, anchor)) {
      stop()
      if (missing) landing.onFound()
      landing.onDone()
    } else if (!missing) {
      settle()
    }
  })
  const stop = (): void => {
    observer.disconnect()
    clearTimeout(quiet)
    clearTimeout(wait)
  }
  const explain = (): void => {
    if (missing) return
    missing = true
    const entry = settingsSearchEntry(anchor)
    const focused = Boolean(entry?.needs && revealSettingsAnchor(root, entry.needs.anchor))
    landing.onMissing(entry?.needs?.reason ?? `${entry?.title ?? 'This setting'} isn’t on this page right now.`, focused)
  }
  const settle = (): void => {
    clearTimeout(quiet)
    quiet = setTimeout(explain, quietMs)
  }
  observer.observe(root, { childList: true, subtree: true })
  settle()
  wait = setTimeout(() => {
    stop()
    explain()
    landing.onDone()
  }, waitMs)
  return stop
}
