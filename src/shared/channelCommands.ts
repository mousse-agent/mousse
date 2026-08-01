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

export function filterSkillSuggestions<T extends { id: string; name: string; description: string }>(
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
