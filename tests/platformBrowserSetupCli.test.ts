import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prepareBrowserCommand, executeBrowserCommand, BROWSER_HELP } from '../src/cli/commands/browser'
import type { ParsedArgs } from '../src/cli/parseArgs'
import {
  BROWSER_SETUP_IN_APP_NOTE,
  type BrowserSetupStatus
} from '../src/shared/browser/setup'

function args(subcommand: string, positional: string[] = [], flags: Array<[string, string | boolean]> = [], globals: Partial<ParsedArgs['globals']> = {}): ParsedArgs {
  return {
    globals: {
      homeDir: '',
      mode: 'json',
      print: false,
      continueSession: false,
      version: false,
      help: false,
      ...globals
    },
    command: 'browser',
    subcommand,
    positional,
    flags: new Map(flags),
    raw: []
  }
}

const idle: BrowserSetupStatus = {
  availability: 'setup-required',
  message: 'No managed Chrome version is active.',
  channel: 'Stable',
  platform: { id: 'linux64', supported: true },
  canInstall: true,
  activeManagedSessions: 0,
  admittedLaunches: 0,
  inAppNote: BROWSER_SETUP_IN_APP_NOTE
}

describe('browser CLI argument validation', () => {
  it('validates commands and rejects installer bypass flags before any transport', () => {
    expect(prepareBrowserCommand(args('status'))).toEqual({ command: 'status', wait: false })
    expect(prepareBrowserCommand(args('install'))).toEqual({ command: 'install', wait: true })
    expect(prepareBrowserCommand(args('install', [], [['no-wait', true]]))).toEqual({ command: 'install', wait: false })
    const id = randomUUID()
    expect(prepareBrowserCommand(args('cancel', [id]))).toEqual({ command: 'cancel', operationId: id, wait: false })
    expect(() => prepareBrowserCommand(args('install', [], [['channel', 'Beta']]))).toThrow(/--channel/)
    expect(() => prepareBrowserCommand(args('install', [], [['url', 'https://example.invalid']]))).toThrow(/--url/)
    expect(() => prepareBrowserCommand(args('install', [], [['path', 'C:\\\\chrome']]))).toThrow(/--path/)
    expect(() => prepareBrowserCommand(args('install', [], [['hash', 'abc']]))).toThrow(/--hash/)
    expect(() => prepareBrowserCommand(args('cancel', ['not-a-uuid']))).toThrow(/UUID/)
    expect(() => prepareBrowserCommand(args('cancel'))).toThrow(/exactly one operation id/)
    expect(() => prepareBrowserCommand(args('status', ['extra']))).toThrow(/positional/)
    expect(() => prepareBrowserCommand(args('download'))).toThrow(/Unknown browser command/)
    expect(() => prepareBrowserCommand(args('install', [], [], { provider: 'xai' }))).toThrow(/provider/)
    expect(BROWSER_HELP).toContain('mousse-cli browser status')
    expect(BROWSER_HELP).toContain('exact operation')
  })
})

describe('browser CLI transport', () => {
  it('starts install, polls without overlapping requests, and cancels by exact operation id', async () => {
    const operationId = randomUUID()
    let statusCalls = 0
    let inflight = 0
    let max = 0
    let state: BrowserSetupStatus = {
      ...idle,
      availability: 'installing',
      canInstall: false,
      operation: {
        id: operationId,
        state: 'running',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        progress: { phase: 'downloading', receivedBytes: 10, totalBytes: 100, fraction: 0.1 }
      }
    }
    const request = vi.fn(async (method: string, params?: unknown) => {
      inflight += 1
      max = Math.max(max, inflight)
      try {
        if (method === 'browser.setup.install') {
          expect(params).toEqual({})
          return { operationId, status: state }
        }
        if (method === 'browser.setup.status') {
          statusCalls += 1
          if (statusCalls >= 2) {
            state = {
              ...idle,
              availability: 'ready',
              version: '123.0.0.1',
              canInstall: false,
              operation: { ...state.operation!, state: 'succeeded', progress: { phase: 'complete', receivedBytes: 100, fraction: 1 } }
            }
          }
          return state
        }
        throw new Error('unexpected ' + method)
      } finally {
        inflight -= 1
      }
    })
    const events: unknown[] = []
    const code = await executeBrowserCommand(
      { command: 'install', wait: true },
      { request },
      { emit: (value) => events.push(value), pollMs: 5 }
    )
    expect(code).toBe(0)
    expect(request.mock.calls[0][0]).toBe('browser.setup.install')
    expect(max).toBe(1)
    expect(statusCalls).toBeGreaterThanOrEqual(2)
    expect(events.at(-1)).toMatchObject({ availability: 'ready' })

    const cancel = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe('browser.setup.cancel')
      expect(params).toEqual({ operationId })
      return { operationId, status: { ...idle, operation: { ...state.operation!, state: 'cancelling' } } }
    })
    await executeBrowserCommand({ command: 'cancel', operationId, wait: false }, { request: cancel }, { emit: () => undefined })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not cancel an install when the wait client disconnects', async () => {
    const operationId = randomUUID()
    const controller = new AbortController()
    const request = vi.fn(async (method: string) => {
      if (method === 'browser.setup.install') {
        return {
          operationId,
          status: {
            ...idle,
            availability: 'installing',
            canInstall: false,
            operation: {
              id: operationId,
              state: 'running',
              startedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              progress: { phase: 'downloading', receivedBytes: 1 }
            }
          }
        }
      }
      if (method === 'browser.setup.status') {
        controller.abort()
        return {
          ...idle,
          availability: 'installing',
          canInstall: false,
          operation: {
            id: operationId,
            state: 'running',
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            progress: { phase: 'downloading', receivedBytes: 1 }
          }
        }
      }
      throw new Error('must not cancel on disconnect')
    })
    const code = await executeBrowserCommand(
      { command: 'install', wait: true },
      { request },
      { emit: () => undefined, signal: controller.signal, pollMs: 5 }
    )
    expect(code).toBe(130)
    expect(request.mock.calls.map((call) => call[0])).toEqual(['browser.setup.install', 'browser.setup.status'])
  })
})
