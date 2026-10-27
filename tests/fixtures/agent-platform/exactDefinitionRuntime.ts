import { readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { AssistantMessage, Context, Message, Tool, ToolCall } from '@earendil-works/pi-ai'
import { authorizeDefinitionCall } from '../../../src/mms/agentDefinitions/definitionGate'
import type { Harness } from '../../../src/mms/harness/gateway'
import type { OrchestratorService } from '../../../src/mms/orchestrator/OrchestratorService'
import { ProviderInstanceService } from '../../../src/mms/providers/ProviderInstanceService'
import { CLAUDE_SUBSCRIPTION_CAPABILITIES } from '../../../src/mms/run/adapters/claudeSubscription/ClaudeSubscriptionAdapter'
import type { AdapterHost, ProviderAdapter, TurnInput, TurnResult, TurnSink } from '../../../src/mms/run/adapters/ProviderAdapter'
import { adapterDriver, testHarness } from '../../../src/mms/run/testkit/harness'
import type { HarnessCaps } from '../../../src/shared/harness/types'

/**
 * A stand-in for a runtime that earned `toolControl: 'exact'` (PR 4 §6), installed in a real
 * profile's gateway as the `pi:<provider>` instance. No production runtime declares `exact` yet, so
 * definition tests run on this one. It behaves as an exact runtime must:
 * - it runs the definition's own instructions (`TurnInput.instructions`) and only its messages;
 * - every tool call passes the definition's authority first (`authorizeDefinitionCall`, as Pi's
 *   `/pi/gate` does), with the exact arguments it then runs;
 * - built-in file tools run under the host's writer, app tools through the Mousse tool registry.
 * Model replies are scripted (`next`), and each request's context is captured, as a provider sees it.
 */
export interface ExactRuntimeOptions {
  orchestrator: OrchestratorService
  providerId: string
  profileHome: string
  captured?: Context[]
  /** The model's reply to each request; default: the next of `outputs`. */
  next?: (context: Context, signal: AbortSignal) => Promise<AssistantMessage>
  outputs?: AssistantMessage[]
  caps?: Partial<HarnessCaps>
  /** Where the turns are recorded (default: a new list). */
  turns?: ExactRuntime['turns']
  /** More providers whose `pi:<provider>` instances run on the same exact stand-in. */
  alsoProviders?: string[]
}

/** The Claude Code-like instance `claude` beside it: it only asks for approval, so it cannot hold a definition. */
export const APPROVAL_ONLY_INSTANCE = 'claude'

export interface ExactRuntime {
  harness: Harness
  instanceId: string
  turns: Array<{ input: TurnInput; host: AdapterHost }>
  adapter: ProviderAdapter
}

function blocks<T extends AssistantMessage['content'][number]['type']>(message: AssistantMessage, type: T): Array<Extract<AssistantMessage['content'][number], { type: T }>> {
  return message.content.filter((block) => block.type === type) as Array<Extract<AssistantMessage['content'][number], { type: T }>>
}

export function installExactDefinitionRuntime(options: ExactRuntimeOptions): ExactRuntime {
  const instanceId = `pi:${options.providerId}`
  const turns: ExactRuntime['turns'] = options.turns ?? []
  const outputs = options.outputs ?? []
  const next = options.next ?? (async () => {
    const reply = outputs.shift()
    if (!reply) throw new Error('fixture provider exhausted')
    return reply
  })

  const runTool = async (call: ToolCall, input: TurnInput, host: AdapterHost): Promise<{ text: string; isError?: boolean }> => {
    const definition = host.definition
    if (!definition) return { text: 'This runtime runs no tool without a definition authority.', isError: true }
    const decision = await authorizeDefinitionCall(definition, { toolName: call.name, args: call.arguments, ...(input.cwd ? { projectPath: input.cwd } : {}), signal: input.signal })
    if (!decision.allowed) return { text: decision.message, isError: true }
    const path = typeof call.arguments.path === 'string' ? call.arguments.path : ''
    const target = input.cwd && path ? (isAbsolute(path) ? path : resolve(input.cwd, path)) : ''
    if (call.name === 'write') {
      await host.tools.toolAccess!.execute('write', call.arguments, async () => writeFileSync(target, String(call.arguments.content ?? '')))
      return { text: `Wrote ${path}` }
    }
    if (call.name === 'read') return { text: readFileSync(target, 'utf8') }
    const turn = options.orchestrator.appToolTurns.get(input.runId)
    if (!turn) return { text: 'No app-tool turn is registered for this run.', isError: true }
    return options.orchestrator.mcpToolRegistry().callInProcess(call.name, call.arguments, { kind: 'run', runId: input.runId }, { turn, toolCallId: call.id, signal: input.signal })
  }

  const adapter: ProviderAdapter = {
    driver: 'pi',
    capabilities: { steer: 'none', interrupt: true, rollback: 'none', fork: 'portable', events: 'rich', containment: 'strong', historyInjection: 'prompt', mcp: true, childPolicy: 'enforced' },
    configured: () => true,
    async startTurn(input: TurnInput, sink: TurnSink, _ctl, host: AdapterHost): Promise<TurnResult> {
      turns.push({ input, host })
      const ref = { provider: input.llmProvider, instanceId: input.instanceId, model: input.model }
      sink.providerRef(ref)
      const messages: Message[] = [...input.messages]
      const tools: Tool[] = (host.bridge?.toolPolicy?.allow ?? []).map((name) => ({ name, description: name, parameters: { type: 'object' } as never }))
      const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      let text = ''
      let cost = 0
      const result = (aborted: boolean): TurnResult => ({ text, aborted, modelName: input.model, totalResponseTimeMs: 1, usage, contextSignature: 's', nativeMessages: [], providerRef: ref })
      for (;;) {
        if (input.signal.aborted) return result(true)
        const context: Context = { systemPrompt: input.instructions?.text ?? '', messages: structuredClone(messages), tools }
        options.captured?.push(structuredClone(context))
        let reply: AssistantMessage
        try {
          reply = await next(context, input.signal)
        } catch (error) {
          if (input.signal.aborted) return result(true)
          throw error
        }
        if (input.signal.aborted || reply.stopReason === 'aborted') return result(true)
        usage.input += reply.usage?.input ?? 0
        usage.output += reply.usage?.output ?? 0
        cost += reply.usage?.cost?.total ?? 0
        sink.providerMetrics({ totalResponseTimeMs: 1, usage: { ...reply.usage, cost: { ...reply.usage.cost, total: cost } } })
        messages.push(reply)
        const said = blocks(reply, 'text').map((block) => block.text).join('')
        if (said) {
          sink.text({ phase: 'start', content: '', contentIndex: 0 })
          sink.text({ phase: 'delta', content: said, contentIndex: 0 })
          sink.text({ phase: 'complete', content: said, contentIndex: 0 })
          text = said
        }
        const calls = blocks(reply, 'toolCall')
        if (!calls.length) return result(false)
        for (const call of calls) {
          sink.tool({ kind: 'build_tool_call', title: call.name, summary: call.name, details: [], phase: 'start', callId: call.id })
          const outcome = await runTool(call, input, host)
          sink.tool({ kind: 'build_tool_result', title: call.name, summary: outcome.text.slice(0, 200), details: [], phase: 'complete', callId: call.id })
          messages.push({ role: 'toolResult', toolCallId: call.id, toolName: call.name, content: [{ type: 'text', text: outcome.text }], isError: Boolean(outcome.isError), timestamp: Date.now() })
          if (input.signal.aborted) return result(true)
        }
      }
    },
    interrupt: async () => 'not_active'
  }
  const approvalOnly: ProviderAdapter = {
    driver: 'claude',
    capabilities: CLAUDE_SUBSCRIPTION_CAPABILITIES,
    configured: () => true,
    startTurn: async () => { throw new Error('An approval-only runtime must never be given a definition turn.') },
    interrupt: async () => 'not_active'
  }
  let stored: unknown = {
    [instanceId]: { driver: 'pi', enabled: true },
    ...Object.fromEntries((options.alsoProviders ?? []).map((provider) => [`pi:${provider}`, { driver: 'pi', enabled: true }])),
    [APPROVAL_ONLY_INSTANCE]: { driver: 'claude', enabled: true }
  }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: stored, seedVersion: 1 }), write: (state) => { stored = state.instances } } })
  const harness = testHarness({
    drivers: [
      adapterDriver(adapter, { toolControl: 'exact', budgets: 'hard', ...options.caps, runtime: { configured: () => true } }),
      adapterDriver(approvalOnly, { budgets: 'hard', runtime: { configured: () => true } })
    ],
    instances,
    profileHome: options.profileHome
  })
  options.orchestrator.setHarness(harness)
  return { harness, instanceId, turns, adapter }
}
