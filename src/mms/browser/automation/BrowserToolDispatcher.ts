import { browserNavigationUrl, validateBrowserAction, validateBrowserWait } from '../../../shared/browser/validation'
import {
  type BrowserAutomationTool,
  type BrowserRequestHumanArgs,
  type BrowserToolContext,
  type BrowserToolDescriptor,
  type BrowserToolError,
  type BrowserToolResult
} from '../../../shared/browser/automation'
import { BrowserAutomationError, BrowserSessionManager } from './BrowserSessionManager'

const DESCRIPTORS: readonly BrowserToolDescriptor[] = [
  { name: 'browser_open', description: 'Open a session on the host-selected in-app tab or managed browser and return its initial observation.', capability: 'browser.session', vision: false, effect: 'external' },
  { name: 'browser_tabs', description: 'List or mutate tabs supported by the current browser session.', capability: 'browser.session', vision: false, effect: 'external' },
  { name: 'browser_observe', description: 'Collect a bounded structured observation and optional screenshot.', capability: 'browser.observe', vision: true, effect: 'read' },
  { name: 'browser_screenshot', description: 'Capture a tab viewport only when semantic observation is insufficient for visual inspection.', capability: 'browser.observe', vision: true, effect: 'read' },
  { name: 'browser_find', description: 'Find observed elements by bounded text or role query.', capability: 'browser.observe', vision: false, effect: 'read' },
  { name: 'browser_act', description: 'Perform one validated browser action against a fresh observation.', capability: 'browser.action', vision: true, effect: 'external' },
  { name: 'browser_wait', description: 'Wait for an explicit bounded browser condition.', capability: 'browser.observe', vision: false, effect: 'read' },
  { name: 'browser_extract', description: 'Extract bounded untrusted text from an observed browser region.', capability: 'browser.extract', vision: false, effect: 'read' },
  { name: 'browser_request_human', description: 'Create a durable human-control handoff for a browser session.', capability: 'browser.task', vision: false, effect: 'external' }
]

export interface BrowserToolDispatcherOptions {
  sessions: BrowserSessionManager
  requestHuman?: (input: { context: BrowserToolContext; request: BrowserRequestHumanArgs }) => Promise<{ requestId: string; state: 'waiting-human' }>
}

export class BrowserToolDispatcher {
  readonly catalog = DESCRIPTORS
  constructor(private readonly options: BrowserToolDispatcherOptions) {}

  describe(): readonly BrowserToolDescriptor[] { return this.catalog }

