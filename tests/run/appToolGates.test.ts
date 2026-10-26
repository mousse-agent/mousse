/**
 * Call-time gates of the app tools over MCP: Settings turn dev GUI tools off for a runtime that
 * listed them earlier, a quick action's approval goes away with the call that asked for it, and an
 * in-process call acts only while its run is active.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevGuiTools } from '../../src/mms/devgui/DevGuiTools'
import { QuickActionTools } from '../../src/mms/orchestrator/QuickActionTools'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { questionApproval } from '../../src/mms/run/mcp/appTools/quickActions'
import { appToolRegistry, appTurn, fakeAppToolHost } from './appToolsFixture'
import { delegationFixture, type DelegationFixture } from './delegationFixture'

let fx: DelegationFixture | undefined
const previousDevGui = process.env.MOUSSE_DEV_GUI_TOOLS
beforeEach(() => { process.env.MOUSSE_DEV_GUI_TOOLS = '1' })
afterEach(() => {
  fx?.dispose()
  fx = undefined
  if (previousDevGui === undefined) delete process.env.MOUSSE_DEV_GUI_TOOLS
  else process.env.MOUSSE_DEV_GUI_TOOLS = previousDevGui
})

async function setup(hostOverrides: Parameters<typeof fakeAppToolHost>[0] = {}) {
  fx = delegationFixture()
  const run = await fx.runningRun('thread-a')
  const fake = fakeAppToolHost(hostOverrides)
  const { registry, turns, request } = appToolRegistry(fx.engine, fake.host)
  const enabled = new Set<string>(['mousse_gui_status', 'mousse_gui_evaluate', 'create_quick_action'])
  turns.register(appTurn({ threadId: 'thread-a', runId: run.runId, settingsEnabled: (name) => enabled.has(name) }))
  return { run, registry, turns, enabled, ctx: (signal?: AbortSignal) => request({ threadId: 'thread-a', runId: run.runId, ...(signal ? { signal } : {}) }), ...fake }
}

describe('dev GUI tools and Settings', () => {
  it('a tool Settings turned off is refused at call time, even after a runtime listed it', async () => {
    const devGui = new DevGuiTools()
    const execute = vi.spyOn(devGui, 'execute').mockResolvedValue({ text: 'evaluated', isError: false })
    const s = await setup({ devGui })
    // Listed for the thread (the list a native client caches does not follow Settings).
    expect(s.registry.listForThread('thread-a').map((tool) => tool.name)).toEqual(expect.arrayContaining(['mousse_gui_reload', 'mousse_gui_evaluate']))
    // Initially off.
    expect(await s.registry.call('mousse_gui_reload', {}, s.ctx())).toEqual({ text: 'Tool "mousse_gui_reload" is disabled in Settings → Skills & MCP.', isError: true })
    // On, then turned off after the runtime cached its list.
    expect(await s.registry.call('mousse_gui_evaluate', { expression: '1' }, s.ctx())).toMatchObject({ text: 'evaluated' })
    s.enabled.delete('mousse_gui_evaluate')
    expect(await s.registry.call('mousse_gui_evaluate', { expression: '1' }, s.ctx())).toEqual({ text: 'Tool "mousse_gui_evaluate" is disabled in Settings → Skills & MCP.', isError: true })
    expect(execute).toHaveBeenCalledTimes(1)
  })
})

describe('quick-action approval and a cancelled call', () => {
  it('the question goes away with the call, and an answer arriving afterwards creates nothing', async () => {
    const questions = new UserQuestionService()
    const created: unknown[] = []
    const pending: Array<{ requestId: string }> = []
    questions.on('pending', (event: { requestId: string }) => pending.push(event))
    const dismissed: string[] = []
    questions.on('cleared', (event: { requestId: string }) => dismissed.push(event.requestId))
    const s = await setup({ quickActions: new QuickActionTools(questionApproval(questions), (action) => created.push(action)) })
    const closing = new AbortController()
    const call = s.registry.call('create_quick_action', { label: 'Build', kind: 'bash', payload: 'npm run build' }, s.ctx(closing.signal))
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    closing.abort(new Error('The MCP request closed'))
    const outcome = await call
    expect(outcome.text).toMatch(/not created/)
    // The question was withdrawn, so a late answer finds nothing to approve.
    expect(dismissed).toContain(pending[0].requestId)
    expect(questions.submitAnswers(pending[0].requestId, { approval: 'approve' })).toBe(false)
    expect(created).toEqual([])
    questions.shutdown()
  })

  it('an approval that lands after the call was abandoned publishes nothing', async () => {
    const created: unknown[] = []
    const closing = new AbortController()
    // The approval resolves only after the call's signal aborted (a racing answer).
    const tools = new QuickActionTools(async () => {
      closing.abort()
      return true
    }, (action) => created.push(action))
    const outcome = await tools.execute('create_quick_action', { label: 'Build', kind: 'bash', payload: 'npm run build' }, 'thread-a', closing.signal)
    expect(outcome).toMatchObject({ isError: true, text: expect.stringMatching(/cancelled/) })
    expect(created).toEqual([])
  })
})

describe('a turn that fails', () => {
  it('leaves nothing of its app-tool context registered when its runtime throws', async () => {
    const { VendorAdapter, vendorDaemon } = await import('./appToolVendorFixture')
    const d = await vendorDaemon([new VendorAdapter(() => { throw new Error('runtime exploded') })])
    try {
      const registered: string[] = []
      const register = d.orch.appToolTurns.register.bind(d.orch.appToolTurns)
      vi.spyOn(d.orch.appToolTurns, 'register').mockImplementation((turn, options) => {
        registered.push(turn.runId)
        return register(turn, options)
      })
      await d.send('Go').catch(() => undefined)
      expect(registered).toHaveLength(1)
      expect(d.orch.appToolTurns.get(registered[0])).toBeUndefined()
    } finally {
      await d.dispose()
    }
  }, 60_000)

  it('leaves nothing registered when the turn throws before reaching its runtime', async () => {
    const { VendorAdapter, vendorDaemon } = await import('./appToolVendorFixture')
    const d = await vendorDaemon([new VendorAdapter(() => 'unused')])
    try {
      const orch = d.orch as unknown as { executeTurn(...args: unknown[]): Promise<unknown> }
      // The turn body registers its context, then fails on any later step.
      vi.spyOn(d.orch as never, 'executeTurnBody').mockImplementation((async () => {
        d.orch.appToolTurns.register(appTurn({ threadId: d.thread.id, runId: 'run-x' }))
        throw new Error('selection exploded')
      }) as never)
      await expect(orch.executeTurn({ content: 'Go', mode: 'agent' }, false, true, { runId: 'run-x' })).rejects.toThrow('selection exploded')
      expect(d.orch.appToolTurns.get('run-x')).toBeUndefined()
    } finally {
      await d.dispose()
    }
  }, 60_000)
})
