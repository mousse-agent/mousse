import { createHash } from 'node:crypto'
import type { ToolCall } from '@earendil-works/pi-ai'
import { PERMISSION_KEYS } from '../../../../shared/permissionKeys'
import { APPROVALS_REFUSED_MESSAGE } from '../../../../shared/harness/types'
import type { PermissionMode } from '../../../../shared/permissionMode'
import type { PendingUserQuestions, UserQuestionAnswers } from '../../../../shared/types'
import type { ApprovalTag } from '../../../orchestrator/UserQuestionService'
import type { AgentToolAccess } from '../../../agents/WorkspaceAccessPolicy'
import { authorizeDefinitionCall, definitionRefusal, definitionToolGranted, takeAuthorizedCall, withoutTransportFields } from '../../../agentDefinitions/definitionGate'
import { botMayBeOffered } from '../../../../shared/bots/personal/manifest'
import { BOT_USE_TOOL } from '../../../../shared/bots/personal/catalogue'
import { botVariantSays, canonicalToolCall, canonicalToolName, isBotVariant, isRunningVariant, isToolAlias, toolVariants } from '../../../../shared/toolAliases'
import type { McpToolDescriptor } from '../../../../shared/integrations'
import type { IntegrationActor } from '../../../../shared/integrations/actor'
import type { McpToolCallResult } from '../../../../shared/integrations/results'
import type { McpManager } from '../../../integrations/mcp/McpManager'
import type { RelayAdmission, RelayGrant } from '../relay/types'
import { callForBot, type BotMcp } from '../../../bots/mcp/BotMcp'
import { localizeIsoTimes } from '../../../bots/memory/render'
import type { AppToolTurns } from './turns'
import type { AgentAccessLevel } from '../../../../shared/settings'
import {
  ACCESS_CLASSES,
  McpToolError,
  plainSchema,
  refusalOutcome,
  TOOL_CLASSES,
  type AppToolTurn,
  type JsonSchema,
  type McpCaller,
  type MousseTool,
  type ToolCallContext,
  type ToolLedger,
  type ToolListing,
  type ToolOutcome,
  type ToolTimeline
} from './types'
import { asRefusal, readRefusal, refused, refusalText } from './refusal'
import { addressedArgs, fanOutCalls, fanOutRow, fanOutRows, notSentRow, OUT_OF_REACH, withAddress, type ThreadAddresses } from './addressedCall'
import { ADDRESSED_TOOLS, type BotReach } from '../../addressing'
import { BOT_SEND_TOOL } from '../../../../shared/bots/personal/botMessages'
import { delegableTurn, hostingTurn, type CallAttribution } from '../../nativeHelpers'
import {
  compileTool,
  heldBeforeArguments,
  listsTool,
  offeredThisTurn,
  parentHolds,
  READ_ONLY_TOOL_NAMES,
  toolNeeds,
  userMcpForReader,
  userMcpSource,
  type AskFirst,
  type CompiledTool,
  type ToolAccessPolicy
} from './authority'

export { READ_ONLY_TOOL_NAMES, type ToolAccessPolicy } from './authority'

/**
 * What a call that waited for a run the provider started (`awaitLiveRun`) learns: the run it must act as,
 * or `null` when that run never became active (it timed out, was cancelled or its thread was deleted).
 */
export interface LiveRunGate {
  runId: string | null
}

/** How a native runtime's Mousse MCP calls are tied to the turn that made them (PR 2 §2). */
export type McpTurnBinding = 'per_call' | 'drained_turn' | 'rotate'

/** The input key a `per_call` runtime stamps with its turn token; stripped before the handler. */
export const TURN_TOKEN_KEY = '_mousse_turn'
/** The input key a runtime that tags calls by attempt (the Pi RPC engine) stamps. */
export const ATTEMPT_TOKEN_KEY = '_mousse_attempt'

/** The credential an MCP request's bearer resolved to (`McpAuthority`). */
export interface McpCredentialAuthority {
  threadId: string
  /** The run the credential is bound to; never re-pointed by a call. */
  runId: string
  provider: string
  /** The level the credential recorded for this run (SPEC §15.1); it no longer limits anything. */
  accessLevel: AgentAccessLevel
  binding: McpTurnBinding
  /** The MCP relay the turn attached (`RelayGrant`), copied from the credential; absent: none. */
  relay?: RelayGrant
  /** Still live and of the thread's current runtime epoch (re-read after any wait). */
  current(): boolean
}

export interface McpCallRequest {
  credential: McpCredentialAuthority
  /** Stable id of this call; derives the `clientRequestId` of the commands it issues. */
  toolCallId: string
  /** Aborted when the HTTP request closes or the caller's turn ends. */
  signal: AbortSignal
  /**
   * Set when the call is not the hosting run's own (docs/plans/tool-api.md §2.7): a native helper's, or one nothing ties
   * to the run while a helper may be running. It holds the run's delegable authority only (`delegableTurn`).
   */
  helper?: Exclude<CallAttribution, { kind: 'host' }>
}

export interface ToolRegistryOptions {
  /** The thread's active run (`starting|running|finalizing`), or null when it has none. */
  activeRunId(threadId: string): string | null
  /**
   * A run is about to become the thread's active one (a turn its provider started itself, not yet
   * running): a call waits for it, so it acts as that run and not as the one that just ended.
   */
  awaitLiveRun?(threadId: string): Promise<LiveRunGate | undefined> | undefined
  /** SPEC §12.6 tool ledger of the caller's run, for MCP calls; undefined skips it. */
  toolLedger?(runId: string): ToolLedger | undefined
  /** The thread is a read-only (`shared`) delegated child; it may call only `reads` and `readOnlySafe` tools. */
  readOnlyThread?(threadId: string): boolean
  /** The thread is a Mousse subagent, from its lineage: it lists and holds nothing that never passes down. */
  subagentThread?(threadId: string): boolean
  /**
   * The run holds `person` (§1.3 "Provenance"): a person started it and its thread is not a subagent. Absent, or a run
   * whose origin cannot be read: it does not.
   */
  personHeld?(caller: { threadId: string; runId: string }): boolean
  /** The thread a subagent's lineage names as its parent; undefined for a thread that is not a subagent. */
  parentThread?(threadId: string): string | undefined
  /**
   * A subagent was refused a capability it lacks (§2.4): the owner tells `to` (its parent, which holds it, or the root of
   * its tree, which names what would give it) the first time for each capability of the work, and never again.
   */
  reportLacks?(report: LacksReport): void
  /** The thread's role when it is a personal bot's thread; bot tools are listed only there. */
  botRole?(threadId: string): 'activation' | 'context' | 'subagent' | undefined
  /** The turns registered by the `turn.start` executor; MCP calls act only inside one. */
  turns?: AppToolTurns
  /**
   * The permission mode the caller's run enforces, from its attempt's binding (never from a
   * mode). Without it, or when it knows no mode, an `editsWorkspace` or `changesSettings` tool asks as under Ask:
   * a missing mode never lets a change through unasked.
   */
  permissionModeFor?(runId: string): PermissionMode | undefined
  /** Asks the thread's user to approve a call (an approval request: see `ApprovalTag`). */
  askApproval?(threadId: string, questions: PendingUserQuestions['questions'], options: { signal: AbortSignal; approval: ApprovalTag }): Promise<UserQuestionAnswers>
  /** Without it a `readsOthers` or `managesOthers` tool reaches the caller's own thread only. */
  access?: ToolAccessPolicy
  /**
   * The user's own MCP servers, proxied for a runtime Mousse sends its tools to per turn (a driver
   * with `userMcp: 'proxy'`: Pi's agent). Without it no user MCP tool is listed or called.
   */
  userMcp?: UserMcpProxy
  /**
   * A personal bot's MCP calls (`BotMcp.call`): on Pi, a bot turn is offered its granted MCP tools through the proxy
   * above, and each call runs here once its grant allows it. Absent: no bot turn is offered one.
   */
  botMcp?: Pick<BotMcp, 'call'>
  /** The zone a bot's times are told in (its memory's, as its "Now" line); absent or undefined: times stay in UTC. */
  botTimeZone?(): string | undefined
  /** Resolves the thread tools' `thread` addresses and keeps what each retry key resolved to; absent: `thread` takes ids only. */
  addresses?: ThreadAddresses
}