  async invoke(name: BrowserAutomationTool, args: unknown, context: BrowserToolContext): Promise<BrowserToolResult> {
    try {
      const descriptor = DESCRIPTORS.find((item) => item.name === name)
      if (!descriptor) return { ok: false, error: { code: 'unsupported', message: `Unknown browser tool ${name}` } }
      if (descriptor.vision && !context.vision && name === 'browser_act' && containsImagePoint(args)) {
        return { ok: false, error: { code: 'unsupported', message: 'Coordinate browser actions require a B2 vision-capable adapter and an exact screenshot observation' } }
      }
      if (name === 'browser_open') {
        const input = object(args, ['url', 'persistent', 'workspaceId'])
        if (input.url !== undefined) browserNavigationUrl(input.url)
        return { ok: true, value: await this.options.sessions.open(context, { url: optionalString(input.url), persistent: optionalBoolean(input.persistent), workspaceId: optionalString(input.workspaceId) }) }
      }
      if (name === 'browser_tabs') {
        const input = object(args)
        return { ok: true, value: await this.options.sessions.tabs(context, requiredString(input.sessionId), { operation: optionalEnum(input.operation, ['list', 'new', 'switch', 'close']), tabId: optionalString(input.tabId), url: optionalString(input.url) }) }
      }
      if (name === 'browser_observe') {
        const input = object(args)
        if (input.includeScreenshot === true && !context.vision) return { ok: false, error: { code: 'unsupported', message: 'Screenshots require an explicitly vision-capable browser adapter' } }
        return { ok: true, value: await this.options.sessions.observe(context, { sessionId: requiredString(input.sessionId), tabId: optionalString(input.tabId), ref: optionalString(input.ref), includeScreenshot: optionalBoolean(input.includeScreenshot), maxElements: optionalNumber(input.maxElements) }) }
      }
      if (name === 'browser_screenshot') {
        if (!context.vision) return { ok: false, error: { code: 'unsupported', message: 'Browser screenshots require a model with image input support. Use browser_observe or browser_find instead.' } }
        const input = object(args, ['sessionId', 'tabId'])
        return { ok: true, value: await this.options.sessions.observe(context, { sessionId: requiredString(input.sessionId), tabId: optionalString(input.tabId), includeScreenshot: true }, 'browser_screenshot') }
      }
      if (name === 'browser_find') {
        const input = object(args)
        return { ok: true, value: await this.options.sessions.find(context, { sessionId: requiredString(input.sessionId), tabId: requiredString(input.tabId), query: requiredString(input.query, 240), role: optionalString(input.role), ref: optionalString(input.ref) }) }
      }
      if (name === 'browser_act') {
        const input = object(args)
        const action = validateBrowserAction(input.action)
        return { ok: true, value: await this.options.sessions.act(context, { sessionId: requiredString(input.sessionId), tabId: requiredString(input.tabId), generation: requiredInteger(input.generation), observationId: requiredString(input.observationId), controlLeaseId: requiredString(input.controlLeaseId), action, timeoutMs: optionalNumber(input.timeoutMs), expected: input.expected === undefined ? undefined : validateBrowserWait(input.expected) }) }
      }
      if (name === 'browser_wait') {
        const input = object(args)
        return { ok: true, value: await this.options.sessions.wait(context, { sessionId: requiredString(input.sessionId), tabId: requiredString(input.tabId), condition: validateBrowserWait(input.condition), timeoutMs: optionalNumber(input.timeoutMs) }) }
      }
      if (name === 'browser_extract') {
        const input = object(args)
        return { ok: true, value: await this.options.sessions.extract(context, { sessionId: requiredString(input.sessionId), tabId: requiredString(input.tabId), ref: optionalString(input.ref), schema: input.schema }) }
      }
      const input = object(args) as unknown as BrowserRequestHumanArgs
      if (!this.options.requestHuman) return { ok: false, error: { code: 'approval_required', message: 'Human browser handoff is not configured by the host' } }
      const request = { sessionId: requiredString(input.sessionId), reason: requiredString(input.reason, 4096), operation: optionalString(input.operation) }
      this.options.sessions.assertHumanHandoffOwned(context, request)
      return { ok: true, value: { handoff: await this.options.requestHuman({ context, request }) } }
    } catch (error) {
      return { ok: false, error: normalizeError(error) }
    }
  }
}

function object(value: unknown, allowedKeys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Browser tool arguments must be an object' })
  if (allowedKeys && Object.keys(value).some((key) => !allowedKeys.includes(key))) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Unexpected browser tool argument; the host selects the browser target' })
  return value as Record<string, unknown>
}
function requiredString(value: unknown, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Invalid browser tool string argument' })
  return value
}
function optionalString(value: unknown, max = 4096): string | undefined { return value === undefined ? undefined : requiredString(value, max) }
function optionalBoolean(value: unknown): boolean | undefined { if (value === undefined) return undefined; if (typeof value !== 'boolean') throw new BrowserAutomationError({ code: 'invalid_action', message: 'Invalid browser boolean argument' }); return value }
function optionalNumber(value: unknown): number | undefined { if (value === undefined) return undefined; if (typeof value !== 'number' || !Number.isFinite(value)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Invalid browser numeric argument' }); return value }
function requiredInteger(value: unknown): number { const n = optionalNumber(value); if (n === undefined || !Number.isSafeInteger(n) || n < 1) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Invalid browser generation argument' }); return n }
function optionalEnum<T extends string>(value: unknown, values: readonly T[]): T | undefined { if (value === undefined) return undefined; if (typeof value !== 'string' || !values.includes(value as T)) throw new BrowserAutomationError({ code: 'invalid_action', message: 'Invalid browser operation' }); return value as T }
function containsImagePoint(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsImagePoint)
  if ((value as { kind?: unknown }).kind === 'image-point') return true
  return Object.values(value as Record<string, unknown>).some(containsImagePoint)
}
function normalizeError(error: unknown): BrowserToolError {
  if (error instanceof BrowserAutomationError) return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) }
  if (error instanceof Error && 'code' in error) return { code: String((error as Error & { code?: unknown }).code), message: error.message }
  return { code: 'invalid_action', message: error instanceof Error ? error.message : String(error) }
}
