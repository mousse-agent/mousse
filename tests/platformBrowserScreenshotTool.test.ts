import { describe, expect, it, vi } from 'vitest'
import type { BrowserToolContext } from '../src/shared/browser/automation'
import { BrowserToolDispatcher } from '../src/mms/browser/automation/BrowserToolDispatcher'
import type { BrowserSessionManager } from '../src/mms/browser/automation/BrowserSessionManager'
import { browserToolCapability, browserToolEffect, getBrowserToolDefinitions, isBrowserAutomationTool } from '../src/mms/orchestrator/browser/tools'

describe('optional browser screenshot tool', () => {
  it('advertises screenshots only to image-capable models while preserving semantic tools', () => {
    expect(getBrowserToolDefinitions().map((tool) => tool.name)).not.toContain('browser_screenshot')
    expect(getBrowserToolDefinitions().map((tool) => tool.name)).toContain('browser_observe')
    const tool = getBrowserToolDefinitions({ vision: true }).find((item) => item.name === 'browser_screenshot')!
    expect(tool.parameters.required).toEqual(['sessionId'])
    expect(tool.parameters.additionalProperties).toBe(false)
    expect(tool.description).toMatch(/Do not take screenshots routinely/)
    expect(isBrowserAutomationTool(tool.name)).toBe(true)
    expect(browserToolEffect('browser_screenshot')).toBe('read')
    expect(browserToolCapability('browser_screenshot')).toBe('browser.observe')
  })

  it('refuses capture before touching the browser for text-only models', async () => {
    const observe = vi.fn()
    const dispatcher = new BrowserToolDispatcher({ sessions: { observe } as unknown as BrowserSessionManager })
    const result = await dispatcher.invoke('browser_screenshot', { sessionId: 'session-1' }, { vision: false } as BrowserToolContext)
    expect(result).toMatchObject({ ok: false, error: { code: 'unsupported' } })
    expect(observe).not.toHaveBeenCalled()
  })

  it('captures the requested tab using screenshot-specific authorization and returns its observation', async () => {
    const output = { observation: { screenshot: { artifactId: 'shot-1' }, observationId: 'observation-1' } }
    const observe = vi.fn().mockResolvedValue(output)
    const dispatcher = new BrowserToolDispatcher({ sessions: { observe } as unknown as BrowserSessionManager })
    const context = { vision: true } as BrowserToolContext
    expect(await dispatcher.invoke('browser_screenshot', { sessionId: 'session-1', tabId: 'tab-2' }, context)).toEqual({ ok: true, value: output })
    expect(observe).toHaveBeenCalledWith(context, { sessionId: 'session-1', tabId: 'tab-2', includeScreenshot: true }, 'browser_screenshot')
    observe.mockClear()
    expect(await dispatcher.invoke('browser_screenshot', { sessionId: 'session-1', includeScreenshot: false }, context)).toMatchObject({ ok: false, error: { code: 'invalid_action' } })
    expect(observe).not.toHaveBeenCalled()
  })
})
