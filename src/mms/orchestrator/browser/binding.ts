import type { AgentExecutionRequest, AgentExecutionSource, AgentRuntimeHostBindings } from '../../../shared/agents/execution'
import type { AgentBrowserMode, ResolvedAgentDefinition } from '../../../shared/agents/types'
import type { BrowserRuntimePort } from '../../../shared/browser/runtime'
import type { BrowserToolContext } from '../../../shared/browser/automation'
import type { ExecutionContext, ExecutionPolicySnapshot, ExecutionSource } from '../../../shared/execution/types'
import { ExecutionPolicyService } from '../../execution/ExecutionPolicyService'
import { browserToolCapability, isBrowserAutomationTool } from './tools'

export type AgentRuntimeHostWithBrowser = AgentRuntimeHostBindings & {
  browserRuntime?: BrowserRuntimePort
}

/** Trusted per-run browser binding. Never deserialized from model arguments. */
export interface BrowserExecutionBinding {
  execution: ExecutionContext
  policy: ExecutionPolicySnapshot
  mode: AgentBrowserMode
  vision?: boolean
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

/** Copy and freeze caller-owned authority before a provider attempt or host callback can observe it. */
export function snapshotBrowserExecutionBinding(binding: BrowserExecutionBinding): BrowserExecutionBinding {
  return deepFreeze(structuredClone(binding))
}

const BROWSER_RUNTIME_HOST_BINDING =
  'OrchestratorService.setBrowserRuntime / MmsAgentExecutionService.setBrowserRuntime (BrowserRuntimePort from src/shared/browser/runtime.ts)'

export function readHostBrowserRuntime(host: AgentRuntimeHostBindings | undefined): BrowserRuntimePort | undefined {
  if (!host || !('browserRuntime' in host)) return undefined
  const port = (host as AgentRuntimeHostWithBrowser).browserRuntime
  if (!port || typeof port !== 'object') return undefined
  if (typeof port.resolveTarget !== 'function' || typeof port.dispatch !== 'function') return undefined
  return port
}

export function browserRuntimeHostBindingMessage(): string {
  return BROWSER_RUNTIME_HOST_BINDING
}

export function mapAgentSourceToExecutionSource(source: AgentExecutionSource): ExecutionSource {
  if (source === 'cli') return 'cli'
  if (source === 'schedule') return 'schedule'
  if (source === 'channel') return 'channel'
  return 'gui'
}

export function isGuiBrowserSource(source: ExecutionSource): boolean {
  return source === 'gui'
}

export function createDefinitionBrowserBinding(input: {
  request: AgentExecutionRequest
  runId: string
  resolved: ResolvedAgentDefinition
}): BrowserExecutionBinding | undefined {
  const mode = input.resolved.settings.browser.mode
  if (mode === 'disabled') return undefined
  const source = mapAgentSourceToExecutionSource(input.request.source ?? 'editor')
  const grantedBrowserTools = input.resolved.grants.builtinTools
    .map((grant) => grant.id)
    .filter(isBrowserAutomationTool)
  const allowedCapabilities = [...new Set(grantedBrowserTools.map(browserToolCapability))]
  const policy = new ExecutionPolicyService().snapshot(
    input.request.profileId,
    {
      allowedTools: grantedBrowserTools,
      allowedCapabilities,
      allowedEffects: ['read', 'external'],
      maxToolCalls: input.resolved.settings.limits.maxToolCalls,
      maxElapsedMs: input.resolved.settings.limits.maxElapsedMs
    }
  )
  const execution: ExecutionContext = {
    profileId: input.request.profileId,
    threadId: input.request.threadId,
    turnId: input.runId,
    runId: input.runId,
    actor: {
      kind: 'agent',
      definitionId: input.resolved.definitionId,
      definitionRevision: input.resolved.revision
    },
    policySnapshotId: policy.id,
    source,
    cancellationId: input.runId
  }
  return snapshotBrowserExecutionBinding({
    execution,
    policy,
    mode,
    vision: false
  })
}

export type HostBrowserTarget = NonNullable<BrowserToolContext['target']>
