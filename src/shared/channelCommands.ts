import type { ChatReference } from './chatReferences'

export interface ChannelCommandDef {
  name: string
  description: string
  category: string
  aliases?: string[]
  argsHint?: string
}

/** The canonical command list for the desktop composer and channel adapters. */
export const CHANNEL_COMMAND_REGISTRY: ChannelCommandDef[] = [
  { name: 'help', description: 'List available channel commands', category: 'Session' },
  { name: 'start', description: 'Brief hello / ready message', category: 'Session' },
  { name: 'new', description: 'Start a new session (fresh thread + history)', category: 'Session', aliases: ['reset'], argsHint: '[title]' },
  { name: 'status', description: 'Show session, model, and thread info', category: 'Session' },
  { name: 'usage', description: 'Show subscription usage for the current provider', category: 'Info' },
  {
    name: 'threads',
    description: 'List or select a Mousse thread for this session (history preserved)',
    category: 'Session',
    aliases: ['thread'],
    argsHint: '[id|index|name]'
  },
  {
    name: 'model',
    description: 'List or switch the model for this session',
    category: 'Configuration',
    aliases: ['models'],
    argsHint: '[name] [--session|--global]'
  },
  { name: 'stop', description: 'Stop the in-flight reply for this session', category: 'Session' },
  { name: 'steer', description: 'Inject guidance mid-turn (after the next tool call)', category: 'Session', argsHint: '<prompt>' },
  { name: 'whoami', description: 'Show your user and chat identity', category: 'Info' },
  { name: 'title', description: 'Set or show the current thread title', category: 'Session', argsHint: '[name]' },
  { name: 'sethome', description: 'Set this chat as the platform home channel', category: 'Session', aliases: ['set-home'] },
  { name: 'agents', description: 'List active agents', category: 'Session', aliases: ['tasks'] }
]

/**
 * Desktop-only slash commands shown in the chat composer.
 * Not registered on Telegram/Discord adapters.
 */
export const COMPOSER_DESKTOP_COMMANDS: ChannelCommandDef[] = [
  {
    name: 'skills',
    description: 'Pick a skill to use as the chat mode',
    category: 'Session',
    argsHint: '[filter]'
  }
]

function matchesCommandQuery(command: ChannelCommandDef, query: string): boolean {
  const names = [command.name, ...(command.aliases ?? [])]
  return names.some((name) => name.toLowerCase().includes(query))
}

/** Commands matching the incomplete slash token at the start of a composer value. */
export function filterChannelCommandSuggestions(input: string): ChannelCommandDef[] {
  if (!input.startsWith('/') || /\s/.test(input)) return []
  const query = input.slice(1).toLowerCase()
  return CHANNEL_COMMAND_REGISTRY.filter((command) => matchesCommandQuery(command, query))
}

/** Channel + desktop composer slash suggestions. */
export function filterComposerCommandSuggestions(input: string): ChannelCommandDef[] {
  if (!input.startsWith('/') || /\s/.test(input)) return []
  const query = input.slice(1).toLowerCase()
  return [...CHANNEL_COMMAND_REGISTRY, ...COMPOSER_DESKTOP_COMMANDS].filter((command) =>
    matchesCommandQuery(command, query)
  )
}

/**
 * When the composer value is a completed `/skills` command (optionally with a filter),
 * return the filter text. Returns null when the skills picker should stay closed.
 */
export function parseSkillsPickerQuery(input: string): string | null {
  const match = /^\/skills(?:\s(.*))?$/i.exec(input)
  if (!match) return null
  return match[1] ?? ''
}

export interface InlineSkillToken {
  index: number
  length: number
  skillId: string
}

/**
 * Find an inline `@skill` token referencing a known skill. The token can sit
 * anywhere in the text (embedded between the user's typing). Longest names
 * win and matches must sit on token boundaries. Returns the first match only.
 */
