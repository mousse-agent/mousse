import { CHANNEL_COMMAND_REGISTRY, type ChannelCommandDef } from '../../../shared/channelCommands'

export { CHANNEL_COMMAND_REGISTRY, type ChannelCommandDef }

const LOOKUP = new Map<string, ChannelCommandDef>()
for (const cmd of CHANNEL_COMMAND_REGISTRY) {
  LOOKUP.set(cmd.name, cmd)
  for (const alias of cmd.aliases ?? []) LOOKUP.set(alias, cmd)
}

export function resolveChannelCommand(name: string): ChannelCommandDef | undefined {
  return LOOKUP.get(name.toLowerCase().replace(/^\//, ''))
}

export function channelHelpText(): string {
  const lines = ['Available commands:', '']
  for (const cmd of CHANNEL_COMMAND_REGISTRY) {
    const args = cmd.argsHint ? ` ${cmd.argsHint}` : ''
    const aliases = (cmd.aliases ?? []).map((alias) => `\`/${alias}\``)
    lines.push(`\`/${cmd.name}${args}\` — ${cmd.description}${aliases.length ? ` (alias: ${aliases.join(', ')})` : ''}`)
  }
  return lines.join('\n')
}

function sanitizeTelegramName(name: string): string | null {
  const cleaned = name.toLowerCase().replace(/-/g, '_').replace(/[^a-z0-9_]/g, '')
  return cleaned && cleaned.length <= 32 ? cleaned : null
}

export function telegramBotCommands(): Array<{ command: string; description: string }> {
  return CHANNEL_COMMAND_REGISTRY.flatMap((cmd) => {
    const command = sanitizeTelegramName(cmd.name)
    return command ? [{ command, description: cmd.description.slice(0, 256) }] : []
  })
}

export function discordApplicationCommands(): Array<{
  name: string
  description: string
  options?: Array<{ name: string; description: string; type: 3; required: false }>
}> {
  return CHANNEL_COMMAND_REGISTRY.map((cmd) => ({
    name: cmd.name,
    description: cmd.description.slice(0, 100),
    ...(cmd.argsHint
      ? { options: [{ name: 'arguments', description: cmd.argsHint.slice(0, 100), type: 3 as const, required: false as const }] }
      : {})
  }))
}
