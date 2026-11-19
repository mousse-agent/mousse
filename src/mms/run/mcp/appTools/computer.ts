import { COMPUTER_TOOLS_TOOL, COMPUTER_USE_TOOL, type ComputerUseStatus } from '../../../../shared/computerUse'
import type { DriverCallResult, DriverTool } from '../../../computerUse/ComputerUseDriver'
import type { AppToolHost } from './host'
import type { JsonSchema, MousseTool, ToolImage, ToolOutcome } from './types'

/**
 * Computer use (`src/shared/computerUse.ts`): `computer_tools` lists Cua Driver's own tools and rules, and
 * `computer_use` runs one of them by name. Two fixed tools rather than the driver's forty-odd, so the list a runtime
 * caches never changes with the driver's version, and a bot's permission names them. Listed for every thread while
 * Settings → Computer use is on and a driver may be there; a thread a bot started lists them only while that bot holds
 * "use the computer", and a bot's own turn only while its grant does (`compileBotThread`).
 */

/** What the computer tools read, at every listing and call. */
export interface ComputerUseToolHost {
  /** Settings → Computer use is on. */
  enabled(): boolean
  /** The driver's last known state, without looking (listing is synchronous); undefined before the first look. */
  known(): ComputerUseStatus | undefined
  /** Whether `threadId`'s agents may use the computer: false for a thread a bot started while the bot lacks it. */
  allowedFor(threadId: string): boolean
  listTools(): Promise<{ tools: DriverTool[]; instructions?: string }>
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DriverCallResult>
}

/** What `computerUseAllowed` reads of a thread. */
export interface ComputerUseLineage {
  startedByBot?: { botId: string }
  lineage?: { parentThreadId?: string }
  createdByThreadId?: string
}

/**
 * Whether `threadId`'s agents may use the computer: yes, unless the thread or one above it (its parent, or the thread
 * whose agent started it) was started by a bot that doesn't hold "use the computer". The nearest bot decides. A thread
 * the store doesn't hold was started by no bot; a lineage that loops or runs past 32 threads allows nothing.
 */
export function computerUseAllowed(threadId: string, readThread: (id: string) => ComputerUseLineage | undefined, botHolds: (botId: string) => boolean): boolean {
  const seen = new Set<string>()
  for (let current: string | undefined = threadId; current; ) {
    if (seen.has(current) || seen.size >= 32) return false
    seen.add(current)
    const thread = readThread(current)
    if (!thread) return true
    if (thread.startedByBot?.botId) return botHolds(thread.startedByBot.botId)
    current = thread.lineage?.parentThreadId ?? thread.createdByThreadId
  }
  return true
}

/** Longest text a call returns; the rest is cut and the cut is said. */
const MAX_TEXT = 32_000
/** Images of one result, and the largest one (base64 characters, about 1.5 MB). */
const MAX_IMAGES = 4
const MAX_IMAGE_CHARS = 2_000_000
/** Longest driver instructions `computer_tools` returns. */
const MAX_INSTRUCTIONS = 8_000

const TOOLS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    tool: { type: 'string', description: "One driver tool's name: returns its full description and input schema. Omit to list every tool." }
  },
  additionalProperties: false
}

