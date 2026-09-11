import type { BrowserWorkflowRequest } from '../../../shared/browser/automation'
import { BrowserAutomationError } from './BrowserSessionManager'
import { BrowserToolDispatcher } from './BrowserToolDispatcher'

export class ManagedBrowserWorkflowAdapter {
  constructor(private readonly tools: BrowserToolDispatcher) {}

  async invoke(request: BrowserWorkflowRequest): Promise<{ output: unknown; artifacts?: import('../../../shared/execution/types').ArtifactReference[] }> {
    const context = { execution: request.context, policy: request.policy, signal: request.signal, vision: request.vision }
    const input = isRecord(request.input) ? request.input : {}
    if (request.nodeType === 'browser-session') {
      const result = await this.tools.invoke('browser_open', { ...input, ...request.config }, context)
      return this.unwrap(result)
    }
    if (request.nodeType === 'browser-observe') {
      const result = await this.tools.invoke('browser_observe', { ...request.config, ...input }, context)
      return this.unwrap(result)
    }
    if (request.nodeType === 'browser-action') {
      const result = await this.tools.invoke('browser_act', { ...request.config, ...input, action: isRecord(request.config.action) ? request.config.action : (input.action ?? request.config.action) }, context)
      return this.unwrap(result)
    }
    if (request.nodeType === 'browser-extract') {
      const result = await this.tools.invoke('browser_extract', { ...request.config, ...input }, context)
      return this.unwrap(result)
    }
    const tool = typeof request.config.tool === 'string' ? request.config.tool : typeof request.config.toolName === 'string' ? request.config.toolName : undefined
    if (!tool || !['browser_open', 'browser_tabs', 'browser_observe', 'browser_find', 'browser_act', 'browser_wait', 'browser_extract', 'browser_request_human'].includes(tool)) {
      throw new BrowserAutomationError({ code: 'unsupported', message: 'browser-task requires one bounded browser tool name' })
    }
    const result = await this.tools.invoke(tool as Parameters<BrowserToolDispatcher['invoke']>[0], { ...(isRecord(request.config.args) ? request.config.args : {}), ...input }, context)
    return this.unwrap(result)
  }

  private unwrap(result: Awaited<ReturnType<BrowserToolDispatcher['invoke']>>): { output: unknown; artifacts?: import('../../../shared/execution/types').ArtifactReference[] } {
    if (!result.ok) throw new BrowserAutomationError(result.error)
    return { output: result.value, artifacts: result.value.artifacts }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
