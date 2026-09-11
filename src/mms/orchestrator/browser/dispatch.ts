import { digestToolArguments } from '../../agentDefinitions/runtimePolicy'
import type {
  BrowserAutomationTool,
  BrowserToolContext,
  BrowserToolOutput
} from '../../../shared/browser/automation'
import type { BrowserRuntimePort } from '../../../shared/browser/runtime'
import type { ExecutionContext } from '../../../shared/execution/types'
import { ExecutionPolicyService } from '../../execution/ExecutionPolicyService'
import {
  type BrowserExecutionBinding,
  type HostBrowserTarget,
  isGuiBrowserSource
} from './binding'
import { browserToolCapability, browserToolEffect, isBrowserAutomationTool } from './tools'

const FORGED_HOST_CLAIM_KEYS = new Set([
  'backend',
  'uiTabId',
  'profile',
  'profileId',
  'execution',
  'target',
  'source',
  'threadId',
  'runId',
  'policy',
  'policySnapshotId',
  'cancellationId',
  'actor',
  'turnId',
  'persistent',
  'workspaceId'
])

const MODEL_RESULT_MAX_CHARS = 64 * 1024
const authorizer = new ExecutionPolicyService()

export interface BrowserDispatchResult {
  text: string
  isError: boolean
  dispatched: boolean
}

export function rejectForgedBrowserHostClaims(name: BrowserAutomationTool, args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return 'Browser tool arguments must be an object.'
  }
  const keys = Object.keys(args)
  const forged = keys.filter((key) => FORGED_HOST_CLAIM_KEYS.has(key))
  if (forged.length > 0) {
    return `Browser tool "${name}" cannot include host authority fields: ${forged.join(', ')}.`
  }
  return undefined
}

export function resolveTrustedBrowserTarget(
  port: BrowserRuntimePort,
  execution: ExecutionContext
): { target?: HostBrowserTarget; error?: string } {
  let resolved: BrowserToolContext['target']
  try {
    resolved = port.resolveTarget(execution)
  } catch (error) {
    return { error: formatBrowserError(error, 'Failed to resolve the host browser target.') }
  }
  if (resolved) {
    return { target: resolved }
  }
  if (isGuiBrowserSource(execution.source)) {
    return {
      error:
        'setup_required: Select an in-app browser tab or an explicit managed session before running browser tools.'
    }
  }
  return { target: { backend: 'managed-chromium' } }
}

export async function dispatchBrowserTool(input: {
  port: BrowserRuntimePort
  binding: BrowserExecutionBinding
  name: string
  args: unknown
  signal?: AbortSignal
}): Promise<BrowserDispatchResult> {
  if (!isBrowserAutomationTool(input.name)) {
    return { text: `Unknown browser tool: ${input.name}`, isError: true, dispatched: false }
  }
  if (input.binding.mode === 'disabled') {
    return { text: 'Browser tools are disabled by /settings/browser/mode.', isError: true, dispatched: false }
  }
  if (input.binding.mode !== 'structured') {
    return {
      text: `Browser mode "${input.binding.mode}" is not implemented by this generic tool loop.`,
      isError: true,
      dispatched: false
    }
  }
  if (input.signal?.aborted) {
    return { text: 'Browser tool dispatch was cancelled.', isError: true, dispatched: false }
  }
  const args = (input.args && typeof input.args === 'object' && !Array.isArray(input.args)
    ? input.args
    : {}) as Record<string, unknown>
  const forged = rejectForgedBrowserHostClaims(input.name, args)
  if (forged) return { text: forged, isError: true, dispatched: false }
  const decision = authorizer.authorize(input.binding.execution, input.binding.policy, {
    toolId: input.name,
    classification: browserToolEffect(input.name),
    capability: browserToolCapability(input.name),
    requestDigest: digestToolArguments(args),
    description: input.name
  })
  if (decision.status === 'denied') {
    return {
      text: `Browser tool "${input.name}" is denied by execution policy (${decision.code}).`,
      isError: true,
      dispatched: false
    }
  }
  if (decision.status === 'approval-required') {
    return {
      text: `Browser tool "${input.name}" requires host approval; auto-approve is never defaulted.`,
      isError: true,
      dispatched: false
    }
  }

  const resolved = resolveTrustedBrowserTarget(input.port, input.binding.execution)
  if (resolved.error) return { text: resolved.error, isError: true, dispatched: false }

  const context: BrowserToolContext = {
    execution: input.binding.execution,
    policy: input.binding.policy,
    signal: input.signal,
    vision: input.binding.vision === true,
    target: resolved.target
  }
  try {
    const output = await input.port.dispatch(context, input.name, args)
    return formatBrowserToolOutput(output)
  } catch (error) {
    return { text: formatBrowserError(error, 'Browser tool dispatch failed.'), isError: true, dispatched: true }
  }
}

export function formatBrowserToolOutput(output: BrowserToolOutput): BrowserDispatchResult {
  const actionOutcome = output.action?.outcome
  const isError =
    actionOutcome === 'unknown-effect' ||
    actionOutcome === 'failed' ||
    actionOutcome === 'blocked'
  const payload = {
    untrusted: true,
    provenance: 'untrusted-page' as const,
    session: output.session,
    observation: output.observation ? sanitizeObservation(output.observation) : undefined,
    tabs: output.tabs,
    matches: output.matches,
    observationId: output.observationId,
    action: output.action
      ? {
          requestId: output.action.requestId,
          outcome: output.action.outcome,
          dispatched: output.action.dispatched,
          code: output.action.code,
          message: output.action.message,
          observation: output.action.observation ? sanitizeObservation(output.action.observation) : undefined
        }
      : undefined,
    extraction: output.extraction,
    artifacts: output.artifacts?.map((artifact) => ({
      id: artifact.id,
      mediaType: artifact.mediaType,
      byteLength: artifact.byteLength,
      displayName: artifact.displayName
    })),
    handoff: output.handoff
  }
  return {
    text: boundJson(payload),
    isError,
    dispatched: true
  }
}

function sanitizeObservation(observation: NonNullable<BrowserToolOutput['observation']>): Record<string, unknown> {
  const screenshot = observation.screenshot
  return {
    sessionId: observation.sessionId,
    tabId: observation.tabId,
    generation: observation.generation,
    observationId: observation.observationId,
    documentId: observation.documentId,
    capturedAt: observation.capturedAt,
    url: observation.url,
    title: observation.title,
    viewport: observation.viewport,
    tabs: observation.tabs,
    elements: observation.elements,
    truncated: observation.truncated,
    continuation: observation.continuation,
    warnings: observation.warnings,
    provenance: 'untrusted-page',
    ...(screenshot
      ? {
          screenshot: {
            artifactId: screenshot.artifactId,
            pixelWidth: screenshot.pixelWidth,
            pixelHeight: screenshot.pixelHeight
          }
        }
      : {})
  }
}

function boundJson(value: unknown): string {
  const text = JSON.stringify(value)
  if (text.length <= MODEL_RESULT_MAX_CHARS) return text
  const envelope = (content: string): string => JSON.stringify({
    untrusted: true,
    provenance: 'untrusted-page',
    truncated: true,
    content
  })
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (envelope(text.slice(0, middle)).length <= MODEL_RESULT_MAX_CHARS) low = middle
    else high = middle - 1
  }
  return envelope(text.slice(0, low))
}

function formatBrowserError(error: unknown, fallback: string): string {
  const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : undefined
  const code = typeof record?.code === 'string' ? record.code : undefined
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === 'string'
      ? record.message
      : fallback
  return code ? `${code}: ${message}` : message
}
