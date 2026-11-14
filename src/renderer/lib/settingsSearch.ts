import { MOUSSE_BUILTIN_TOOL_GROUPS, MOUSSE_BUILTIN_TOOLS } from '../../shared/integrations'
import { COMMANDS_IN_DISPLAY_ORDER } from '../../shared/commands'
import { shortcutAnchor, shortcutRowTitle } from '../commands/shortcutEditing'
import { STORAGE_RULE_COPY } from './storageCopy'

/** The Settings pages, in nav order. */
export const SETTINGS_SECTION_IDS = ['general', 'appearance', 'chat', 'speech', 'shortcuts', 'providers', 'agents', 'integrations', 'connections', 'storage', 'activity', 'labs'] as const
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
  /** For a row in a page's own filtered list (a shortcut): the text to fill that page's filter with. */
  filter?: string
}

/** Every setting the search finds. Rows that exist once per item (a provider, a shortcut, a device) are found by their page. */
export const SETTINGS_SEARCH_INDEX: readonly SettingsSearchEntry[] = [
  { title: 'Color theme', section: 'appearance', anchor: 'appearance-theme', keywords: ['appearance', 'dark', 'light', 'high contrast', 'custom theme', 'import theme'] },
  { title: 'Custom CSS', section: 'appearance', anchor: 'appearance-custom-css', keywords: ['theme', 'css', 'stylesheet', 'custom theme'] },
  { title: 'Accent color', section: 'appearance', anchor: 'appearance-accent', keywords: ['colour', 'appearance'] },
  { title: 'Thread path in title bar', section: 'appearance', anchor: 'appearance-thread-path', keywords: ['breadcrumb', 'back', 'forward', 'history', 'navigation', 'subagent', 'parent'] },
  { title: 'Acrylic glass', section: 'appearance', anchor: 'appearance-acrylic', keywords: ['translucent', 'transparent', 'blur', 'window'] },
  { title: 'Glass intensity', section: 'appearance', anchor: 'appearance-glass-intensity', keywords: ['acrylic', 'blur', 'opacity'] },
  { title: 'Animation speed', section: 'appearance', anchor: 'appearance-animation-speed', keywords: ['motion', 'reduce motion', 'transitions', 'fast', 'slow'] },
  { title: 'Interface font', section: 'appearance', anchor: 'appearance-interface-font', keywords: ['typeface', 'text', 'google fonts'] },
  { title: 'Code font', section: 'appearance', anchor: 'appearance-code-font', keywords: ['monospace', 'typeface', 'terminal', 'editor'] },
  { title: 'Project colors on threads', section: 'appearance', anchor: 'appearance-project-colors', keywords: ['tint', 'color'] },
  { title: 'Conversation', section: 'chat', anchor: 'chat-conversation', keywords: ['transcript', 'replies'] },
  { title: 'Chat width', section: 'chat', anchor: 'chat-width', keywords: ['wide', 'full', 'narrow', 'column', 'layout', 'transcript', 'conversation'] },
  { title: 'Render math', section: 'chat', anchor: 'chat-render-math', keywords: ['latex', 'equations'] },
  { title: 'Replies by paragraph', section: 'chat', anchor: 'chat-reply-pacing', keywords: ['streaming', 'pacing', 'word by word', 'fade', 'paragraph at a time'] },
  { title: 'Changed files after each turn', section: 'chat', anchor: 'chat-turn-changed-files', keywords: ['edits', 'summary', 'diff'] },
  { title: 'Composer', section: 'chat', anchor: 'chat-composer', keywords: ['context ring', 'frosted'] },
  { title: 'Context ring', section: 'chat', anchor: 'chat-context-ring', keywords: ['context', 'tokens', 'usage', 'gauge', 'window', 'composer'] },
  { title: 'Frosted composer', section: 'chat', anchor: 'chat-frosted-composer', keywords: ['glass', 'blur', 'translucent', 'transparent', 'opacity', 'color boost'] },
  { title: 'Default permission mode', section: 'general', anchor: 'general-permission-mode', keywords: ['permissions', 'approvals', 'ask'] },
  { title: 'Resume after usage limits reset', section: 'general', anchor: 'general-resume', keywords: ['rate limit', 'paused', 'continue'] },
  { title: 'Finished', section: 'general', anchor: 'general-notify-finished', keywords: ['notifications', 'when a thread finishes', 'completion sound', 'toast', 'system notification', 'done'] },
  { title: 'Needs you', section: 'general', anchor: 'general-notify-needs-you', keywords: ['notifications', 'when a thread needs you', 'question', 'approval', 'toast', 'sound'] },
  { title: 'Stopped', section: 'general', anchor: 'general-notify-stopped', keywords: ['notifications', 'when a thread stops', 'interrupted', 'failed', 'usage limit', 'toast', 'sound'] },
  { title: 'Delete private threads after', section: 'general', anchor: 'general-private-expiry', keywords: ['private', 'expire', 'expiry', 'auto delete', 'timer', 'incognito', 'chats'] },
  { title: 'All threads on my other devices', section: 'general', anchor: 'general-remote-notifications', keywords: ['notifications', 'remote', 'computers'] },
  { title: 'Updates', section: 'general', anchor: 'general-updates', keywords: ['version', 'check for updates', 'about', 'upgrade'] },

  { title: 'Mousse ID', section: 'connections', anchor: 'account-mousse-id', keywords: ['sign in', 'login'] },
  { title: 'Phones', section: 'connections', anchor: 'account-phones', keywords: ['mobile', 'pair'], needs: { anchor: 'account-mousse-id', reason: 'Phones appear once you sign in to Mousse ID.' } },
  { title: 'Activity', section: 'activity', anchor: 'account-activity', keywords: ['heatmap', 'line edits'] },
  { title: 'Token usage', section: 'activity', anchor: 'account-token-usage', keywords: ['tokens'] },

  { title: 'Telemetry', section: 'providers', anchor: 'providers-telemetry', keywords: ['privacy', 'tracking'] },
  { title: 'Keep prompt cache 1 hour', section: 'providers', anchor: 'providers-prompt-cache-hour', keywords: ['cache', 'ttl', 'one hour', 'api key', 'claude code', 'when the cache expires', 'keep the prompt cache for 1 hour'] },
  { title: 'Sign in', section: 'providers', anchor: 'providers-status', keywords: ['status', 'login', 'log in', 'account', 'sign out'] },
  { title: 'Update', section: 'providers', anchor: 'providers-update', keywords: ['cli update', 'upgrade', 'new version', 'update now'], needs: { anchor: 'providers-status', reason: 'Update appears when a newer version is available.' } },
  { title: 'Models', section: 'providers', anchor: 'providers-models', keywords: ['favorites', 'favourites', 'hidden', 'hide', 'custom model', 'model list'] },
  { title: 'Claude settings', section: 'providers', anchor: 'providers-claude-settings', keywords: ['settings.json', 'claude code settings'], needs: { anchor: 'providers-status', reason: 'Claude settings appear on a Claude Code provider.' } },
  { title: 'API key', section: 'providers', anchor: 'providers-api-key', keywords: ['key'] },
  { title: 'Executable path', section: 'providers', anchor: 'providers-executable', keywords: ['binary', 'cli'] },
  { title: 'Launch arguments', section: 'providers', anchor: 'providers-arguments', keywords: ['flags', 'args'] },
  { title: 'Variables', section: 'providers', anchor: 'providers-variables', keywords: ['environment', 'env'] },
  { title: 'Display name', section: 'providers', anchor: 'providers-display-name', keywords: ['rename'] },

  { title: 'Models', section: 'agents', anchor: 'agents-models', keywords: ['model', 'default model', 'thread titles', 'bot model'] },
  { title: 'Default model', section: 'agents', anchor: 'agents-default-model', keywords: ['reasoning', 'effort', 'speed', 'fast'] },
  { title: 'Thread titles', section: 'agents', anchor: 'agents-title-model', keywords: ['title model', 'naming', 'chat titles'] },
  { title: 'Bot model', section: 'agents', anchor: 'agents-bot-model', keywords: ['bot model', 'bots', 'personal bots'] },
  { title: 'Context', section: 'agents', anchor: 'agents-context', keywords: ['compaction', 'prompt cache'] },
  { title: 'Compact context', section: 'agents', anchor: 'agents-context-compaction', keywords: ['compaction', 'tokens', 'summarize'] },
  { title: 'When the cache expires', section: 'agents', anchor: 'agents-idle-compaction', keywords: ['cache', 'idle', 'compact', 'suggest'] },
  { title: 'Cache time', section: 'agents', anchor: 'agents-cache-time', keywords: ['prompt cache', 'ttl', 'one hour', '5 minutes', 'claude code'], needs: { anchor: 'agents-idle-compaction', reason: 'Cache time appears once a Claude Code provider is on.' } },
  { title: 'Access', section: 'agents', anchor: 'agents-access', keywords: ['agent access', 'reach beyond their own threads', 'read other threads', 'manage threads', 'access level'] },
  { title: 'Answer approvals on other threads', section: 'agents', anchor: 'agents-access-approvals', keywords: ['permissions', 'agents may answer approvals'], needs: { anchor: 'agents-access', reason: 'This appears once access is set to Manage.' } },
  { title: 'Capped threads', section: 'agents', anchor: 'agents-capped-threads', keywords: ['cap', 'remote send', 'bot threads', 'plan mode', 'read-only subagents'] },
  { title: 'Subagents', section: 'agents', anchor: 'agents-subagents', keywords: ['subagent'] },
  { title: 'Subagents on other devices', section: 'agents', anchor: 'agents-remote-subagents', keywords: ['computers', 'remote', 'let agents start subagents on your other devices'] },
  { title: 'Worktree per subagent', section: 'agents', anchor: 'agents-subagent-worktrees', keywords: ['experimental', 'branch', 'give each subagent its own worktree'] },
  { title: 'What bots may do here', section: 'agents', anchor: 'agents-bots-here', keywords: ['bots', 'personal bots', 'bot permissions', 'this computer', 'limit'] },
  { title: 'Run commands', section: 'agents', anchor: 'agents-bots-shell', keywords: ['bots', 'shell', 'terminal', 'commands'] },
  { title: 'Use files on this computer', section: 'agents', anchor: 'agents-bots-files', keywords: ['bots', 'file access', 'folders'] },
  { title: 'Use the browser', section: 'agents', anchor: 'agents-bots-browser', keywords: ['bots', 'bot browser'] },
  { title: 'Use your threads', section: 'agents', anchor: 'agents-bots-threads', keywords: ['bots', 'bot threads', 'start thread', 'full access'] },
  { title: 'Automations', section: 'agents', anchor: 'agents-automations', keywords: ['automations agents add', 'schedule', 'scheduled tasks', 'agent jobs', 'limits', 'allow', 'keep'] },
  { title: 'At most', section: 'agents', anchor: 'agents-automations-active', keywords: ['automations', 'limits', 'active', 'most active automations'] },
  { title: 'At least', section: 'agents', anchor: 'agents-automations-interval', keywords: ['automations', 'limits', 'minutes apart', 'interval', 'fewest minutes between runs'] },
  { title: 'End after', section: 'agents', anchor: 'agents-automations-lifetime', keywords: ['automations', 'limits', 'days', 'expire', 'lifetime'] },

  { title: 'Skills', section: 'integrations', anchor: 'integrations-skills' },
  { title: 'MCP servers', section: 'integrations', anchor: 'integrations-mcp', keywords: ['tools'] },
  { title: 'Web search', section: 'integrations', anchor: 'integrations-web-search', keywords: ['search tool'] },
  { title: 'Exa', section: 'integrations', anchor: 'integrations-web-exa', keywords: ['web search', 'api key'] },
  { title: 'Parallel', section: 'integrations', anchor: 'integrations-web-parallel', keywords: ['web search', 'api key'] },
  { title: 'Who can use them', section: 'integrations', anchor: 'integrations-access', keywords: ['available to main agent', 'available to agents', 'skill defaults', 'skills', 'mcp', 'agents'] },
  { title: 'Share MCP servers', section: 'integrations', anchor: 'integrations-share', keywords: ['relay', 'mcp', 'let other agents use your mcp servers'] },
  { title: 'Built-in tools', section: 'integrations', anchor: 'integrations-tools', keywords: ['tools', 'mousse tools'] },
  ...builtInToolEntries(),

  { title: 'Read aloud', section: 'speech', anchor: 'speech-read-aloud', keywords: ['text to speech'] },
  { title: 'Voice', section: 'speech', anchor: 'speech-voice', keywords: ['read aloud'], needs: { anchor: 'speech-read-aloud', reason: 'Voice appears once you choose a read aloud model that has voices.' } },
  { title: 'Speed', section: 'speech', anchor: 'speech-speed', keywords: ['read aloud', 'rate'], needs: { anchor: 'speech-read-aloud', reason: 'Speed appears once you choose a read aloud model.' } },
  { title: 'Dictation', section: 'speech', anchor: 'speech-dictation', keywords: ['microphone', 'speech to text'] },
  { title: 'Reduce background noise', section: 'speech', anchor: 'speech-noise', keywords: ['dictation', 'microphone'], needs: { anchor: 'speech-dictation', reason: 'Reduce background noise appears once you choose a dictation model.' } },
  { title: 'Vocabulary', section: 'speech', anchor: 'speech-vocabulary', keywords: ['dictation', 'names', 'spelling'], needs: { anchor: 'speech-dictation', reason: 'Vocabulary appears once you choose a dictation model that uses it, such as Parakeet.' } },

  { title: 'Device name', section: 'connections', anchor: 'devices-name', keywords: ['computer name'] },
  { title: 'Networking', section: 'connections', anchor: 'devices-networking', keywords: ['network', 'connection'] },
  { title: 'Let my other devices work here', section: 'connections', anchor: 'devices-inbound', keywords: ['remote', 'sharing', 'computers', "let my other devices work on this device's threads"] },
  { title: 'Share bots with other devices', section: 'connections', anchor: 'devices-bots', keywords: ['bots', 'phone', 'mobile', 'sharing', 'personal bots', 'mousse bot'] },
  { title: 'Passphrase', section: 'connections', anchor: 'devices-passphrase', keywords: ['unlock', 'network keys'] },
  { title: 'My devices', section: 'connections', anchor: 'devices-list', keywords: ['pair', 'add device', 'computers'] },
  { title: 'Let my editor reach my other devices', section: 'connections', anchor: 'devices-editors', keywords: ['editors', 'ssh', 'computers'] },
  { title: 'Tailscale Serve', section: 'connections', anchor: 'devices-tailscale-serve' },
  { title: 'Connection add-ons', section: 'connections', anchor: 'devices-addons', keywords: ['tunnel', 'relay', 'ssh'] },
  { title: 'Connection checks', section: 'connections', anchor: 'devices-checks', keywords: ['diagnostics', 'features'] },

  { title: 'Disk usage', section: 'storage', anchor: 'storage-usage', keywords: ['space', 'size'] },
  { title: 'Cleanup', section: 'storage', anchor: 'storage-cleanup', keywords: ['clean up', 'free space'] },
  { title: 'Worktree folder', section: 'storage', anchor: 'storage-worktree-folder', keywords: ['drive', 'location'] },
  { title: STORAGE_RULE_COPY.inactive.title, section: 'storage', anchor: 'storage-inactive', keywords: ['cleanup', 'retention'] },
  { title: STORAGE_RULE_COPY.merged.title, section: 'storage', anchor: 'storage-merged', keywords: ['cleanup'] },
  { title: STORAGE_RULE_COPY.captures.title, section: 'storage', anchor: 'storage-captures', keywords: ['browser data', 'screenshots'] },

  { title: 'Profiler', section: 'labs', anchor: 'labs-profiler', keywords: ['memory', 'ram', 'cpu', 'diagnostics', 'leak', 'performance', 'experimental'] },
  { title: 'Memory', section: 'labs', anchor: 'labs-profiler-memory', keywords: ['ram', 'diagnostics', 'report', 'leak', 'processes'], needs: { anchor: 'labs-profiler', reason: 'This appears once the profiler is on.' } },
  { title: 'Memory notices', section: 'labs', anchor: 'labs-memory-notices', keywords: ['ram', 'diagnostics', 'notification'], needs: { anchor: 'labs-profiler', reason: 'This appears once the profiler is on.' } },
  { title: 'Heap snapshot', section: 'labs', anchor: 'labs-heap-snapshot', keywords: ['memory', 'diagnostics'], needs: { anchor: 'labs-profiler', reason: 'This appears once the profiler is on.' } },
  { title: 'Agents can read the profiler', section: 'labs', anchor: 'labs-profiler-agents', keywords: ['agent access', 'tools', 'profiler tools'], needs: { anchor: 'labs-profiler', reason: 'This appears once the profiler is on.' } }
]