const USE_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    tool: { type: 'string', description: 'The driver tool to run, as computer_tools names it (get_window_state, click, run_steps...).' },
    arguments: { type: 'object', description: "The tool's arguments, as its input schema says.", additionalProperties: true }
  },
  required: ['tool'],
  additionalProperties: false
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]` : text
}

/** A driver result as a tool outcome: its text, then its images, within bounds. */
export function driverOutcome(result: DriverCallResult): ToolOutcome {
  const texts: string[] = []
  const images: ToolImage[] = []
  let dropped = 0
  for (const block of result.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    else if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      if (images.length < MAX_IMAGES && block.data.length <= MAX_IMAGE_CHARS) images.push({ data: block.data, mimeType: block.mimeType })
      else dropped += 1
    }
  }
  if (!texts.length && result.structuredContent !== undefined) texts.push(JSON.stringify(result.structuredContent))
  if (dropped) texts.push(`[${dropped} more image${dropped === 1 ? '' : 's'} left out]`)
  const text = cut(texts.join('\n') || (result.isError ? 'The driver returned an error.' : 'Done.'), MAX_TEXT)
  return { text, ran: true, ...(result.isError ? { isError: true } : {}), ...(images.length ? { images } : {}) }
}

/** The first sentence of a description, for the list. */
function summary(description: string): string {
  const first = description.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim()
  const sentence = /^(.{20,200}?[.!?])(\s|$)/.exec(first)?.[1] ?? first.slice(0, 200)
  return sentence
}

export function computerTools(host: AppToolHost): MousseTool[] {
  const computer = () => host.computerUse?.()
  // Listed while on and allowed for the thread, unless the driver is known to be missing (then Settings is the fix).
  const listed = (threadId: string | undefined): boolean => {
    const cu = computer()
    if (!cu?.enabled() || cu.known()?.state === 'missing') return false
    return threadId === undefined || cu.allowedFor(threadId)
  }
  const available = (threadId: string): true | string => {
    const cu = computer()
    if (!cu?.enabled()) return 'Computer use is off in Settings → Computer use.'
    if (!cu.allowedFor(threadId)) return 'This thread was started by a bot that may not use the computer.'
    return true
  }
  return [
    {
      name: COMPUTER_TOOLS_TOOL,
      description: "Computer use: lists the tools of Cua Driver, which sees and operates apps on this computer (windows, clicks, typing), and its rules. Read it once before computer_use. Pass tool to get one tool's full description and input schema.",
      inputSchema: TOOLS_SCHEMA,
      access: 'actsAsCaller',
      class: 'read',
      listed: (listing) => listed(listing.threadId),
      available: (turn) => available(turn.threadId),
      describe: () => 'Computer: list tools',
      handler: async (args) => {
        const cu = computer()
        if (!cu) return { text: 'Computer use is not available in this Mousse.', isError: true }
        const { tools, instructions } = await cu.listTools()
        const name = typeof args.tool === 'string' ? args.tool.trim() : ''
        if (name) {
          const tool = tools.find((entry) => entry.name === name)
          if (!tool) return { text: `No driver tool named ${name}. Call computer_tools without tool to list them.`, isError: true }
          return { text: cut(`${tool.name}\n${tool.description}\n\nInput schema: ${JSON.stringify(tool.inputSchema)}`, MAX_TEXT) }
        }
        return {
          text: [
            ...(instructions ? [cut(instructions, MAX_INSTRUCTIONS), ''] : []),
            `Tools (run one with computer_use {tool, arguments}; computer_tools {tool} gives its schema):`,
            ...tools.map((tool) => `- ${tool.name}: ${summary(tool.description)}`)
          ].join('\n')
        }
      }
    },
    {
      name: COMPUTER_USE_TOOL,
      description: 'Computer use: runs one Cua Driver tool on this computer (read a window, click, type, run steps) and returns what it reports, screenshots included. List the tools and their rules with computer_tools first.',
      inputSchema: USE_SCHEMA,
      access: 'actsAsCaller',
      class: 'mutation',
      listed: (listing) => listed(listing.threadId),
      available: (turn) => available(turn.threadId),
      describe: (args) => `Computer: ${typeof args.tool === 'string' ? args.tool : 'tool'}`,
      handler: async (args, ctx) => {
        const cu = computer()
        if (!cu) return { text: 'Computer use is not available in this Mousse.', isError: true }
        const name = typeof args.tool === 'string' ? args.tool.trim() : ''
        if (!name) return { text: 'Name the driver tool to run (tool).', isError: true }
        const input = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {}
        return driverOutcome(await cu.call(name, input, ctx.signal))
      }
    }
  ]
}
