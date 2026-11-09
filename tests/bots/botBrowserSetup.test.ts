/**
 * A bot's first browser use on a computer without the managed browser installs it: allowing the
 * browser is what the download is for. The owner's view shows the setup while it runs; a computer
 * that can't run it says so in plain words.
 */
import { describe, expect, it } from 'vitest'
import { BotBrowsers, type BotBrowserService } from '../../src/mms/bots/browser/BotBrowsers'
import { dispatchBrowserTool } from '../../src/mms/orchestrator/browser/dispatch'
import type { BrowserSetupStatus } from '../../src/shared/browser/setup'
import type { BrowserSessionRecord } from '../../src/shared/browser/types'

const profileId = '33333333-3333-4333-8333-333333333333'

function status(availability: BrowserSetupStatus['availability'], over: Partial<BrowserSetupStatus> = {}): BrowserSetupStatus {
  return { availability, message: availability, channel: 'Stable', platform: { id: 'linux64', supported: true }, canInstall: true, activeManagedSessions: 0, admittedLaunches: 0, inAppNote: '', ...over }
}

/** A browser service that opens one fake managed session. */
function fakeService(): { service: BotBrowserService; opened: string[] } {
  const opened: string[] = []
  let record: BrowserSessionRecord | undefined
  const service = {
    tools: {
      invoke: async (name: string, args: Record<string, unknown>) => {
        if (name === 'browser_open') {
          opened.push(String(args.url))
          record = { id: 'sess_1', profileId, threadId: 'home', persistent: true, workspaceId: String(args.workspaceId), backend: 'managed-chromium', browserVersion: '1', generation: 1, lifecycle: 'agent-controlled', controlLeaseId: 'lease_1', createdAt: '', updatedAt: '' }
          return { ok: true, value: { session: record, observation: { tabId: 'tab_1' } } }
        }
        return { ok: true, value: { observation: { tabId: 'tab_1', sessionId: 'sess_1' } } }
      }
    },
    sessions: {
      trustedSessionScope: () => { if (!record) throw new Error('none'); return { threadId: 'home', record } },
      retireViewerBudget: () => {}
    },
    artifacts: {},
    workspaceDataDir: () => '/nonexistent'
  }
  return { service: service as unknown as BotBrowserService, opened }
}

describe('a bot browser on a computer without the managed browser', () => {
  it('installs it on first use, shows the setup to the owner, then opens the page', async () => {
    const { service, opened } = fakeService()
    const bots = new BotBrowsers({ profileId, browser: () => service, homeThread: () => 'home', setupPollMs: 5 })
    const steps: BrowserSetupStatus[] = [
      status('setup-required'),
      status('installing', { operation: { id: 'op', state: 'running', startedAt: '', updatedAt: '', progress: { phase: 'downloading', receivedBytes: 1, fraction: 0.42 } } }),
      status('installing', { operation: { id: 'op', state: 'running', startedAt: '', updatedAt: '', progress: { phase: 'downloading', receivedBytes: 2, fraction: 0.42 } } }),
      status('ready')
    ]
    let installs = 0
    let seen: Awaited<ReturnType<BotBrowsers['view']>> | undefined
    bots.setSetup({
      status: async () => {
        if (steps.length === 2) seen = await bots.view('bot-cccccccccccc')
        return steps.length > 1 ? steps.shift()! : steps[0]!
      },
      install: async () => { installs += 1; return { status: steps.shift() } }
    })
    const turn = bots.turn({ botId: 'bot-cccccccccccc', activationId: 'act', lane: 'run', homeThreadId: 'home', runId: 'run1', signal: new AbortController().signal })!
    const result = await dispatchBrowserTool({ port: turn.runtime, binding: turn.binding, name: 'browser_open', args: { url: 'https://example.com/' } })
    expect(result.isError, result.text).toBe(false)
    expect(installs).toBe(1)
    expect(opened).toEqual(['https://example.com/'])
    expect(seen).toMatchObject({ open: false, setup: { percent: 42 }, activations: ['act'] })
    expect((await bots.view('bot-cccccccccccc')).setup).toBeUndefined()
  })

  it('says plainly when this computer can\'t run it', async () => {
    const { service, opened } = fakeService()
    const bots = new BotBrowsers({ profileId, browser: () => service, homeThread: () => 'home' })
    bots.setSetup({ status: async () => status('unsupported', { message: 'This platform has no managed Chrome.', canInstall: false }), install: async () => { throw new Error('never') } })
    const turn = bots.turn({ botId: 'bot-cccccccccccc', activationId: 'act', lane: 'chat', homeThreadId: 'home', runId: 'run1', signal: new AbortController().signal })!
    const result = await dispatchBrowserTool({ port: turn.runtime, binding: turn.binding, name: 'browser_open', args: { url: 'https://example.com/' } })
    expect(result.isError).toBe(true)
    expect(result.text).toContain('The browser can\'t run on this computer: This platform has no managed Chrome.')
    expect(opened).toEqual([])
  })
})