export function findInlineSkillToken<T extends { id: string; name: string }>(
  text: string,
  skills: T[]
): InlineSkillToken | null {
  const candidates: { key: string; skillId: string }[] = []
  for (const skill of skills) {
    if (skill.name) candidates.push({ key: skill.name, skillId: skill.id })
    if (skill.id && skill.id !== skill.name) candidates.push({ key: skill.id, skillId: skill.id })
  }
  candidates.sort((a, b) => b.key.length - a.key.length)
  for (const { key, skillId } of candidates) {
    let from = 0
    for (;;) {
      const index = text.indexOf(`@${key}`, from)
      if (index === -1) break
      const after = text[index + key.length + 1]
      const before = index === 0 ? ' ' : text[index - 1]
      const afterOk = after === undefined || /[\s,.;:!?()\]}]/.test(after)
      const beforeOk = /[\s(\[{'\"]/.test(before)
      if (afterOk && beforeOk) return { index, length: key.length + 1, skillId }
      from = index + 1
    }
  }
  return null
}

/** Remove the inline skill token (if any) from message text before sending. */
export function removeInlineSkillToken<T extends { id: string; name: string }>(
  text: string,
  skills: T[]
): string {
  const token = findInlineSkillToken(text, skills)
  if (!token) return text
  return text.slice(0, token.index) + text.slice(token.index + token.length)
}

export function filterSkillSuggestions<T extends { id: string; name: string; description: string }> (
  skills: T[],
  query: string
): T[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return skills
  return skills.filter((skill) => {
    return (
      skill.name.toLowerCase().includes(normalized) ||
      skill.id.toLowerCase().includes(normalized) ||
      skill.description.toLowerCase().includes(normalized)
    )
  })
}

// ---------------------------------------------------------------------------
// `@` mentions: one picker for skills, files and folders
// ---------------------------------------------------------------------------

/** Characters a mention query may contain; `(` and friends end it, so `@Injectable(` stops matching. */
const MENTION_PATH_CHAR = /[^\s()[\]{}<>"'`;:,@]/
/** What may sit before the `@`, the same set `findInlineSkillToken` accepts. */
const MENTION_BEFORE_OK = /[\s(\[{'"]/

export interface MentionQuery {
  /** Index of the `@` in the text. */
  index: number
  /** Text between the `@` and the caret. */
  query: string
}

/**
 * The `@query` the caret is at the end of, or null. The `@` must start the text or follow
 * whitespace or an opening bracket or quote, so `me@review` and `a@b.com` are ordinary text.
 * Nothing opens inside an unclosed ``` fence. Only the part before the caret is the query.
 */
export function findMentionQueryAtCaret(text: string, caret: number): MentionQuery | null {
  if (!Number.isInteger(caret) || caret < 0) return null
  const end = Math.min(caret, text.length)
  let start = end
  while (start > 0 && MENTION_PATH_CHAR.test(text[start - 1])) start--
  if (start === 0 || text[start - 1] !== '@') return null
  const index = start - 1
  const before = index === 0 ? ' ' : text[index - 1]
  if (!MENTION_BEFORE_OK.test(before)) return null
  const fences = text.slice(0, end).split('```').length - 1
  if (fences % 2 === 1) return null
  return { index, query: text.slice(index + 1, end) }
}

export interface MentionSkill {
  id: string
  name: string
  description: string
}

export type MentionItem<S extends MentionSkill = MentionSkill> =
  | { kind: 'skill'; skill: S }
  | { kind: 'file' | 'directory'; path: string; positions: number[] }

export type FileMentionItem = Extract<MentionItem, { kind: 'file' | 'directory' }>

function rankSkillForMention(skill: MentionSkill, query: string): number {
  if (!query) return 2
  if (skill.name.toLowerCase() === query || skill.id.toLowerCase() === query) return 0
  if (skill.name.toLowerCase().includes(query) || skill.id.toLowerCase().includes(query)) return 1
  return 2
}

/**
 * Skills first (an exact name first of all, then name matches before description matches),
 * then the daemon's file results in the order it ranked them.
 */
export function mergeMentionSuggestions<S extends MentionSkill>(
  skills: S[],
  files: Array<{ path: string; kind: 'file' | 'directory'; positions: number[] }>,
  options: { query?: string; maxSkills?: number; limit?: number } = {}
): MentionItem<S>[] {
  const { query = '', maxSkills = 5, limit = 20 } = options
  const normalized = query.trim().toLowerCase()
  const matching = filterSkillSuggestions(skills, query)
    .map((skill, order) => ({ skill, order, rank: rankSkillForMention(skill, normalized) }))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, Math.max(0, maxSkills))
  const items: MentionItem<S>[] = matching.map(({ skill }) => ({ kind: 'skill', skill }))
  for (const file of files) {
    if (items.length >= limit) break
    items.push({ kind: file.kind, path: file.path, positions: file.positions })
  }
  return items.slice(0, Math.max(0, limit))
}

/**
 * The one text edit both pick paths use: replace `range` with `replacement` and report the
 * caret after it. A space left doubled by the edit is collapsed, so removing `@src` from
 * `look at @src now` gives `look at now`.
 */
export function applyMentionPick(
  text: string,
  range: { index: number; end: number },
  replacement: string
): { value: string; caret: number } {
  const before = text.slice(0, range.index)
  let after = text.slice(range.end)
  const spaceBefore = replacement === '' ? before === '' || /\s$/.test(before) : /\s$/.test(replacement)
  if (spaceBefore && after.startsWith(' ')) after = after.slice(1)
  return { value: before + replacement + after, caret: before.length + replacement.length }
}

/** A mention search result belongs to the picker only while its thread/project scope and query still match. */
export function isMentionResultCurrent(
  result: { scopeKey: string; query: string },
  current: { scopeKey: string; query: string }
): boolean {
  return result.scopeKey === current.scopeKey && result.query === current.query
}

/** Absolute path of a root-relative search result, joined the way the Files tree builds drag paths. */
export function joinMentionPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]$/, '')}/${relative.replace(/^[\\/]/, '')}`
}

/** The reference a picked file or folder adds: a folder result becomes a `folder` reference. */
export function mentionItemReference(
  item: FileMentionItem,
  root: string,
  scope: { threadId?: string; projectId?: string },
  id: string
): ChatReference {
  const trimmed = item.path.replace(/\/+$/, '')
  const title = trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
  return {
    id,
    kind: item.kind === 'directory' ? 'folder' : 'file',
    title,
    path: joinMentionPath(root, trimmed),
    threadId: scope.threadId,
    projectId: scope.projectId
  }
}

export type PickerNavigationKey = 'ArrowDown' | 'ArrowUp' | 'PageDown' | 'PageUp' | 'Home' | 'End'

const PICKER_PAGE = 8

/** The next selected row for a picker key; arrows wrap, pages and Home/End clamp. */
export function moveSelection(current: number, key: string, count: number): number {
  if (count <= 0) return 0
  const last = count - 1
  switch (key) {
    case 'ArrowDown': return (current + 1) % count
    case 'ArrowUp': return (current - 1 + count) % count
    case 'PageDown': return Math.min(last, current + PICKER_PAGE)
    case 'PageUp': return Math.max(0, current - PICKER_PAGE)
    case 'Home': return 0
    case 'End': return last
    default: return Math.min(Math.max(current, 0), last)
  }
}

/** A key that belongs to an input method editor (composing text), including the Safari commit key. */
export function isImeComposing(event: { isComposing?: boolean; keyCode?: number }): boolean {
  return event.isComposing === true || event.keyCode === 229
}

export type PickerKeyAction =
  | { type: 'move'; key: PickerNavigationKey }
  | { type: 'pick' }
  | { type: 'dismiss' }
  /** Handled with nothing to do (the key is not passed to the text box). */
  | { type: 'swallow' }

const NAVIGATION_KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'])

/**
 * What an open picker does with a key, or null to let the text box have it. Nothing happens
 * while an input method is composing, so Enter that commits text never picks or sends.
 * With no rows, `swallowWhenEmpty` keeps Enter and the arrows from reaching the text box.
 */
export function pickerKeyAction(
  event: {
    key: string
    shiftKey?: boolean
    ctrlKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    isComposing?: boolean
    keyCode?: number
  },
  options: { count: number; swallowWhenEmpty?: boolean }
): PickerKeyAction | null {
  if (isImeComposing(event)) return null
  const modified = Boolean(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
  if (event.key === 'Escape') return modified ? null : { type: 'dismiss' }
  const isNavigation = NAVIGATION_KEYS.has(event.key)
  const isEnter = event.key === 'Enter' && !event.shiftKey
  const isTab = event.key === 'Tab' && !modified
  if (!isNavigation && !isEnter && !isTab) return null
  if (isNavigation && modified) return null
  if (options.count <= 0) {
    return options.swallowWhenEmpty && (isNavigation || isEnter) ? { type: 'swallow' } : null
  }
  if (isNavigation) return { type: 'move', key: event.key as PickerNavigationKey }
  return { type: 'pick' }
}