/**
 * Built-in tools: one entry per tool group, found by its tools' names. The web tools sit under Web
 * search, one row each; the development-only group has none.
 */
function builtInToolEntries(): SettingsSearchEntry[] {
  const words = (id: string) => [id, id.replace(/_/g, ' ')]
  return MOUSSE_BUILTIN_TOOL_GROUPS.filter((group) => group.id !== 'devgui').flatMap((group) => {
    const tools = MOUSSE_BUILTIN_TOOLS.filter((tool) => tool.group === group.id)
    if (group.id === 'web') {
      return tools.map((tool) => ({ title: tool.label, section: 'integrations' as const, anchor: `integrations-tool-${tool.id.replace(/_/g, '-')}`, keywords: [...words(tool.id), 'web search', 'built-in tools'] }))
    }
    return [{ title: group.label, section: 'integrations' as const, anchor: `integrations-tools-${group.id}`, keywords: [...tools.flatMap((tool) => words(tool.id)), 'built-in tools'] }]
  })
}

/** Settings that exist only when this build has the Mousse ID service. */
export const MOUSSE_ID_ANCHORS: readonly string[] = ['account-mousse-id', 'account-phones']

/**
 * Every shortcut, built from the command table: found by its row name, its command's title and words,
 * and its group. It lands on its row with the Shortcuts filter set to that name.
 */
