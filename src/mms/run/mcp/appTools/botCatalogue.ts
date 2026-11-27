import { BOT_CATALOGUE, BOT_CATALOGUE_TOOL, BOT_USE_TOOL, botCatalogueGroup, botCatalogueLine } from '../../../../shared/bots/personal/catalogue'
import { BOT_COMPUTER_PERMISSION } from '../../../../shared/bots/personal/manifest'
import { COMPUTER_TOOL_NAMES, COMPUTER_USE_REQUEST_TOOL, COMPUTER_USE_TOOL } from '../../../../shared/computerUse'
import type { MousseTool, ToolCallContext } from './types'
import type { ToolRegistry } from './registry'

/**
 * A bot's tool catalogue (docs/plans/bot-context.md §15): `tool_catalogue` reads a group's entry (its guidance, and the
 * tools of it the turn holds), and `use_tool` calls one of them on Codex and Pi, whose thread lists only the core set.
 * Claude Code lists every tool and loads them on demand with its own tool search, so there the entry says how to load
 * them. Neither tool reaches anything itself: `use_tool` is run by the registry, which holds the tool it names to every
 * check a direct call passes (`ToolRegistry.call`).
 */

const CATALOGUE_SCHEMA = {
  type: 'object',
  properties: {
    group: { type: 'string', description: `The group to read, as your instructions name it (${BOT_CATALOGUE.map((group) => group.id).join(', ')}). Leave it out for the list of groups.` }
  },
  additionalProperties: false
} as const

const USE_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string', description: 'The tool to call, by the name tool_catalogue gives it.' },
    arguments: { type: 'object', additionalProperties: true, description: 'Its arguments, as its schema in tool_catalogue says. {} when it takes none.' }
  },
  required: ['tool', 'arguments'],
  additionalProperties: false
} as const

/** A group's entry as the turn reads it: its guidance, how to call its tools here, and each tool it holds. */
function entry(groupId: unknown, ctx: ToolCallContext, registry: () => ToolRegistry): string {
  const bot = ctx.turn.bot
  const group = typeof groupId === 'string' ? botCatalogueGroup(groupId.trim()) : undefined
  if (!group) {
    const asked = typeof groupId === 'string' && groupId.trim() ? `There is no group named ${groupId.trim()}. ` : ''
    return `${asked}The groups:\n${BOT_CATALOGUE.map(botCatalogueLine).join('\n')}`
  }
  const held = registry().catalogued(ctx.caller.threadId, ctx.turn, group.tools)
  const missing = group.tools.filter((name) => !held.some((tool) => tool.name === name))
  const lines = [`# ${group.id}`, group.guidance]
  // The computer: whether its tools that act (not the setup request) are held, and why not.
  if (group.id === 'computer' && !held.some((tool) => COMPUTER_TOOL_NAMES.includes(tool.name))) {
    if (!bot?.appTools.has(COMPUTER_USE_TOOL)) {
      // No grant: ask for it, unless the owner switched it off or allowed it since the turn started (`held` says which).
      lines.push('', bot?.held?.({ tool: BOT_COMPUTER_PERMISSION }) ?? 'None of these tools are yours on this turn. Ask for "use the computer" with permission_ask (tool computer) when your owner wants something done in an app.')
      return lines.join('\n')
    }
    const request = held.some((tool) => tool.name === COMPUTER_USE_REQUEST_TOOL)
    lines.push('', `Your owner allows "use the computer", but computer use isn't set up on this computer yet (Settings → Computer use on, with Cua Driver installed), so computer_tools and computer_use aren't yours on this turn. ${request ? 'Call computer_use_request once with why you need it: your owner gets a setup card, and the tools are yours from your next turn. Don\'t wait for it.' : 'Say in your report that computer use needs setting up on this computer.'}`)
    if (!request) return lines.join('\n')
  }
  // The owner's MCP tools this turn holds: a chat reaches them only here, so its listed tools never change with them.
  const mcp = group.id === 'mcp' ? bot?.mcpTools ?? [] : []
  if (!held.length && !mcp.length) {
    lines.push('', 'None of these tools are yours on this turn. Where the group needs a permission, ask for it with permission_ask; otherwise this kind of turn does not use them.')
    return lines.join('\n')
  }
  if (bot?.catalogue === 'use_tool') {
    lines.push('', `Call these with ${BOT_USE_TOOL}: {"tool": "<name>", "arguments": {...}}. Each runs exactly as if you called it directly.`)
    for (const tool of held) lines.push('', `## ${tool.name}`, tool.description, `Arguments: ${JSON.stringify(tool.inputSchema)}`)
    // An MCP tool by the name `use_tool` runs it under (`ToolRegistry.dispatch`), its server's words framed as such.
    for (const tool of mcp) lines.push('', `## ${tool.providerName}`, tool.description, `Arguments: ${JSON.stringify(tool.inputSchema)}`)
  } else {
    // Claude Code: every tool is listed, loaded on demand by its own tool search.
    const names = [...held.map((tool) => `mcp__mousse__${tool.name}`), ...mcp.map((tool) => `mcp__mousse-relay__${tool.name}`)]
    lines.push('', `Load them with ToolSearch ("select:${names.join(',')}"), then call them by name: ${[...held, ...mcp].map((tool) => tool.name).join(', ')}.`)
  }
  if (missing.length) lines.push('', `Not yours on this turn: ${missing.join(', ')}.`)
  return lines.join('\n')
}

export function botCatalogueTools(registry: () => ToolRegistry): MousseTool[] {
  return [
    {
      name: BOT_CATALOGUE_TOOL,
      description: 'Read a group of your tool catalogue: how to use its tools, and how to call them. Read a group the first time you need it in a conversation; its guidance counts as your instructions.',
      inputSchema: CATALOGUE_SCHEMA,
      access: 'reads',
      class: 'read',
      // Claude Code defers listed tools behind its tool search: this one is how a bot finds the rest, so it is loaded.
      alwaysLoad: true,
      listed: (listing) => listing.botRole === 'activation' && Boolean(listing.botTurnTools?.has(BOT_CATALOGUE_TOOL)),
      available: (turn) => (turn.bot?.appTools.has(BOT_CATALOGUE_TOOL) ? true : 'The tool catalogue is only for a bot\'s own turns.'),
      offered: (turn) => Boolean(turn.bot?.appTools.has(BOT_CATALOGUE_TOOL)),
      describe: (args) => `Read tool group${typeof args.group === 'string' ? ` ${args.group}` : 's'}`,
      handler: async (args, ctx) => ({ text: entry(args.group, ctx, registry) })
    },
    {
      name: BOT_USE_TOOL,
      description: 'Call a tool of your catalogue by name, with its arguments as tool_catalogue gives them. It runs exactly as that tool, with the same permissions.',
      inputSchema: USE_TOOL_SCHEMA,
      access: 'actsAsCaller',
      class: 'mutation',
      listed: (listing) => listing.botRole === 'activation' && listing.botCatalogue === 'use_tool' && Boolean(listing.botTurnTools?.has(BOT_USE_TOOL)),
      available: (turn) => (turn.bot?.catalogue === 'use_tool' ? true : 'use_tool is not used here: call tools by name.'),
      offered: (turn) => turn.bot?.catalogue === 'use_tool',
      describe: (args) => (typeof args.tool === 'string' ? args.tool : 'Use a tool'),
      // The registry runs the tool it names (`ToolRegistry.call`); this runs only where use_tool is not the way.
      handler: async () => ({ text: 'use_tool is not used here: call tools by name.', isError: true })
    }
  ]
}