/** What `ToolRegistryOptions.reportLacks` is told. */
export interface LacksReport {
  /** The subagent that was refused, and the run it was refused in. */
  threadId: string
  runId: string
  tool: string
  lacks: string
  fix?: string
  /** Who is told: its parent, which holds the capability, or the root of its tree, where neither does. */
  to: 'parent' | 'root'
  /** The parent the lineage names; the owner finds the root from it. */
  parentThreadId: string
}

/** `ToolRegistryOptions.userMcp`: the profile's `McpManager`, as the registry uses it. */
export interface UserMcpProxy {
  list(projectPath: string | undefined, actor: IntegrationActor): Promise<McpToolDescriptor[]>
  allowed(providerName: string, projectPath: string | undefined, actor: IntegrationActor): Promise<{ allowed: boolean; reason?: string }>
  call(providerName: string, args: Record<string, unknown>, projectPath: string | undefined, signal: AbortSignal, actor: IntegrationActor): Promise<McpToolCallResult>
}

/** `UserMcpProxy` over the profile's MCP manager. */
export function userMcpProxy(manager: Pick<McpManager, 'getEnabledTools' | 'isToolCallAllowed' | 'callTool'>): UserMcpProxy {
  return {
    list: (projectPath, actor) => manager.getEnabledTools(projectPath, actor),
    allowed: (name, projectPath, actor) => manager.isToolCallAllowed(name, projectPath, actor),
    call: (name, args, projectPath, signal, actor) => manager.callTool(name, args, projectPath, signal, actor)
  }
}

/** A user MCP tool as a runtime is sent it: its own name and schema, effects unknown (`mutation`). */
export type UserMcpListing = Pick<MousseTool, 'name' | 'description' | 'inputSchema' | 'class'>

/** An MCP result as a tool outcome: its text blocks and readable stand-ins, then its inline images. */
export function userMcpOutcome(result: McpToolCallResult): ToolOutcome {
  const texts: string[] = []
  const images: Array<{ data: string; mimeType: string }> = []
  for (const block of result.content ?? []) {
    if (block.type === 'text') texts.push(block.text)
    else if (block.type === 'image' && block.data) images.push({ data: block.data, mimeType: block.mimeType })
    else if (block.type === 'image') texts.push(`[image ${block.mimeType}${block.bytes ? `, ${block.bytes} bytes` : ''}${block.artifactId ? `; artifact=${block.artifactId}` : ''}]`)
    else if (block.type === 'resource_link') texts.push(`[resource ${block.uri}]`)
    else if (block.type === 'resource') texts.push(block.text ?? `[resource ${block.uri ?? 'untyped'}]`)
    else texts.push(`[${block.rawType}]`)
  }
  if (result.structuredContent !== undefined) texts.push(`structuredContent: ${JSON.stringify(result.structuredContent)}`)
  const text = texts.length ? texts.join('\n') : result.text || (result.isError ? 'The MCP tool returned an error.' : '')
  return { text, ...(result.isError ? { isError: true } : {}), ...(images.length ? { images } : {}) }
}

/** Every property name an input schema declares, at any depth. */
function schemaPropertyNames(schema: unknown, depth = 0): string[] {
  if (!schema || typeof schema !== 'object' || depth > 8) return []
  const out: string[] = []
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, inner] of Object.entries(value as Record<string, unknown>)) out.push(name, ...schemaPropertyNames(inner, depth + 1))
    } else out.push(...schemaPropertyNames(value, depth + 1))
  }
  return out
}

/**
 * The thread-id inputs of a tool the central check does not cover. The check reads `threadId` of a
 * `readsOthers`, `managesOthers`, `writesThreads` or `editsWorkspace` tool; any other input that names a thread
 * (`sourceThreadId`, `threadIds`, ...) and `threadId` of any other class must be declared as checked
 * by the tool's own `authorize` (`checkedInHandler`), so a new tool cannot read another thread by accident.
 */
function uncoveredThreadArgs(tool: MousseTool): string[] {
  if (tool.authorize?.where?.trim()) return []
  const covered = tool.access === 'readsOthers' || tool.access === 'managesOthers' || tool.access === 'writesThreads' || tool.access === 'editsWorkspace'
  return [...new Set(schemaPropertyNames(tool.inputSchema))].filter((name) => {
    if (!/^(?:\w*ThreadIds?|threadIds?)$/i.test(name)) return false
    return !(name === 'threadId' && covered)
  })
}

/** `clientRequestId` as a tool that does not keep its first result declares it: the key a retry reuses. */
const RETRY_KEY_SCHEMA: JsonSchema = {
  type: 'string',
  description: 'Reuse only to retry the same call.'
}

/** Each schema with `clientRequestId` added, kept so a schema read twice is the same object. */
const retryKeyed = new WeakMap<object, JsonSchema>()

/** `schema` with `clientRequestId` among its properties, when it is an object schema that does not have it yet. */
function withRetryKey<T extends JsonSchema | undefined>(schema: T): T {
  if (!schema || typeof schema !== 'object') return schema
  const properties = (schema as { properties?: Record<string, JsonSchema> }).properties
  if ((schema as { type?: unknown }).type !== 'object' || properties?.clientRequestId) return schema
  let keyed = retryKeyed.get(schema)
  if (!keyed) {
    keyed = { ...schema, properties: { ...(properties ?? {}), clientRequestId: RETRY_KEY_SCHEMA } } as JsonSchema
    retryKeyed.set(schema, keyed)
  }
  return keyed as T
}

/**
 * A tool as it is registered: one that changes something declares `clientRequestId` in its input schemas. A view
 * over the tool rather than a copy, so a schema or description the tool computes when read (the schedule tools'
 * limits) stays current.
 */
function declaringRetryKey(tool: MousseTool): MousseTool {
  if (READ_ONLY_TOOL_NAMES.has(tool.name) && !ADDRESSED_TOOLS[tool.name]) return tool
  return new Proxy(tool, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (key !== 'inputSchema' && key !== 'botInputSchema') return value
      // A thread tool also takes its thread by address (`addressedCall.ts`).
      const schema = withAddress(target.name, value as JsonSchema | undefined)
      return READ_ONLY_TOOL_NAMES.has(target.name) ? schema : withRetryKey(schema)
    }
  })
}

/**
 * Which bots `bot:` may name: the owner's other bots for a bot turn that holds `bot_send` (never a bot's subagent); for
 * any other thread, only the bot that started it, read from the thread, never from the bots' store.
 */
export function botReachOf(turn: AppToolTurn): BotReach {
  if (!turn.bot) return 'own'
  return turn.bot.appTools.has(BOT_SEND_TOOL) && turn.bot.role !== 'subagent' ? 'others' : 'none'
}

/** Where a call stands once its turn is known (`ToolRegistry.call`). */
interface CallSite {
  /** The name the call came under: an old one runs as that old tool, when the turn has it (`variantOf`). */
  calledAs?: string
  threadId: string
  active: string
  turn: AppToolTurn
  credential: McpCredentialAuthority
  boundToken: string
  request: McpCallRequest
}

/** The app tools a bot's chat calls within its quick-call budgets: they only read, and may take a while. */
const BOT_CHAT_QUICK_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch', 'secret_fetch'])

/** What a turn that is no personal bot's is told when it calls a bot's old tool (`isBotVariant`). */
function notBotsTool(calledAs: string): ToolOutcome {
  return refused('unknown_tool', `${calledAs} is a personal bot's tool; you have no tool by that name.`)
}

function notLive(message: string): McpToolError {
  return new McpToolError('mousse_caller_not_live', message)
}

/** A tool as a personal bot's thread reads it: its `botDescription`, `botInputSchema` and `botClass` where it has them. */
function asBotTool(tool: MousseTool): MousseTool {
  return tool.botDescription || tool.botInputSchema || tool.botClass
    ? {
      ...tool,
      ...(tool.botDescription ? { description: tool.botDescription } : {}),
      ...(tool.botInputSchema ? { inputSchema: tool.botInputSchema } : {}),
      ...(tool.botClass ? { class: tool.botClass } : {})
    }
    : tool
}