export const SHORTCUT_SEARCH_INDEX: readonly SettingsSearchEntry[] = COMMANDS_IN_DISPLAY_ORDER.map((command) => ({
  title: shortcutRowTitle(command.id),
  section: 'shortcuts',
  anchor: shortcutAnchor(command.id),
  keywords: [command.title, command.category, ...(command.searchTerms ?? [])],
  filter: shortcutRowTitle(command.id)
}))

/** The settings the search offers: Mousse ID rows only when this build has the service, then the shortcuts. */
export function searchIndex(mousseIdAvailable: boolean): readonly SettingsSearchEntry[] {
  const settings = mousseIdAvailable ? SETTINGS_SEARCH_INDEX : SETTINGS_SEARCH_INDEX.filter((entry) => !MOUSSE_ID_ANCHORS.includes(entry.anchor))
  return [...settings, ...SHORTCUT_SEARCH_INDEX]
}

/**
 * Anchors of settings that moved, mapped to where they are now, so a link or landing that still names
 * the old anchor reaches the setting. Add the old anchor here whenever a setting's anchor changes.
 */
export const SETTINGS_ANCHOR_ALIASES: Readonly<Record<string, string>> = {
  // Moved from Appearance to the Chat page.
  'appearance-chat': 'chat-conversation',
  'appearance-chat-width': 'chat-width',
  'appearance-render-math': 'chat-render-math',
  'appearance-reply-pacing': 'chat-reply-pacing',
  'appearance-turn-changed-files': 'chat-turn-changed-files',
  'appearance-composer': 'chat-composer',
  'appearance-context-ring': 'chat-context-ring',
  'appearance-frosted-composer': 'chat-frosted-composer'
}

