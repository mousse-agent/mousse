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
  { name: 'model', description: 'List or switch the model for this session', category: 'Configuration', argsHint: '[name] [--session|--global]' },
  { name: 'stop', description: 'Stop the in-flight reply for this session', category: 'Session' },
  { name: 'steer', description: 'Inject guidance mid-turn (after the next tool call)', category: 'Session', argsHint: '<prompt>' },
  { name: 'whoami', description: 'Show your user and chat identity', category: 'Info' },
  { name: 'title', description: 'Set or show the current thread title', category: 'Session', argsHint: '[name]' },
  { name: 'sethome', description: 'Set this chat as the platform home channel', category: 'Session', aliases: ['set-home'] },
  { name: 'agents', description: 'List active agents', category: 'Session', aliases: ['tasks'] }
]

/** Commands matching the incomplete slash token at the start of a composer value. */
export function filterChannelCommandSuggestions(input: string): ChannelCommandDef[] {
  if (!input.startsWith('/') || /\s/.test(input)) return []
  const query = input.slice(1).toLowerCase()
  return CHANNEL_COMMAND_REGISTRY.filter((command) => {
    const names = [command.name, ...(command.aliases ?? [])]
    return names.some((name) => name.toLowerCase().includes(query))
  })
}
