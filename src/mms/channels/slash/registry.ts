export interface ChannelCommandDef {
  name: string
  description: string
  category: string
  aliases?: string[]
  argsHint?: string
}

export const CHANNEL_COMMAND_REGISTRY: ChannelCommandDef[] = [
  {
    name: 'help',
    description: 'List available channel commands',
    category: 'Session'
  },
  {
    name: 'start',
    description: 'Brief hello / ready message',
    category: 'Session'
  },
  {
    name: 'new',
    description: 'Start a new session (fresh thread + history)',
    category: 'Session',
    aliases: ['reset'],
    argsHint: '[title]'
  },
  {
    name: 'status',
    description: 'Show session, model, and thread info',
    category: 'Session'
  },
  {
    name: 'model',
    description: 'List or switch the model for this session',
    category: 'Configuration',
    argsHint: '[name] [--session|--global]'
  },
  {
    name: 'stop',
    description: 'Stop the in-flight reply for this session',
    category: 'Session'
  },
  {
    name: 'steer',
    description: 'Inject guidance mid-turn (after the next tool call)',
    category: 'Session',
    argsHint: '<prompt>'
  },
  {
    name: 'whoami',
    description: 'Show your user and chat identity',
    category: 'Info'
  },
  {
    name: 'title',
    description: 'Set or show the current thread title',
    category: 'Session',
    argsHint: '[name]'
  },
  {
    name: 'sethome',
    description: 'Set this chat as the platform home channel',
    category: 'Session',
    aliases: ['set-home']
  },
  {
    name: 'agents',
    description: 'List active agents',
    category: 'Session',
    aliases: ['tasks']
  }
]

const LOOKUP = new Map<string, ChannelCommandDef>()
for (const cmd of CHANNEL_COMMAND_REGISTRY) {
  LOOKUP.set(cmd.name, cmd)
  for (const alias of cmd.aliases ?? []) {
    LOOKUP.set(alias, cmd)
  }
}

export function resolveChannelCommand(name: string): ChannelCommandDef | undefined {
  const key = name.toLowerCase().replace(/^\//, '')
  return LOOKUP.get(key)
}

export function channelHelpText(): string {
  const lines = ['Available commands:', '']
  for (const cmd of CHANNEL_COMMAND_REGISTRY) {
    const args = cmd.argsHint ? ` ${cmd.argsHint}` : ''
    const aliasParts = (cmd.aliases ?? [])
      .filter((a) => a.replace(/-/g, '_') !== cmd.name.replace(/-/g, '_'))
      .map((a) => `\`/${a}\``)
    const aliasNote = aliasParts.length > 0 ? ` (alias: ${aliasParts.join(', ')})` : ''
    lines.push(`\`/${cmd.name}${args}\` — ${cmd.description}${aliasNote}`)
  }
  return lines.join('\n')
}

function sanitizeTelegramName(name: string): string | null {
  const cleaned = name.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '')
  if (!cleaned || cleaned.length > 32) return null
  return cleaned
}

export function telegramBotCommands(): Array<{ command: string; description: string }> {
  const result: Array<{ command: string; description: string }> = []
  for (const cmd of CHANNEL_COMMAND_REGISTRY) {
    const tgName = sanitizeTelegramName(cmd.name)
    if (tgName) {
      result.push({ command: tgName, description: cmd.description.slice(0, 256) })
    }
  }
  return result
}