/** The anchor a setting has now: `anchor` itself, or where it moved to. */
export function currentSettingsAnchor(anchor: string, aliases: Readonly<Record<string, string>> = SETTINGS_ANCHOR_ALIASES): string {
  return Object.hasOwn(aliases, anchor) ? aliases[anchor] : anchor
}

/** The index entry for an anchor (old anchors included), if the search knows it. */
export function settingsSearchEntry(anchor: string): SettingsSearchEntry | undefined {
  const current = currentSettingsAnchor(anchor)
  return SETTINGS_SEARCH_INDEX.find((entry) => entry.anchor === current) ?? SHORTCUT_SEARCH_INDEX.find((entry) => entry.anchor === current)
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
  /** The page's own filter to fill in (`filter` on the entry). */
  filter?: string
}

const WORD_CHAR = /[\p{L}\p{N}]/u
/** Endings a whole word may still have: "notification" is the word "notifications". */
const WORD_ENDING = /^(?:s|es|ed|d|ing)?(?![\p{L}\p{N}])/u

/**
 * How `query` sits in `text`: 2 as a whole word ("back" in "Back"), 1 at the start of a longer word
 * ("back" in "background"), 0 not at the start of any word ("ring" in "sharing").
 */
function wordMatch(text: string, query: string): number {
  let best = 0
  for (let at = text.indexOf(query); at >= 0 && best < 2; at = text.indexOf(query, at + 1)) {
    if (at > 0 && WORD_CHAR.test(text[at - 1])) continue
    best = WORD_ENDING.test(text.slice(at + query.length)) ? 2 : 1
  }
  return best
}

