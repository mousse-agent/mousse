import { createHash } from 'node:crypto'
import { Type, type Tool, type ToolCall, type ToolResultMessage } from '@earendil-works/pi-ai'
import type { SettingsStore } from '../../../settings/SettingsStore'
import type { ProviderAuthService } from '../../../providers/ProviderAuthService'
import type {
  BotRuntimeAdapter,
  BotRunRequest,
  BotRunEvents,
  BotRunResult,
  CompartmentStore,
  BotExecutionBinding
} from '../../../net/contracts'
import { NetError, type Base64Url, type BotProfile } from '../../../../shared/net'
import { canonicalJson } from '../../../net/sync/codec'
import type { BillingQualification } from './GuardedProvider'
import type { NativeReader, NativeReaderModule, NativeReaderQualification } from './NativeReader'
const readerNames = ['safe_read', 'safe_list', 'safe_search'] as const
export type ReaderTool = (typeof readerNames)[number]
export interface NativeBotDefinition {
  revision: string
  systemPrompt: string
  billing: BillingQualification
  readerTools: readonly ReaderTool[]
  approval: 'always' | 'never'
  maxModelCalls: number
  maxToolCalls: number
  maxElapsedMs: number
}
export interface NativeBotRuntimeOptions {
  profileId: string
  installationHome: string
  settings: SettingsStore
  providerAuth: ProviderAuthService
  sdkVersion: string
  definition: NativeBotDefinition
  compartments: CompartmentStore
  executionBinding(execution: BotRunRequest['execution']): BotExecutionBinding | undefined
  /** Current identity/placement/meta/grants/stop and exact private-control checks, from admission. */
  assertCurrent(request: BotRunRequest): void
  reader?: {
    module: NativeReaderModule
    qualification: NativeReaderQualification
    deniedRoots: readonly string[]
  }
  qualification: {
    active(profile: BotProfile): boolean
    invalidate(code: string, evidence?: Record<string, unknown>): void
  }
}
export function effectiveBotPolicy(definition: NativeBotDefinition, profile: BotProfile) {
  return {
    adapter: 'mousse-net-native-v1',
    profile,
    definitionRevision: definition.revision,
    systemPrompt: definition.systemPrompt,
    billing: definition.billing,
    tools: profile === 'reader' ? [...definition.readerTools].sort() : [],
    approval: definition.approval,
    maxModelCalls: definition.maxModelCalls,
    maxToolCalls: definition.maxToolCalls,
    maxElapsedMs: definition.maxElapsedMs,
    delegation: false,
    compaction: false,
    providerSession: false
  }
}
export function effectiveBotPolicyDigest(
  definition: NativeBotDefinition,
  profile: BotProfile
): Base64Url {
  return createHash('sha256')
    .update(canonicalJson(effectiveBotPolicy(definition, profile)))
    .digest('base64url') as Base64Url
}
function integer(value: number, max: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max)
    throw new NetError('profile_unsupported')
}
function digest(value: unknown): Base64Url {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url') as Base64Url
}
function checkArgs(call: ToolCall): Record<string, unknown> {
  const a = call.arguments as Record<string, unknown>
  if (!a || typeof a !== 'object' || Array.isArray(a) || canonicalJson(a).length > 16384)
    throw new NetError('bad_request')
  const allowed =
    call.name === 'safe_read'
      ? ['path', 'maxBytes']
      : call.name === 'safe_list'
        ? ['path']
        : ['query', 'path', 'maxResults']
  if (Object.keys(a).some((key) => !allowed.includes(key))) throw new NetError('bad_request')
  if (
    (a.path !== undefined && typeof a.path !== 'string') ||
    (call.name === 'safe_read' && typeof a.path !== 'string') ||
    (call.name === 'safe_search' && typeof a.query !== 'string')
  )
    throw new NetError('bad_request')
  for (const key of ['maxBytes', 'maxResults'])
    if (
      a[key] !== undefined &&
      (!Number.isSafeInteger(a[key]) ||
        (a[key] as number) < 1 ||
        (a[key] as number) > (key === 'maxBytes' ? 262144 : 200))
    )
      throw new NetError('bad_request')
  if (
    call.name === 'safe_search' &&
    (!(a.query as string) || Buffer.byteLength(a.query as string) > 4096)
  )
    throw new NetError('bad_request')
  return a
}
function cancelled<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new NetError('cancelled'))
  return new Promise((resolve, reject) => {
    const abort = () => reject(new NetError('cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
export function readerToolDefinitions(names: readonly ReaderTool[]): Tool[] {
  const all: Record<ReaderTool, Tool> = {
    safe_read: {
      name: 'safe_read',
      description: 'Read one bounded UTF-8 file in the admitted project root.',
      parameters: Type.Object(
        {
          path: Type.String(),
          maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 262144 }))
        },
        { additionalProperties: false }
      )
    },
    safe_list: {
      name: 'safe_list',
      description: 'List one bounded directory in the admitted project root.',
      parameters: Type.Object(
        { path: Type.Optional(Type.String()) },
        { additionalProperties: false }
      )
    },
    safe_search: {
      name: 'safe_search',
      description: 'Bounded literal text search within the admitted project root.',
      parameters: Type.Object(
        {
          query: Type.String(),
          path: Type.Optional(Type.String()),
          maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 }))
        },
        { additionalProperties: false }
      )
    }
  }
  return names.map((name) => all[name])
}
/** Only this exact reader dispatcher receives model-invented names; approvals never expand its inventory. */
export class ReaderToolPort {
  private calls = 0

