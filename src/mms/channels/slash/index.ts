export {
  CHANNEL_COMMAND_REGISTRY,
  resolveChannelCommand,
  channelHelpText,
  telegramBotCommands,
  discordApplicationCommands,
  type ChannelCommandDef
} from './registry'
export { parseSlashCommand, type ParsedSlashCommand } from './parse'
export {
  dispatchSlashCommand,
  type SlashContext,
  type SlashHandlerResult,
  type SlashAgentInfo
} from './handlers'