/**
 * One schema for a thread tool and its bot variants: every property (the first schema that declares one wins; one that
 * two of them type differently, as `thread_create`'s `model`, is either), each argument a variant fixes as one more of
 * its values, and what all of them need. Without the tool's own schema, an argument every variant fixes is needed too,
 * so a call is always one of them.
 */
function botVariantsSchema(own: JsonSchema | undefined, parts: Array<{ variant: MousseTool; fixes: Record<string, unknown> }>): JsonSchema {
  type PropertySchema = JsonSchema & { enum?: unknown[]; type?: unknown; anyOf?: PropertySchema[] }
  type ObjectSchema = { properties?: Record<string, PropertySchema>; required?: string[] }
  const schemas = [...(own ? [own] : []), ...parts.map(({ variant }) => variant.inputSchema)] as ObjectSchema[]
  const properties: Record<string, PropertySchema> = {}
  const typeOf = (schema: PropertySchema) => JSON.stringify(schema.type ?? null)
  for (const schema of schemas)
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      const kept = properties[key]
      if (!kept) properties[key] = value
      else if (!(kept.anyOf ?? [kept]).some((one) => typeOf(one) === typeOf(value))) properties[key] = { anyOf: [...(kept.anyOf ?? [kept]), value] }
    }
  for (const { fixes } of parts)
    for (const [key, value] of Object.entries(fixes)) {
      const declared = properties[key]
      if (!declared) properties[key] = { type: typeof value === 'number' ? 'integer' : 'string', enum: [value] }
      else if (declared.enum && !declared.enum.includes(value)) properties[key] = { ...declared, enum: [...declared.enum, value] }
    }
  const required = Object.keys(properties).filter((key) =>
    schemas.every((schema) => schema.required?.includes(key)) || (!own && parts.every(({ fixes }) => key in fixes)))
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** Whether `text` names the thread `threadId` as a whole id (not inside another id, such as a request's). */
function namesThread(text: string, threadId: string): boolean {
  const escaped = threadId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w-])${escaped}([^\\w-]|$)`).test(text)
}

/**
 * The tool a `use_tool` call names and its arguments, with the `clientRequestId` a retry gives taken out of them as
 * Mousse's MCP server takes it out of a direct call; or why the call is malformed.
 */
function useToolCall(args: Record<string, unknown>): { name: string; calledAs: string; args: Record<string, unknown>; clientRequestId?: string } | { refused: string } {
  const calledAs = typeof args.tool === 'string' ? args.tool.trim().replace(/^mcp__mousse__/, '') : ''
  if (!calledAs) return { refused: 'use_tool needs tool: the name of a tool from tool_catalogue.' }
  const given = args.arguments ?? {}
  if (typeof given !== 'object' || given === null || Array.isArray(given)) return { refused: 'use_tool needs arguments as an object: the arguments of the tool it names.' }
  const { clientRequestId, ...rest } = given as Record<string, unknown>
  // An old name is the tool it was renamed to, with the arguments it adds (`canonicalToolCall`), here as for a direct call.
  const call = canonicalToolCall(calledAs, rest)
  return { ...call, calledAs, ...(typeof clientRequestId === 'string' && clientRequestId.trim() ? { clientRequestId: clientRequestId.trim() } : {}) }
}

/**
 * Tool name → schema, access class, availability and handler, for both transports (PR 2 §2): the
 * Mousse MCP server lists and calls through it with a credential's authority, and the pi loop calls
 * it in process with its own. A caller is never re-pointed to another run: an MCP credential acts
 * only for the run it is bound to, inside that run's registered turn, and a `per_call` runtime's
 * calls must carry that turn's token.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, MousseTool>()
  /** Old tools that run as a variant of their new one (`toolVariant`), by old name: never listed, called only as that. */
  private readonly variants = new Map<string, MousseTool>()
  /**
   * The user MCP tools each run's turn was offered, by the name it was offered them under: a call
   * resolves from here and never lists again (a new listing may name a tool differently).
   */
  private readonly offeredUserMcp = new Map<string, { turn: AppToolTurn; tools: Map<string, McpToolDescriptor> }>()

  constructor(private readonly options: ToolRegistryOptions) {}

  register(tool: MousseTool): this {
    if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error('A Mousse tool needs a name')
    if (!ACCESS_CLASSES.has(tool.access as string))
      throw new Error(`Mousse tool ${tool.name} has no access class (reads | readsOthers | actsAsCaller | writesThreads | startsThreads | editsWorkspace | managesOthers)`)
    if (!TOOL_CLASSES.has(tool.class as string)) throw new Error(`Mousse tool ${tool.name} has no class (read | mutation | delegation)`)
    if (typeof tool.handler !== 'function') throw new Error(`Mousse tool ${tool.name} has no handler`)
    const uncovered = uncoveredThreadArgs(tool)
    if (uncovered.length)
      throw new Error(
        `Mousse tool ${tool.name} takes a thread id (${uncovered.join(', ')}) that the access check does not cover: make it readsOthers, managesOthers, writesThreads or editsWorkspace (for threadId), or say where it is checked with authorize: checkedInHandler(...)`
      )
    if (this.tools.has(tool.name) || this.variants.has(tool.name)) throw new Error(`Mousse tool ${tool.name} is already registered`)
    if (isRunningVariant(tool.name)) {
      this.variants.set(tool.name, declaringRetryKey(tool))
      return this
    }
    if (isToolAlias(tool.name)) throw new Error(`Mousse tool ${tool.name} is an old name of ${canonicalToolName(tool.name)}; register it under that name`)
    this.tools.set(tool.name, declaringRetryKey(tool))
    return this
  }

  /** The tool `name` calls: an old name (`MOUSSE_TOOL_ALIASES`) gives the tool it was renamed to. */
  get(name: string): MousseTool | undefined {
    return this.tools.get(canonicalToolName(name))
  }

  /** Every registered tool, unlisted ones included. */
  list(): MousseTool[] {
    return [...this.tools.values()]
  }

  /** The old tools that run as a variant of their new one (`toolVariant`): never listed, each still callable. */
  variantTools(): MousseTool[] {
    return [...this.variants.values()]
  }

  /**
   * The ListTools result of a thread's credential (PR 2 §2 "Tool lists across turns"): stable for
   * the thread, whatever the turn's mode, so a list a runtime cached on one turn still works on
   * the next. What a turn may use is checked at call time. The authority compiler decides (`listsTool`).
   */
  listFor(listing: ToolListing): MousseTool[] {
    return this.list().filter((tool) => listsTool(tool, listing) || this.listsAsVariant(tool, listing))
  }

  /**
   * A new tool is listed where one of its old variants would have been (a read-only subagent lists `thread_stop` as it
   * listed `task_cancel`). Listing it widens nothing: each call is still held to the variant it holds (`variantOf`).
   */
  private listsAsVariant(tool: MousseTool, listing: ToolListing): boolean {
    for (const variant of this.variants.values())
      if (canonicalToolName(variant.name) === tool.name && listsTool(variant, listing)) return true
    return false
  }

  /** Whether `threadId` is a personal bot's thread. */
  isBotThread(threadId: string): boolean {
    return this.botListing(threadId).botRole !== undefined
  }

  /**
   * `listFor` a thread: its read-only status and lineage (§1.3 "Listing"), never the current turn's mode (a read-only
   * mode's narrower rights are enforced at call time).
   */
  listForThread(threadId: string, runId?: string): MousseTool[] {
    const bot = this.botListing(threadId)
    // A bot's thread tools follow its turn: what the run's registered turn holds now.
    const turn = bot.botRole && runId ? this.options.turns?.get(runId) : undefined
    const listing: ToolListing = {
      threadId,
      readOnly: this.options.readOnlyThread?.(threadId) === true,
      ...(this.options.subagentThread?.(threadId) === true ? { subagent: true } : {}),
      ...bot,
      ...(turn?.bot && turn.threadId === threadId ? { botTurnTools: turn.bot.appTools, ...(turn.bot.catalogue ? { botCatalogue: turn.bot.catalogue } : {}) } : {})
    }
    const listed = this.listFor(listing)
    // A bot's thread reads each tool as a bot uses it.
    return bot.botRole ? listed.map((tool) => this.asBotListed(tool, listing, turn)) : listed
  }

  /**
   * A tool as a bot's thread lists it (`asBotTool`). A thread tool with variants that are the bot's own (its work, its
   * work's subagents: S7d4a) says what each does and how a call is that variant, after its own text when the turn holds
   * the tool itself; one entry per variant, the one the turn is offered (`variantOf`).
   */
  asBotListed(tool: MousseTool, listing: ToolListing, turn?: AppToolTurn): MousseTool {
    const parts = new Map<string, { variant: MousseTool; fixes: Record<string, unknown> }>()
    for (const variant of this.variants.values()) {
      const said = canonicalToolName(variant.name) === tool.name ? botVariantSays(variant.name) : undefined
      if (!said || !listsTool(variant, listing)) continue
      const kept = parts.get(said.says)
      if (!kept || (turn && !(kept.variant.offered?.(turn) ?? true) && (variant.offered?.(turn) ?? true))) parts.set(said.says, { variant, fixes: said.fixes })
    }
    const own = asBotTool(tool)
    if (!parts.size) return own
    const holdsOwn = listsTool(tool, listing)
    const description = [...(holdsOwn ? [own.description] : []), ...[...parts].map(([says, { variant }]) => `With ${says}: ${variant.description}`)].join('\n\n')
    return { ...own, description, inputSchema: botVariantsSchema(holdsOwn ? own.inputSchema : undefined, [...parts.values()]) }
  }

  /**
   * The thread's capability revision (§1.3 "Listing"): a digest of the tools its stable listing holds. It changes only
   * when that list does: `thread_update access`, or a grant or settings change. A runtime caches
   * its list and the server cannot tell it the list changed, so a new revision starts a new credential epoch at the
   * next turn (the gateway's `generation`), and the runtime lists again. Undefined for a bot's thread, whose list
   * follows its turn's grant and rotates with its policy.
   */
  capabilityRevision(threadId: string): string | undefined {
    if (this.isBotThread(threadId)) return undefined
    const names = this.listForThread(threadId).map((tool) => tool.name).sort()
    return createHash('sha256').update(names.join(',')).digest('hex').slice(0, 12)
  }

  /**
   * The tools of a bot turn's catalogue it holds now, as a bot reads them (`tool_catalogue`): every tool of `names` the
   * thread would list without the catalogue, in the order given.
   */
  catalogued(threadId: string, turn: AppToolTurn, names: readonly string[]): MousseTool[] {
    const bot = this.botListing(threadId)
    if (!bot.botRole || !turn.bot) return []
    const listing: ToolListing = { threadId, readOnly: this.options.readOnlyThread?.(threadId) === true, ...bot, botTurnTools: turn.bot.appTools }
    const listed = new Map(this.listFor(listing).map((tool) => [tool.name, this.asBotListed(tool, listing, turn)]))
    return names.flatMap((name) => listed.get(name) ?? [])
  }

  /**
   * The tools a runtime that takes its tool list per turn is sent for `runId` (the Pi RPC engine).
   * A definition's turn gets them as the definition loop sends them: each with the schema the turn
   * is offered (`definition`: the browser's follows the turn's binding, its vision and backend), and
   * none the turn is not offered (`offered`: a browser tool outside the binding, or a screenshot a
   * model without vision cannot see), only those its grants name, and never a delegation tool (a definition delegates
   * nothing). Any other turn gets the thread's stable listing.
   */
  listForTurn(threadId: string, runId: string | undefined): Array<Pick<MousseTool, 'name' | 'description' | 'inputSchema' | 'class'>> {
    const listed = this.listForThread(threadId, runId)
    const turn = runId ? this.options.turns?.get(runId) : undefined
    const plain = (tool: MousseTool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, class: tool.class })
    if (!turn?.definition || turn.threadId !== threadId) return listed.map(plain)
    const { grants, mcpTools } = turn.definition
    return listed
      .filter((tool) => tool.class !== 'delegation' && definitionToolGranted(tool.name, grants, mcpTools) && offeredThisTurn(tool, turn))
      .map((tool) => {
        const offered = tool.definition?.(turn)
        return offered ? { ...plain(tool), description: offered.description, inputSchema: plainSchema(offered) } : plain(tool)
      })
  }

  /**
   * The user's own MCP tools a turn is offered (`userMcp: 'proxy'` runtimes), as the in-process loop
   * offered them: the turn's actor's enabled tools in its project; a definition's granted ones only;
   * none for a bot's turn, nor for the main agent in a build mode (its tools are the mode's); and in
   * a read-only child only those its workspace capability allows.
   */
  async userMcpForTurn(threadId: string, runId: string | undefined): Promise<McpToolDescriptor[]> {
    const proxy = this.options.userMcp
    const turn = runId ? this.options.turns?.get(runId) : undefined
    if (!proxy || !turn || turn.threadId !== threadId) return []
    // Where the turn's tools come from is the authority compiler's to say (`userMcpSource`).
    const source = userMcpSource(turn, this.options.botMcp !== undefined)
    if (source === 'none') return []
    // A bot's turn: only the granted tools it was offered, each held to its grant when called.
    if (source === 'bot') {
      // A chat turn reaches them through its catalogue (`use_tool`), so its listed tools stay the same whatever it holds.
      if (turn.bot!.lane === 'chat' && turn.bot!.catalogue === 'use_tool') return []
      return (turn.bot!.mcpTools ?? []).filter((tool) => !this.tools.has(tool.providerName)).map((tool) => ({
        id: `${tool.server}:${tool.tool}`, serverId: tool.server, installationId: tool.server, serverName: tool.serverName, toolName: tool.tool,
        providerName: tool.providerName, description: tool.description, inputSchema: tool.inputSchema
      }))
    }
    let tools: readonly McpToolDescriptor[]
    if (source === 'definition') tools = turn.definition!.mcpTools ?? []
    else {
      try {
        tools = await proxy.list(turn.projectPath, turn.actor)
      } catch (error) {
        console.warn('[mcp] the user MCP tools could not be listed for the turn', { threadId, error: error instanceof Error ? error.message : String(error) })
        return []
      }
    }
    const readOnly = this.options.readOnlyThread?.(threadId) === true
    const offered = userMcpForReader(tools.filter((tool) => !this.tools.has(tool.providerName)), turn, readOnly)
    this.rememberOffered(runId!, turn, offered)
    return offered
  }

  /** Keeps what `runId`'s turn was offered (added to an earlier listing of the same turn), and drops ended runs'. */
  private rememberOffered(runId: string, turn: AppToolTurn, tools: readonly McpToolDescriptor[]): void {
    for (const [id, entry] of this.offeredUserMcp) if (this.options.turns?.get(id) !== entry.turn) this.offeredUserMcp.delete(id)
    const current = this.offeredUserMcp.get(runId)
    const map = current?.turn === turn ? current.tools : new Map<string, McpToolDescriptor>()
    for (const tool of tools) map.set(tool.providerName, tool)
    this.offeredUserMcp.set(runId, { turn, tools: map })
  }

  /** The user MCP tool `name` as the run's current turn was offered it, without listing again. */
  private offeredTool(runId: string, turn: AppToolTurn, name: string): McpToolDescriptor | undefined {
    const entry = this.offeredUserMcp.get(runId)
    if (entry?.turn === hostingTurn(turn)) return entry.tools.get(name)
    // A definition's tools are fixed for its run: what it was granted, never listed again.
    return turn.definition?.mcpTools?.find((tool) => tool.providerName === name && !this.tools.has(name))
  }

  /** `userMcpForTurn` as a runtime is sent the tools. */
  async userMcpListingForTurn(threadId: string, runId: string | undefined): Promise<UserMcpListing[]> {
    return (await this.userMcpForTurn(threadId, runId)).map((tool) => ({
      name: tool.providerName,
      description: tool.description || `Call ${tool.toolName} on MCP server ${tool.serverName}.`,
      inputSchema: tool.inputSchema && (tool.inputSchema as { type?: unknown }).type === 'object' ? tool.inputSchema : { type: 'object', additionalProperties: true },
      class: 'mutation'
    }))
  }

  private botListing(threadId: string): { botRole?: 'activation' | 'context' | 'subagent' } {
    try {
      const role = this.options.botRole?.(threadId)
      return role ? { botRole: role } : {}
    } catch {
      return {}
    }
  }

  /**
   * The tools a turn's preamble names as usable now: the thread's list as the turn's run reads it, less what dispatch
   * would refuse before any argument (`heldBeforeArguments`).
   */
  usableNow(turn: AppToolTurn): string[] {
    const inputs = { readOnly: this.options.readOnlyThread?.(turn.threadId) === true, person: () => this.personHeld(turn) }
    return this.listForThread(turn.threadId, turn.runId).filter((tool) => heldBeforeArguments(tool, turn, inputs)).map((tool) => tool.name)
  }

  /**
   * A call over the Mousse MCP server, under the credential the request's bearer resolved to.
   * A refused call is an error result in the refusal shape (`refusal.ts`); refusals before the
   * handler write no ledger row. Only the faults (`REFUSAL_FAULT_CODES`: the credential's turn is
   * over, no such tool) are thrown as `McpToolError`s, which the server sends as JSON-RPC errors.
   */
  async call(calledAs: string, rawArgs: Record<string, unknown>, request: McpCallRequest): Promise<ToolOutcome> {
    // An old name is its new one from here on, before any check and before the ledger row or a receipt names the call:
    // the same checks, the same request key, and a retry under either name is the same request. An old name that became
    // one variant of its tool adds that variant's arguments (`canonicalToolCall`), so every check judges the variant.
    const { name, args: callArgs } = canonicalToolCall(calledAs, rawArgs)
    const registered = this.tools.get(name)
    const tool = registered && toolNeeds(registered).callable ? registered : undefined
    // Any other name can only be one of the turn's proxied user MCP tools, looked up once the turn is known.
    if (!tool && (registered || !this.options.userMcp)) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
    const { threadId, active, turn, args, caller, boundToken } = await this.admit(callArgs, request)
    // A bot's old tool is no other turn's, under its new name's arguments or not.
    if (!turn.bot && isBotVariant(calledAs)) return notBotsTool(calledAs)
    const { credential } = request
    const site: CallSite = { calledAs, threadId, active, turn, credential, boundToken, request }
    return this.reportingLacks(name, site, await this.dispatch(name, tool, args, caller, site))
  }

  /** `call` once the call is admitted: a bot catalogue's `use_tool`, a user MCP tool, or an app tool. */
  private async dispatch(name: string, tool: MousseTool | undefined, args: Record<string, unknown>, caller: McpCaller, site: CallSite): Promise<ToolOutcome> {
    const { turn, request } = site
    try {
      // A catalogue turn's call of a catalogued tool (docs/plans/bot-context.md §15): the tool it names runs exactly as if
      // it were called directly, through every check below. That is a Mousse tool, or one of the owner's MCP tools the
      // turn was offered, which goes through the same dispatcher (grant, masking, asks first) as its direct call.
      if (name === BOT_USE_TOOL && turn.bot?.catalogue === 'use_tool') {
        const inner = useToolCall(args)
        if ('refused' in inner) return refused('invalid_arguments', inner.refused)
        const innerRequest = inner.clientRequestId ? { ...request, toolCallId: `mcp:${inner.clientRequestId}` } : request
        const named = this.tools.get(inner.name)
        if (!named && this.options.userMcp && turn.bot.mcpTools?.some((offered) => offered.providerName === inner.name))
          return await this.callUserMcp(inner.name, inner.args, { ...site, request: innerRequest })
        if (!named || !toolNeeds(named).callable || inner.name === BOT_USE_TOOL || !(named.variants ?? [named]).some((tool) => botMayBeOffered(tool.name)))
          return refused('unknown_tool', `You have no tool named ${inner.name}. tool_catalogue lists each group's tools.`)
        return this.inOwnerZone(turn, await this.callAddressed(inner.name, named, inner.args, caller, { ...site, calledAs: inner.calledAs, request: innerRequest }))
      }
      if (!tool) return await this.callUserMcp(name, args, site)
      return this.inOwnerZone(turn, await this.callAddressed(name, tool, args, caller, site))
    } catch (error) {
      const outcome = refusalOutcome(error)
      if (outcome) return outcome
      throw error
    }
  }

  /**
   * A call of the app tool `tool` once its `thread` address names ids (`addressedArgs`): one target runs as a call that
   * named its id; several (`children`, `descendants`) run as one call per target, each under a retry key of its own and
   * through every check, and the result has one row per target.
   */
  private async callAddressed(name: string, tool: MousseTool, given: Record<string, unknown>, caller: McpCaller, site: CallSite): Promise<ToolOutcome> {
    const { turn, request } = site
    const visible = this.readableBy(caller, turn)
    const addressed = addressedArgs({ addresses: this.options.addresses, tool: name, args: given, callerThreadId: caller.threadId, toolCallId: request.toolCallId, record: !READ_ONLY_TOOL_NAMES.has(name), visible, bots: botReachOf(turn) })
    if ('refused' in addressed) return addressed.refused
    const { args, resolved } = addressed
    // A call that named a thread by address is the thread tool, before and after it fans out (`variantOf`).
    const named = given.thread !== undefined
    if (!resolved?.many) {
      const called = this.variantOf(name, tool, args, turn, site.calledAs, named)
      if (!('name' in called)) return called
      const outcome = await this.callAdmitted(name, called, args, caller, site)
      // A thread an address named that the caller can't read by id: a refusal says no more than that.
      const target = resolved?.form === 'thread' && resolved.address !== args.threadId ? (args.threadId as string) : undefined
      return target && outcome.isError && namesThread(outcome.text, target) && !visible(target) ? OUT_OF_REACH : outcome
    }
    if (args.runId !== undefined) return refused('invalid_arguments', `runId names one run; leave it out with thread "${resolved.address}".`)
    // Each target's key comes from the call's key and the target; the one target of a set is keyed as a call that named it.
    const keyOf = (threadId: string) => (resolved.targets.length === 1 ? request.toolCallId : `${request.toolCallId}:${threadId}`)
    const one = async ({ target, args: targetArgs }: ReturnType<typeof fanOutCalls>[number]) => {
      // Cancelled: no later target is sent anything.
      if (request.signal.aborted) return notSentRow(target, visible(target.threadId))
      const each = { ...site, request: { ...request, toolCallId: keyOf(target.threadId) } }
      let outcome: ToolOutcome
      try {
        const called = this.variantOf(name, tool, targetArgs, turn, site.calledAs, named)
        outcome = 'name' in called ? await this.callAdmitted(name, called, targetArgs, caller, each) : called
      } catch (error) {
        const refusedNow = refusalOutcome(error)
        if (!refusedNow) throw error
        outcome = refusedNow
      }
      return fanOutRow(target, outcome, visible(target.threadId))
    }
    const calls = fanOutCalls(name, args, resolved)
    const rows = new Map<string, Record<string, unknown>>()
    // Waits run side by side; a send or a Stop runs one target at a time, in the order the address recorded.
    if (name === 'thread_wait') (await Promise.all(calls.map(one))).forEach((row, index) => rows.set(calls[index].target.threadId, row))
    else for (const call of calls) rows.set(call.target.threadId, await one(call))
    const results = fanOutRows(resolved, rows, visible)
    const note = !results.length ? `"${resolved.address}" names no thread now.` : name === 'thread_stop' ? 'Stopping each of your subagents also stops what it delegated, deepest first.' : undefined
    return { text: JSON.stringify({ address: resolved.address, results, ...(note ? { note } : {}) }) }
  }

  /** Whether the caller may read a thread by id, as `thread_read` checks it: what an address may name to it. */
  private readableBy(caller: McpCaller, turn: AppToolTurn): (threadId: string) => boolean {
    const read = this.tools.get('thread_read')
    return (threadId) => {
      if (threadId === caller.threadId) return true
      if (!read) return false
      try {
        return !('refusal' in this.heldNow(read, { threadId }, caller, { turn }))
      } catch {
        return false
      }
    }
  }

  /**
   * The declaration that runs a call of `name`: the old tool's own when the call is the variant it became (`toolVariant`),
   * so it is checked and run as that tool always was, whichever name it came under; else `tool`. A definition's turn
   * runs none: a definition delegates nothing. A bot's turn runs its own tool through the bot port or not at all: never
   * the thread tool in its place (the one of `subagent_start` and `work_start` the turn is offered). A call that named a
   * thread by address (`addressed`) is the thread tool: on a bot's turn, never one of its own. The registry's preflight
   * (`resolveCall`) and its dispatch both choose here, so a gate judges the tool that runs.
   */
  private variantOf(name: string, tool: MousseTool, args: Record<string, unknown>, turn: AppToolTurn, calledAs?: string, addressed = false): MousseTool | ToolOutcome {
    const olds = addressed && turn.bot ? [] : toolVariants(name, args, turn.bot ? 'bot' : turn.definition ? undefined : 'thread')
    // A bot's old name runs its own tools or none: a thread it can't take is refused, never sent to the thread tool.
    if (turn.bot && calledAs && isBotVariant(calledAs) && !olds.length)
      return refused('invalid_arguments', `${calledAs} is your own work's tool and takes no thread. To reach a thread, call ${name}.`)
    const declared = olds.flatMap((old) => this.variants.get(old) ?? [])
    if (turn.bot && olds.length && !declared.length) return refused('unavailable', `${olds[0]} is not available here: your bot's tools are not.`)
    // A call under an old name is that tool and no other (`work_start` never runs as `subagent_start`).
    return declared.find((variant) => variant.name === calledAs) ?? declared.find((variant) => variant.offered?.(turn) ?? true) ?? declared[0] ?? tool
  }

  /**
   * A call of the app tool `tool`, admitted (`admit`), held to what the authority compiler compiled for it in this turn
   * (`compileTool`), step by step: the bot's grant, the targets, what the turn lacks, a definition's grants, asking
   * first, then its handler.
   */
  private async callAdmitted(name: string, called: MousseTool, calledArgs: Record<string, unknown>, caller: McpCaller, site: CallSite): Promise<ToolOutcome> {
    // A tool of variants: the call is the variant its arguments name, with that variant's authority, under this name.
    const variant = called.variantOf?.(calledArgs, { threadId: caller.threadId, turn: site.turn, toolCallId: site.request.toolCallId })
    if (variant && 'refused' in variant) return variant.refused
    if (!variant?.conceals) return this.callVariant(name, variant ?? { tool: called, args: calledArgs }, caller, site)
    // The variant read a thread from what the call named: a refusal that would name it (one the caller may not reach)
    // says only that there is no such request.
    const { threadId, refusal } = variant.conceals
    let outcome: ToolOutcome
    try {
      outcome = await this.callVariant(name, variant, caller, site)
    } catch (error) {
      const refusedNow = refusalOutcome(error)
      if (!refusedNow) throw error
      outcome = refusedNow
    }
    return outcome.isError && namesThread(outcome.text, threadId) ? refusal : outcome
  }

  /**
   * How every gate judges a call before the registry runs it (`ToolHost.resolveAppCall`): the canonical name, the
   * variant it is (a bot's grant names variants), and the arguments it runs with, read as `callAdmitted` reads them, so
   * a runtime's gate, a definition's grant and approval digest, and the registry all see the same call.
   */
  resolveCall(calledAs: string, rawArgs: Record<string, unknown>, at: { threadId: string; runId: string }): { name: string; variant: string; args: Record<string, unknown> } | { refused: ToolOutcome } {
    const { clientRequestId, ...given } = rawArgs
    const { name, args: named } = canonicalToolCall(calledAs, given)
    // The call's id as the MCP server will key it (`mcp:<clientRequestId>`), so a retry resolves as its receipt says.
    const key = typeof clientRequestId === 'string' && clientRequestId.trim() ? { toolCallId: `mcp:${clientRequestId.trim()}` } : {}
    const turn = this.options.turns?.get(at.runId)
    if (turn && !turn.bot && isBotVariant(calledAs)) return { refused: notBotsTool(calledAs) }
    // Its `thread` address as the call will resolve it (a gate records nothing), so a gate judges the ids it names.
    const caller: McpCaller = { threadId: at.threadId, runId: at.runId, provider: '', accessLevel: 'manage' }
    const addressed = addressedArgs({
      addresses: this.options.addresses, tool: name, args: named, callerThreadId: at.threadId, toolCallId: key.toolCallId, record: false,
      visible: turn ? this.readableBy(caller, turn) : () => false, bots: turn ? botReachOf(turn) : 'none'
    })
    if ('refused' in addressed) return { refused: addressed.refused }
    const { args } = addressed
    const tool = this.tools.get(name)
    // A bot's own tool that this call is (`variantOf`): the gate judges it by that name, as the bot's grant does.
    const running = tool && turn ? this.variantOf(name, tool, args, turn, calledAs, named.thread !== undefined) : undefined
    if (running && !('name' in running)) return { refused: running }
    if (running && running !== tool) return { name, variant: running.name, args }
    if (!tool?.variantOf || !turn) return { name, variant: name, args }
    const variant = tool.variantOf(args, { threadId: at.threadId, turn, ...key })
    return 'refused' in variant ? variant : { name, variant: variant.tool.name, args: variant.args }
  }

  /** `callAdmitted` once the call is its variant. */
  private async callVariant(name: string, variant: { tool: MousseTool; args: Record<string, unknown> }, caller: McpCaller, site: CallSite): Promise<ToolOutcome> {
    const { active, turn, request } = site
    const { tool, args } = variant
    // A native helper's call holds none of what the run is offered only because it is not a subagent (asking the person,
    // goals, tasks, secrets, quick actions): availability alone would let it call them.
    if (request.helper && tool.offered && tool.offered(turn) !== true && tool.offered(hostingTurn(turn)) === true)
      return refused('unavailable', `${name} belongs to the run that hosts this helper; a helper cannot use it.`)
    const held = this.heldNow(tool, args, caller, site)
    if ('refusal' in held) return held.refusal
    const { compiled } = held
    let { scope } = held
    // A definition run: its grants, policy and approvals hold for every call, as in the in-process loop.
    // A call the runtime's gate already authorized in full (approval included, before it was
    // charged) is revalidated without asking again; any other call is authorized here.
    if (compiled.definition) {
      const refused = await this.authorizeDefinition(name, args, site)
      if (refused) return refused
    }
    // A tool that changes the workspace or settings asks first unless the run's permission mode allows this variant of
    // the call; a rejection ends the call before its handler runs and writes no ledger row.
    const ask = compiled.askFirst(args)
    if (ask) {
      const refusal = await this.askFirst(tool, caller, request.signal, args, ask, request.helper)
      if (refusal) return refusal
      // Asking took time: a bot's grant may have narrowed while the person answered. The call runs only under what holds
      // now, never the authority it had when it asked.
      const still = this.heldNow(tool, args, caller, site)
      if ('refusal' in still) return still.refusal
      scope = still.scope
    }
    const ctx: ToolCallContext = { caller, turn, toolCallId: request.toolCallId, signal: request.signal, transport: 'mcp', ...(scope ? { scope } : {}) }
    const ledger = this.options.toolLedger?.(active)
    const ledgerId = ledger?.start({ type: 'toolCall', id: ctx.toolCallId, name, arguments: args } as ToolCall)
    // A bot's call runs now: its activation counts it here, once (`BotAuthority.callRuns`).
    turn.bot?.callRuns?.()
    let outcome: ToolOutcome
    try {
      // A bot chat's call of the web or a bound service runs within the chat's budgets (`BotQuickCalls`): it only reads,
      // so it stops at its deadline or when the owner writes.
      const quick = BOT_CHAT_QUICK_TOOLS.has(name) ? turn.bot?.quickCalls : undefined
      outcome = quick
        ? await quick.run({ tool: name, readOnly: true, signal: ctx.signal, call: (signal) => this.runHandler(tool, args, { ...ctx, signal }, turn.toolAccess) })
        : await this.runHandler(tool, args, ctx, turn.toolAccess)
    } catch (error) {
      if (ledgerId) ledger?.failed(ledgerId)
      if (error instanceof McpToolError) throw error
      return refused('failed', error instanceof Error ? error.message : String(error))
    }
    if (ledgerId) {
      if (outcome.isError) ledger?.failed(ledgerId)
      else ledger?.commit(ledgerId)
    }
    // A handler's own error result says why in words: it is put in the refusal shape here, once for every tool.
    return asRefusal(outcome)
  }

  /**
   * What the call holds for `caller` now, checked step by step: the bot's grant, the targets, what the turn
   * lacks, a person's provenance. The refusal, or the compiled tool and its scope. Run when the call is admitted, and
   * again once a person answered its ask (`askFirst`), so what changed while it waited holds.
   */
  private heldNow(tool: MousseTool, args: Record<string, unknown>, caller: McpCaller, site: Pick<CallSite, 'turn'>): { refusal: ToolOutcome } | { compiled: CompiledTool; scope: ReturnType<CompiledTool['authorize']> } {
    const { turn } = site
    const compiled = this.compiled(tool, turn, caller)
    // A bot's thread tool ("use your threads"): its grant first, which this turn holds only in the lanes that may use the
    // tool and only while this computer allows it (a refusal there is the bot's ask, never a scope error), then where the
    // call may reach, decided by the bot's rules.
    if (compiled.botThreads) {
      const refusal = compiled.grantRefusal(args)
      if (refusal) return { refusal }
    }
    // Targets are checked first: a refused call asks nobody anything and leaves no ledger row.
    let scope: ReturnType<CompiledTool['authorize']>
    try {
      scope = compiled.authorize(caller, args, this.options.access)
    } catch (error) {
      const outcome = refusalOutcome(error)
      if (!outcome) throw error
      return { refusal: outcome }
    }
    const lacks = compiled.lacks()
    if (lacks) return { refusal: lacks }
    // A variant only a turn a person started may make (§1.3 "Provenance").
    const person = compiled.personRefusal(args)
    if (person) return { refusal: person }
    // A bot turn: every other app tool is held to the bot's grant, on every call. A thread tool was checked above.
    if (!compiled.botThreads) {
      const refusal = compiled.grantRefusal(args)
      if (refusal) return { refusal }
    }
    return { compiled, scope }
  }

  /**
   * A Mousse tool's result for a bot's turn, with its UTC times written in the owner's zone (`localizeIsoTimes`): the
   * bot tells its owner the times it reads, so they read like its "Now" line. Other turns, the owner's own MCP
   * servers' results, and a bot whose zone is not known are left as they came.
   */
  private inOwnerZone(turn: AppToolTurn, outcome: ToolOutcome): ToolOutcome {
    if (!turn.bot) return outcome
    let zone: string | undefined
    try {
      zone = this.options.botTimeZone?.()
    } catch {
      // Reading the zone never fails the call: the times stay in UTC.
    }
    if (!zone) return outcome
    const text = localizeIsoTimes(outcome.text, zone)
    return text === outcome.text ? outcome : { ...outcome, text }
  }

  /** `tool`'s authority in `turn` for this caller (`compileTool`). */
  private compiled(tool: MousseTool, turn: AppToolTurn, caller: McpCaller): CompiledTool {
    return compileTool(tool, {
      turn,
      readOnly: this.options.readOnlyThread?.(caller.threadId) === true,
      permissionMode: () => this.options.permissionModeFor?.(caller.runId),
      // A native helper's view of its run is a subagent's (`delegableTurn`): it never holds person either.
      person: () => turn.subagent !== true && this.personHeld(caller)
    })
  }

  /** Whether the caller's run holds `person`: the owner says so, and a subagent never does. */
  private personHeld(caller: { threadId: string; runId: string }): boolean {
    if (this.options.subagentThread?.(caller.threadId) === true) return false
    try {
      return this.options.personHeld?.(caller) === true
    } catch {
      return false
    }
  }

  /**
   * A subagent's `lacks_capability` refusal is reported up its tree (§2.4): to its parent when the parent holds what it
   * lacks, else to the root of its tree, which names what would give it. The owner tells each the first time per
   * capability of the work. The refusal says who was told. A bot's tree asks its owner instead (not here).
   */
  private reportingLacks(name: string, site: CallSite, outcome: ToolOutcome): ToolOutcome {
    if (!outcome.isError || !this.options.reportLacks || site.turn.bot) return outcome
    const refusal = readRefusal(outcome.text)
    if (refusal?.code !== 'lacks_capability' || !refusal.lacks) return outcome
    let parentThreadId: string | undefined
    try {
      parentThreadId = this.options.subagentThread?.(site.threadId) === true ? this.options.parentThread?.(site.threadId) : undefined
    } catch {
      parentThreadId = undefined
    }
    if (!parentThreadId) return outcome
    const to = parentHolds(refusal.lacks, this.holderState(parentThreadId)) ? 'parent' : 'root'
    try {
      this.options.reportLacks({ threadId: site.threadId, runId: site.active, tool: name, lacks: refusal.lacks, ...(refusal.fix ? { fix: refusal.fix } : {}), to, parentThreadId })
    } catch (error) {
      console.warn('[mcp] a subagent\'s missing capability could not be reported', { threadId: site.threadId, error: error instanceof Error ? error.message : String(error) })
      return outcome
    }
    const told = to === 'parent'
      ? 'Your parent holds this and was told; leave it to your parent, or say in your result what you needed.'
      : 'No thread above you holds this; the thread at the root of your tree was told what would give it. Say in your result what you needed.'
    const { data } = JSON.parse(outcome.text) as { data?: Record<string, unknown> }
    const { code, message, ...rest } = refusal
    return { ...outcome, text: refusalText(code, `${message} ${told}`, { ...rest, data: { ...(data ?? {}), told: to } }) }
  }

  /** What `threadId` holds now (`parentHolds`): its lineage and its run's provenance. */
  private holderState(threadId: string): Parameters<typeof parentHolds>[1] {
    let active: string | null = null
    try {
      active = this.options.activeRunId(threadId)
    } catch {
      active = null
    }
    return {
      readOnly: this.options.readOnlyThread?.(threadId) === true,
      subagent: this.options.subagentThread?.(threadId) === true,
      person: active !== null && this.personHeld({ threadId, runId: active })
    }
  }

  /**
   * The checks every call over MCP passes before anything about its tool: the thread has an active
   * run, the credential is current and acts for that run (or a run the owner says it waited for),
   * the run's turn is registered, and a `per_call` runtime's call carries that turn's token. Returns
   * where the call stands, with the turn and attempt tokens taken out of its arguments. The MCP relay
   * admits its calls here too.
   */
  async admit(rawArgs: Record<string, unknown>, request: McpCallRequest): Promise<RelayAdmission> {
    const { credential } = request
    const threadId = credential.threadId
    const gate = await this.options.awaitLiveRun?.(threadId)
    const active = this.options.activeRunId(threadId)
    // A call that waited for a particular run acts as that run or not at all: never as another one that
    // happens to be active (a person's turn stuck in its sign-in check, say).
    if (gate && (gate.runId === null || gate.runId !== active))
      throw notLive(`The turn the runtime started for thread ${threadId} did not become active; its tools are closed.`)
    if (!active) throw notLive(`Thread ${threadId} has no active run; its tools are closed until the next turn.`)
    if (!credential.current()) throw notLive(`This credential of thread ${threadId} was replaced; its tools are closed.`)
    // The credential acts for its own run only. A gate is the thread owner's word that the waiting
    // call belongs to the run that became active (a turn the runtime started itself).
    if (credential.runId !== active && !gate) throw notLive(`This credential belongs to an earlier turn of thread ${threadId}; its tools are closed.`)
    const live = this.options.turns?.get(active)
    if (!live) throw notLive(`The turn of thread ${threadId} is not running; its tools are closed.`)
    const turn = request.helper ? delegableTurn(live) : live
    const args = { ...rawArgs }
    const turnToken = args[TURN_TOKEN_KEY]
    const attemptToken = args[ATTEMPT_TOKEN_KEY]
    delete args[TURN_TOKEN_KEY]
    delete args[ATTEMPT_TOKEN_KEY]
    // The token the call is bound to: the attempt's when it carries one, else the turn's.
    const boundToken = turn.attemptToken !== undefined && attemptToken !== undefined ? turn.attemptToken : turn.turnToken
    if (credential.binding === 'per_call') {
      const tagged = turn.attemptToken !== undefined && attemptToken !== undefined
        ? attemptToken === turn.attemptToken
        : turnToken === turn.turnToken
      if (!tagged) throw notLive(`This call was made for an earlier turn of thread ${threadId}; it was not run.`)
    }
    const caller: McpCaller = { threadId, runId: active, provider: credential.provider, accessLevel: credential.accessLevel }
    return { threadId, active, turn, args, caller, boundToken }
  }

  /**
   * A definition run's call: its grants, policy and approvals. A call the runtime's gate already
   * authorized in full (approval included, before it was charged) is revalidated without asking
   * again; any other call is authorized here. The run is checked again right before the tool runs,
   * since it may have ended while the approval waited. Returns the refusal, or undefined to run.
   */
  private async authorizeDefinition(name: string, args: Record<string, unknown>, at: CallSite): Promise<ToolOutcome | undefined> {
    const { threadId, active, turn, credential, boundToken, request } = at
    const definition = turn.definition!
    const callId = request.toolCallId.startsWith('mcp:') ? request.toolCallId.slice('mcp:'.length) : request.toolCallId
    // Transport fields are not part of the call, here as at the gate.
    const checked = withoutTransportFields(args)
    const projectPath = turn.projectPath ? { projectPath: turn.projectPath } : {}
    // A per-call runtime's gate authorized this exact call (turn, tool, call id, arguments).
    const handedOver = credential.binding === 'per_call' && takeAuthorizedCall(definition, { turnToken: boundToken, toolName: name, callId, args: checked })
    if (handedOver) {
      const refusal = definitionRefusal(definition, { toolName: name, args: checked, ...projectPath })
      if (refusal) return refused('not_granted', refusal)
      if (request.signal.aborted) return refused('cancelled', 'Tool dispatch cancelled immediately before side effects.')
    } else {
      const decision = await authorizeDefinitionCall(definition, { toolName: name, args: checked, ...projectPath, signal: request.signal })
      if (!decision.allowed) return refused('not_granted', decision.message)
    }
    if (this.options.activeRunId(threadId) !== active || this.options.turns?.get(active) !== hostingTurn(turn) || !credential.current())
      throw notLive(`Run ${active} is no longer the active run of thread ${threadId}; the tool was not run.`)
    return undefined
  }

  /**
   * A call of one of the turn's proxied user MCP tools (`userMcpForTurn`), held to what an app tool
   * is held to: the turn's liveness (checked by the caller), a definition's grants and approvals,
   * the actor's grant at call time and the run's tool ledger.
   */
  private async callUserMcp(name: string, args: Record<string, unknown>, at: CallSite): Promise<ToolOutcome> {
    const { active, turn, request } = at
    const proxy = this.options.userMcp!
    if (turn.bot) return this.callBotMcp(turn.bot, name, args, at)
    const tool = this.offeredTool(active, turn, name)
    if (!tool) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
    if (turn.definition) {
      const refused = await this.authorizeDefinition(name, args, at)
      if (refused) return refused
    }
    const checked = withoutTransportFields(args)
    const allowed = await proxy.allowed(name, turn.projectPath, turn.actor)
    if (!allowed.allowed) return refused('not_granted', allowed.reason ?? 'MCP tool is not enabled for this actor.')
    const ledger = this.options.toolLedger?.(active)
    const ledgerId = ledger?.start({ type: 'toolCall', id: request.toolCallId, name, arguments: checked } as ToolCall)
    let outcome: ToolOutcome
    try {
      outcome = userMcpOutcome(await proxy.call(name, checked, turn.projectPath, request.signal, turn.actor))
    } catch (error) {
      if (ledgerId) ledger?.failed(ledgerId)
      return { text: error instanceof Error ? error.message : String(error), isError: true }
    }
    if (ledgerId) {
      if (outcome.isError) ledger?.failed(ledgerId)
      else ledger?.commit(ledgerId)
    }
    return outcome
  }

  /**
   * A bot turn's call of one of its owner's MCP tools on Pi (`callForBot`): only a tool the turn was offered runs, after
   * the bot's authority allows it, on the owner's connection, within the turn's stop signal and deadline. Its ledger
   * row is written like any proxied call's.
   */
  private async callBotMcp(bot: NonNullable<AppToolTurn['bot']>, name: string, args: Record<string, unknown>, at: CallSite): Promise<ToolOutcome> {
    const mcp = this.options.botMcp
    if (!mcp || !bot.mcpTools?.some((tool) => tool.providerName === name)) throw new McpToolError('mousse_unknown_tool', `No Mousse tool named ${name}.`)
    const checked = withoutTransportFields(args)
    const ledger = this.options.toolLedger?.(at.active)
    const ledgerId = ledger?.start({ type: 'toolCall', id: at.request.toolCallId, name, arguments: bot.maskMcpArguments?.(checked) ?? checked } as ToolCall)
    const outcome = await callForBot({ bot, name, args: checked, toolCallId: at.request.toolCallId, ...(ledgerId ? { invocationId: ledgerId } : {}), signal: at.request.signal, mcp, images: at.turn.toolImages === true })
    if (ledgerId) {
      if (outcome.isError) ledger?.failed(ledgerId)
      else ledger?.commit(ledgerId)
    }
    return outcome
  }

  /**
   * A call that asks first (`CompiledTool.askFirst`): the outcome it gets instead of running, or null when the person
   * allowed it once. An owner that cannot ask rejects, and so does a run nobody answers: nothing runs unapproved.
   */
  private async askFirst(tool: MousseTool, caller: McpCaller, signal: AbortSignal, args: Record<string, unknown>, ask: AskFirst, helper?: McpCallRequest['helper']): Promise<ToolOutcome | null> {
    const { needs } = ask
    // A run nobody answers (`approvals: 'never'`) is refused at once rather than waiting for a person.
    if (ask.unattended) return refused('needs_person', APPROVALS_REFUSED_MESSAGE)
    const notApproved = `The user did not approve ${tool.name}, so it did not run. Do not retry it unless they ask.`
    const rejected: ToolOutcome = refused('not_approved', notApproved)
    if (!this.options.askApproval) return rejected
    try {
      const answers = await this.options.askApproval(
        caller.threadId,
        [{
          id: 'permission',
          prompt: (typeof tool.approvalPrompt === 'function' ? tool.approvalPrompt(args) : tool.approvalPrompt) ?? (tool.name === 'thread_return'
            ? "Allow Mousse to hand this fork's work back to the thread it was forked from?"
            : 'Allow this Mousse tool to change files in this workspace?'),
          options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }]
        }],
        {
          signal,
          approval: {
            action: 'edit',
            permissionKey: tool.permissionKey ?? PERMISSION_KEYS.mousseIntegrate,
            options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }],
            tool: { name: tool.name, input: args },
            // A helper's ask is the hosting run's own request, shown on the helper's thread as well.
            ...(helper?.kind === 'helper' ? { helper: { agentId: helper.agentId } } : {}),
            // A call that needs Full access to run unasked is the person's alone: no agent answers it for them.
            ...(needs === 'full' ? { reason: 'Only you can allow this: it needs Full access to run without asking.' } : {})
          }
        }
      )
      if (answers.permission === 'allow' && !signal.aborted) return null
      const why = typeof answers.feedback === 'string' ? answers.feedback.trim().slice(0, 1000) : ''
      return why ? refused('not_approved', `${notApproved} Reason: ${why}`) : rejected
    } catch {
      return rejected
    }
  }

  /**
   * A read-only child's workspace capability (`SHARED_READER_POLICY`) checks the paths of the tools
   * it governs, as in the pi loop; the tools a read-only child may call over MCP stay as listed.
   */
  private runHandler(tool: MousseTool, args: Record<string, unknown>, ctx: ToolCallContext, access: AgentToolAccess | undefined): Promise<ToolOutcome> {
    const run = async (): Promise<ToolOutcome> => tool.handler(args, ctx)
    return access?.allows(tool.name) ? access.execute(tool.name, args, run) : run()
  }
}