  constructor(
    private readonly reader: NativeReader,
    private readonly definition: NativeBotDefinition,
    private readonly request: BotRunRequest,
    private readonly events: BotRunEvents,
    private readonly current: () => void,
    private readonly signal: AbortSignal,
    private readonly cancelRun?: () => void
  ) {}

  async execute(call: ToolCall): Promise<ToolResultMessage> {
    call = structuredClone(call)
    if (call.namespace !== undefined) throw new NetError('forbidden')
    this.current()
    if (this.signal.aborted) throw new NetError('cancelled')
    if (
      !this.definition.readerTools.includes(call.name as ReaderTool) ||
      !readerNames.includes(call.name as ReaderTool)
    ) {
      throw new NetError('forbidden')
    }
    if (++this.calls > this.definition.maxToolCalls) {
      this.cancelRun?.()
      throw new NetError('budget_exhausted')
    }
    const args = checkArgs(call)
    this.reader.checkPath((args.path as string | undefined) ?? '', call.name !== 'safe_read')
    const argumentDigest = digest(args)
    const binding = {
      stream: this.request.outputStream,
      compartment: this.request.compartment,
      ...(this.request.visibilityEpoch === undefined
        ? {}
        : { visibilityEpoch: this.request.visibilityEpoch })
    }
    const actionHash = digest({
      execution: this.request.execution,
      tool: call.name,
      argumentDigest,
      profileDigest: this.request.profileDigest,
      binding
    })
    if (this.definition.approval === 'always') {
      this.events.onWaitingApproval('Reader action requires approval.')
      const evidence = await cancelled(
        this.request.approvals.requestAction({ tool: call.name, argumentDigest, actionHash }),
        this.signal
      )
      this.current()
      if (
        this.signal.aborted ||
        evidence.decision !== 'approved' ||
        Date.now() >= evidence.expiresAt
      ) {
        this.cancelRun?.()
        throw new NetError('cancelled')
      }
      try {
        await this.request.approvals.consume(evidence.approval, actionHash)
        if (Date.now() >= evidence.expiresAt) {
          this.cancelRun?.()
          throw new NetError('cancelled')
        }
      } catch (error) {
        this.cancelRun?.()
        throw error
      }
    }
    this.current()
    if (this.signal.aborted) throw new NetError('cancelled')
    const value =
      call.name === 'safe_read'
        ? this.reader.read(args.path as string, args.maxBytes as number | undefined)
        : call.name === 'safe_list'
          ? this.reader.list(args.path as string | undefined)
          : await this.reader.search(args.query as string, {
              path: args.path as string | undefined,
              maxResults: args.maxResults as number | undefined
            })
    this.current()
    if (this.signal.aborted) throw new NetError('cancelled')
    this.events.onToolSummary(call.name, 'Reader action completed.')
    return {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      isError: false,
      timestamp: Date.now()
    }
  }
}
/**
 * Bots have no model path since the app's own agent loop was retired. The adapter keeps its
 * fixed definition and policy digest for the bot registry, and refuses every profile until
 * a harness-backed runtime replaces it.
 */
export class NativeBotRuntime implements BotRuntimeAdapter {
  readonly id = 'mousse'
  constructor(options: NativeBotRuntimeOptions) {
    const definition = structuredClone(options.definition)
    integer(definition.maxModelCalls, 128)
    integer(definition.maxToolCalls, 1024)
    integer(definition.maxElapsedMs, 3600000)
    if (
      !definition.revision ||
      !definition.systemPrompt ||
      Buffer.byteLength(definition.systemPrompt) > 65536 ||
      !['always', 'never'].includes(definition.approval) ||
      new Set(definition.readerTools).size !== definition.readerTools.length ||
      definition.readerTools.some((name) => !readerNames.includes(name))
    )
      throw new NetError('profile_unsupported')
  }
  supports(_profile: BotProfile): boolean {
    return false
  }
  async run(_request: BotRunRequest, _events: BotRunEvents): Promise<BotRunResult> {
    throw new NetError('profile_unsupported')
  }
}
