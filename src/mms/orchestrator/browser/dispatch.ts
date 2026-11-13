import { digestToolArguments } from '../../agentDefinitions/runtimePolicy'
import type {
  BrowserAutomationTool,
  BrowserToolContext,
  BrowserToolOutput
} from '../../../shared/browser/automation'
import type { BrowserRuntimePort } from '../../../shared/browser/runtime'
import type { ExecutionContext } from '../../../shared/execution/types'
import { BROWSER_PROBLEM_CODES, browserNoteForAgent, browserProblemForAgent, type BrowserNavigation, type BrowserNoteReader, type BrowserProblem } from '../../../shared/browser/navigation'
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
  image?: { data: string; mimeType: 'image/png' }
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

  let userAllowed = false
  try {
    userAllowed = await input.port.requestAccess?.(input.binding.execution, input.signal) === 'allowed'
  } catch (error) {
    return { text: formatBrowserError(error, 'Browser access request failed.'), isError: true, dispatched: false }
  }
  if (input.name === 'browser_screenshot' && !input.binding.vision) {
    return { text: 'This model does not support image input. Use browser_observe or browser_find instead.', isError: true, dispatched: false }
  }
  const resolved = resolveTrustedBrowserTarget(input.port, input.binding.execution)
  const accessNotice = userAllowed ? 'The user selected Allow for agents browser access.\n' : ''
  if (resolved.error) return { text: accessNotice + resolved.error, isError: true, dispatched: false }

  const context: BrowserToolContext = {
    execution: input.binding.execution,
    policy: input.binding.policy,
    signal: input.signal,
    vision: input.binding.vision === true,
    target: resolved.target
  }
  // A bot has no sign-in of its own: a page's sign-in form, or a check a person can pass, is its owner's to do.
  const actor = input.binding.execution.actor
  const reader: BrowserNoteReader = actor.kind === 'agent' && actor.definitionId?.startsWith('bot:') ? 'bot' : 'agent'
  try {
    const output = await input.port.dispatch(context, input.name, args)
    const result = formatBrowserToolOutput(output, reader)
    const screenshot = output.observation?.screenshot
    if (input.name === 'browser_screenshot') {
      if (!context.vision || !input.port.readScreenshot || !screenshot || !output.observation) {
        return { text: accessNotice + 'Screenshot image delivery is unavailable for this model or browser session.', isError: true, dispatched: true }
      }
      result.image = await input.port.readScreenshot(context, output.observation.sessionId, screenshot.artifactId)
    }
    return userAllowed ? { ...result, text: accessNotice + result.text } : result
  } catch (error) {
    // A page that failed in its class: a bot hears what to do next in its owner's terms.
    const problem = (error as { details?: { problem?: BrowserProblem } } | undefined)?.details?.problem
    const text = problem && reader === 'bot' && BROWSER_PROBLEM_CODES[problem.kind]
      ? `${BROWSER_PROBLEM_CODES[problem.kind]}: ${browserProblemForAgent(problem, reader)}`
      : formatBrowserError(error, 'Browser tool dispatch failed.')
    return { text: accessNotice + text, isError: true, dispatched: true }
  }
}

/**
 * How a page went, for the model: its state; for a failure, its class and what to do next; for a
 * page that opened, what it shows that the model may deal with (never an order to stop); a download
 * it started instead, or the address the tab really ended on. Still loading is no failure.
 */
function navigationForModel(navigation: BrowserNavigation | undefined, reader: BrowserNoteReader): Record<string, unknown> | undefined {
  if (!navigation) return undefined
  const notes = [
    ...(navigation.state === 'loading' ? ['Still loading. This is not a failure: carry on with what is there, or browser_wait with {"type":"document-ready"}.'] : []),
    ...(navigation.download ? [`This address started a download (${navigation.download.name}) instead of opening a page; the tab stays on ${navigation.url}.`] : []),
    ...(navigation.replaced ? [`Another navigation replaced the one to ${navigation.replaced.asked}: the tab is on ${navigation.url}.`] : []),
    ...(navigation.notes ?? []).map((note) => browserNoteForAgent(note, reader))
  ]
  return {
    url: navigation.url,
    state: navigation.state,
    ...(navigation.download ? { download: navigation.download.name } : {}),
    ...(navigation.notes?.length ? { shows: navigation.notes.map((note) => note.kind === 'http-status' ? `http-${note.status}` : note.kind) } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {}),
    ...(navigation.problem ? { problem: BROWSER_PROBLEM_CODES[navigation.problem.kind], ...(navigation.problem.reason ? { reason: navigation.problem.reason } : {}), next: browserProblemForAgent(navigation.problem, reader) } : {})
  }
}

export function formatBrowserToolOutput(output: BrowserToolOutput, reader: BrowserNoteReader = 'agent'): BrowserDispatchResult {
  const actionOutcome = output.action?.outcome
  const isError =
    actionOutcome === 'unknown-effect' ||
    actionOutcome === 'failed' ||
    actionOutcome === 'blocked' ||
    output.navigation?.state === 'failed' ||
    output.action?.navigation?.state === 'failed'
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
          // A person took the browser over while it ran: whether it took effect (applied, not-applied, unknown).
          ...(output.action.takeover ? { takeover: output.action.takeover } : {}),
          code: output.action.code,
          message: output.action.message,
          navigation: navigationForModel(output.action.navigation, reader),
          observation: output.action.observation ? sanitizeObservation(output.action.observation) : undefined
        }
      : undefined,
    navigation: navigationForModel(output.navigation, reader),
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