/** How well `text` matches `query`: 3 starts with it, 2 a later word starts with it, 0 not at all. */
function matchScore(text: string, query: string): number {
  const lower = text.toLowerCase()
  if (lower.startsWith(query)) return 3
  return wordMatch(lower, query) ? 2 : 0
}

/**
 * The settings and pages matching `query`, best first: a title match before a keyword match, and a
 * setting before a page at the same strength. Every word of the query must start a word of the
 * setting's title, its keywords or its page name. When some results have every word whole, only
 * those show: "back" lists what is called back, not "background"; "backg" still finds it.
 */
export function searchSettings(query: string, pages: readonly SettingsSearchPage[], index: readonly SettingsSearchEntry[] = SETTINGS_SEARCH_INDEX): SettingsSearchResult[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return []
  const words = q.split(' ')
  const pageLabel = new Map(pages.map((page) => [page.id, page.label]))
  /** Whether every word is whole, and the result's rank; undefined when a word starts no word. */
  const score = (title: string, keywords: readonly string[], context: string): { whole: boolean; value: number } | undefined => {
    const haystack = [title, ...keywords, context].join(' ').toLowerCase()
    const matched = Math.min(...words.map((word) => wordMatch(haystack, word)))
    if (!matched) return undefined
    const titled = matchScore(title, q)
    return { whole: matched === 2, value: titled ? 10 + titled : Math.max(1, ...keywords.map((keyword) => matchScore(keyword, q))) }
  }
  const scored: Array<SettingsSearchResult & { whole: boolean; score: number; order: number }> = []
  index.forEach((entry, order) => {
    if (!pageLabel.has(entry.section)) return
    const match = score(entry.title, entry.keywords ?? [], pageLabel.get(entry.section) ?? '')
    if (match) scored.push({ title: entry.title, section: entry.section, anchor: entry.anchor, filter: entry.filter, whole: match.whole, score: match.value + 0.5, order })
  })
  pages.forEach((page, order) => {
    const match = score(page.label, page.keywords, '')
    if (match) scored.push({ title: page.label, section: page.id, whole: match.whole, score: match.value, order: index.length + order })
  })
  const anyWhole = scored.some((result) => result.whole)
  return scored
    .filter((result) => result.whole || !anyWhole)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ title, section, anchor, filter }) => (anchor ? { title, section, anchor, ...(filter ? { filter } : {}) } : { title, section }))
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
  let opened = false
  for (let details = target.closest('details'); details; details = details.parentElement?.closest('details') ?? null) {
    if (!details.open) opened = true
    details.open = true
  }
  const control = target.querySelector(':scope > .settings-item-control')?.querySelector<HTMLElement>(FOCUSABLE)
    ?? target.querySelector<HTMLElement>(FOCUSABLE)
  const focusable = control ?? target
  if (!control && !target.hasAttribute('tabindex')) target.tabIndex = -1
  const land = (): void => {
    target.scrollIntoView?.({ block: 'center' })
    focusable.focus({ preventScroll: true })
  }
  land()
  // A fold that just opened animates its rows in, and Chromium focuses nothing inside it until they
  // show: land again once it is open.
  if (opened && target.ownerDocument.activeElement !== focusable) setTimeout(land, FOLD_OPEN_MS)
  return true
}

/** A little longer than a fold's open animation (`details.ui-collapse-details` in styles/collapse.css). */
const FOLD_OPEN_MS = 220

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
  anchor = currentSettingsAnchor(anchor)
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
