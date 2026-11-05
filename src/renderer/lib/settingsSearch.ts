import { STORAGE_RULE_COPY } from './storageCopy'

/** The Settings pages, in nav order. */
export const SETTINGS_SECTION_IDS = ['general', 'account', 'providers', 'agents', 'integrations', 'speech', 'shortcuts', 'connections', 'storage'] as const
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
}

/** Every setting the search finds. Rows that exist once per item (a provider, a shortcut, a device) are found by their page. */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  { title: 'Color theme', section: 'general', anchor: 'general-theme', keywords: ['appearance', 'dark', 'light', 'high contrast'] },
  { title: 'Accent color', section: 'general', anchor: 'general-accent', keywords: ['colour', 'appearance'] },
  { title: 'Acrylic glass', section: 'general', anchor: 'general-acrylic', keywords: ['translucent', 'transparent', 'blur', 'window'] },
  { title: 'Glass intensity', section: 'general', anchor: 'general-glass-intensity', keywords: ['acrylic', 'blur', 'opacity'] },
  { title: 'Render math', section: 'general', anchor: 'general-render-math', keywords: ['latex', 'equations'] },
  { title: 'Default permission mode', section: 'general', anchor: 'general-permission-mode', keywords: ['permissions', 'approvals', 'ask'] },
  { title: 'Start new chats in a worktree', section: 'general', anchor: 'general-worktree-default', keywords: ['branch'] },
  { title: 'Resume after usage limits reset', section: 'general', anchor: 'general-resume', keywords: ['rate limit', 'paused', 'continue'] },
  { title: 'Completion sound', section: 'general', anchor: 'general-completion-sound', keywords: ['notifications', 'alert', 'notification sound'] },
  { title: 'All threads on my other computers', section: 'general', anchor: 'general-remote-notifications', keywords: ['notifications', 'remote'] },
  { title: 'Version and updates', section: 'general', anchor: 'general-updates', keywords: ['check for updates', 'about', 'upgrade'] },

  { title: 'Mousse ID', section: 'account', anchor: 'account-mousse-id', keywords: ['sign in', 'login'] },
  { title: 'Phones', section: 'account', anchor: 'account-phones', keywords: ['mobile', 'pair'] },
  { title: 'Activity', section: 'account', anchor: 'account-activity', keywords: ['heatmap', 'line edits'] },
  { title: 'Token usage', section: 'account', anchor: 'account-token-usage', keywords: ['tokens'] },

  { title: 'Telemetry', section: 'providers', anchor: 'providers-telemetry', keywords: ['privacy', 'tracking'] },
  { title: 'API key', section: 'providers', anchor: 'providers-api-key', keywords: ['key'] },
  { title: 'Executable path', section: 'providers', anchor: 'providers-executable', keywords: ['binary', 'cli'] },
  { title: 'Launch arguments', section: 'providers', anchor: 'providers-arguments', keywords: ['flags', 'args'] },
  { title: 'Variables', section: 'providers', anchor: 'providers-variables', keywords: ['environment', 'env'] },
  { title: 'Account home', section: 'providers', anchor: 'providers-home', keywords: ['config folder'] },
  { title: 'Display name', section: 'providers', anchor: 'providers-display-name', keywords: ['rename'] },

  { title: 'Default model', section: 'agents', anchor: 'agents-default-model', keywords: ['reasoning', 'effort', 'speed', 'fast'] },
  { title: 'Chat titles', section: 'agents', anchor: 'agents-title-model', keywords: ['title model', 'naming'] },
  { title: 'Compact context', section: 'agents', anchor: 'agents-context-compaction', keywords: ['compaction', 'tokens', 'summarize'] },
  { title: 'Agent access', section: 'agents', anchor: 'agents-access', keywords: ['reach beyond their own threads', 'read other threads', 'manage threads', 'access level'] },
  { title: 'Agents may answer approvals on other threads', section: 'agents', anchor: 'agents-access-approvals', keywords: ['permissions'] },
  { title: 'Allow agents to create Subagents on other Devices', section: 'agents', anchor: 'agents-remote-subagents', keywords: ['computers', 'remote'] },
  { title: 'Give each subagent its own worktree', section: 'agents', anchor: 'agents-subagent-worktrees', keywords: ['experimental', 'branch'] },

  { title: 'Skills', section: 'integrations', anchor: 'integrations-skills' },
  { title: 'MCP servers', section: 'integrations', anchor: 'integrations-mcp', keywords: ['tools'] },
  { title: 'Available to main agent', section: 'integrations', anchor: 'integrations-main-agent', keywords: ['skill defaults'] },
  { title: 'Share with other agents', section: 'integrations', anchor: 'integrations-share', keywords: ['relay', 'mcp'] },
  { title: 'Web search', section: 'integrations', anchor: 'integrations-web-search', keywords: ['search tool'] },

  { title: 'Read aloud', section: 'speech', anchor: 'speech-read-aloud', keywords: ['text to speech'] },
  { title: 'Voice', section: 'speech', anchor: 'speech-voice', keywords: ['read aloud'] },
  { title: 'Speed', section: 'speech', anchor: 'speech-speed', keywords: ['read aloud', 'rate'] },
  { title: 'Dictation', section: 'speech', anchor: 'speech-dictation', keywords: ['microphone', 'speech to text'] },
  { title: 'Reduce background noise', section: 'speech', anchor: 'speech-noise', keywords: ['dictation', 'microphone'] },
  { title: 'Vocabulary', section: 'speech', anchor: 'speech-vocabulary', keywords: ['dictation', 'names', 'spelling'] },

  { title: 'Device name', section: 'connections', anchor: 'devices-name', keywords: ['computer name'] },
  { title: 'Networking', section: 'connections', anchor: 'devices-networking', keywords: ['network', 'connection'] },
  { title: "Let my other computers work on this computer's threads", section: 'connections', anchor: 'devices-inbound', keywords: ['remote', 'sharing'] },
  { title: 'Passphrase', section: 'connections', anchor: 'devices-passphrase', keywords: ['unlock', 'network keys'] },
  { title: 'My devices', section: 'connections', anchor: 'devices-list', keywords: ['pair', 'add device', 'computers'] },
  { title: 'Let my editor reach my other computers', section: 'connections', anchor: 'devices-editors', keywords: ['editors', 'ssh'] },
  { title: 'Tailscale Serve', section: 'connections', anchor: 'devices-tailscale-serve' },
  { title: 'Connection add-ons', section: 'connections', anchor: 'devices-addons', keywords: ['tunnel', 'relay', 'ssh'] },
  { title: 'Connection checks', section: 'connections', anchor: 'devices-checks', keywords: ['diagnostics', 'features'] },

  { title: 'Disk usage', section: 'storage', anchor: 'storage-usage', keywords: ['space', 'size'] },
  { title: 'Cleanup', section: 'storage', anchor: 'storage-cleanup', keywords: ['clean up', 'free space'] },
  { title: STORAGE_RULE_COPY.trash.title, section: 'storage', anchor: 'storage-trash', keywords: ['trash', 'purge', 'retention'] },
  { title: 'Worktree folder', section: 'storage', anchor: 'storage-worktree-folder', keywords: ['drive', 'location'] },
  { title: STORAGE_RULE_COPY.deletedThreads.title, section: 'storage', anchor: 'storage-deleted-threads', keywords: ['cleanup'] },
  { title: STORAGE_RULE_COPY.inactive.title, section: 'storage', anchor: 'storage-inactive', keywords: ['cleanup', 'retention'] },
  { title: STORAGE_RULE_COPY.merged.title, section: 'storage', anchor: 'storage-merged', keywords: ['cleanup'] },
  { title: STORAGE_RULE_COPY.captures.title, section: 'storage', anchor: 'storage-captures', keywords: ['browser data', 'screenshots'] }
]

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
