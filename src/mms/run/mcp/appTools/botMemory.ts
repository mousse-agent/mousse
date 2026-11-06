import type { BotActivitySink, BotToolHost } from '../../../bots/seams'
import type { MousseTool } from './types'

/**
 * The bot's five memory tools (bot-context.md §7): `memory_search`, `memory_read`, `memory_list`,
 * `memory_save`, `memory_forget`. Always on and never grantable (`BOT_MEMORY_TOOLS`); their lane
 * rules come from `BotToolHost.activationOf`, never from arguments, and saves and forgets report
 * their outcome chips through `activity.onAppResult` ("remembered · …", "forgot · …").
 *
 * TODO(WP6): this is WP3's placeholder so the registry line in `index.ts` compiles; WP6's file
 * replaces it with the tools and the memory store in the host.
 */

/** What the memory tools reach. TODO(WP6): the memory store. */
export interface BotMemoryToolHost {
  activationOf: BotToolHost['activationOf']
  activity?: BotActivitySink
}

export function botMemoryTools(_host: BotMemoryToolHost): MousseTool[] {
  return []
}
