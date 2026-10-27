// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotActivationSummary, BotApprovalView, BotSummary } from '../../src/shared/bots/personal/definition'
import type { BotEscalationSummary } from '../../src/shared/bots/personal/escalation'
import { BOTS_PERSONAL_METHODS } from '../../src/shared/bots/personal/methods'
import { ActivationRow, ApprovalDialog, BotsWorkspace, EscalationRow, keepFolderAccess, shellNote } from '../../src/renderer/components/bots/BotsWorkspace'
import { createPersonalBotsClient, type PersonalBotsClient } from '../../src/renderer/services/personalBotsClient'
import { bridgeProtocolEvent } from '../../src/main/mms/protocolEventBridge'
import { GUI_REQUIRED_METHODS } from '../../src/main/mms/guiDaemonCompatibility'
import { PLATFORM_REQUEST_METHODS } from '../../src/main/ipc/registerGuiIpc'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() }, BrowserWindow: { getAllWindows: () => [] }, Notification: class {}, app: {}, shell: {}, dialog: {}, clipboard: {}, nativeTheme: {}, webContents: {} }))

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = { personalBots: { onChanged: () => () => {}, onEscalation: () => () => {} } }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)

const activation = (patch: Partial<BotActivationSummary> = {}): BotActivationSummary => ({
  id: 'act_00000000-0000-4000-8000-000000000001',
  botId: 'site-editor',
  revision: 'r'.repeat(64),
  status: 'paused',
  threadId: null,
  trigger: { kind: 'manual', input: 'Fix the footer' },
  createdAt: '2026-10-27T10:00:00.000Z',
  endedAt: null,
  endReason: 'unknown_calls',
  result: null,
  counters: { requests: 3, toolCalls: 2, activeMs: 90_000 },
  unknownCalls: [{ runId: 'run-1234567890', invocationId: 'inv-1', tool: 'edit', role: 'consult', acknowledged: false }],
  openEscalation: null,
  canContinue: true,
  canMarkDone: true,
  uncertain: false,
  uncertainRunId: null,
  ...patch
})

const escalation = (patch: Partial<BotEscalationSummary> = {}): BotEscalationSummary => ({
  id: 'esc-1',
  activationId: 'act_00000000-0000-4000-8000-000000000001',
  botId: 'site-editor',
  dispatchN: 1,
  kind: 'gate',
  permission: { path: '/home/me/blog', access: 'read' },
  permissionText: 'Read files in /home/me/blog',
  reason: 'It tried to read a file outside its folders.',
  status: 'open',
  createdAt: '2026-10-27T10:00:00.000Z',
  expiresAt: '2026-10-27T10:30:00.000Z',
  answeredAt: null,
  amount: null,
  ...patch
})

describe('Bots tab: activity rows', () => {
  it('Continue and Mark done wait for "I\'ve checked what these calls did", then acknowledge', async () => {
    const onContinue = vi.fn()
    const onMarkDone = vi.fn()
    act(() => root.render(createElement(ActivationRow, { activation: activation(), busy: false, onStop: () => {}, onContinue, onMarkDone })))
    expect(document.body.textContent).toContain('edit')
    expect(document.body.textContent).toContain('context thread')
    expect(button('Continue')!.disabled).toBe(true)
    expect(button('Mark done')!.disabled).toBe(true)
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(button('Continue')!.disabled).toBe(false)
    await act(async () => button('Continue')!.click())
    // Each action sends exactly the set shown, and the box clears after it.
    expect(onContinue).toHaveBeenCalledWith({ calls: [activation().unknownCalls[0].invocationId], uncertainRunId: null })
    expect(button('Mark done')!.disabled).toBe(true)
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await act(async () => button('Mark done')!.click())
    expect(onMarkDone).toHaveBeenCalledWith({ calls: [activation().unknownCalls[0].invocationId], uncertainRunId: null })
  })

  it('a new set of interrupted calls on the same activation needs the box again', async () => {
    const onContinue = vi.fn()
    const first = activation()
    act(() => root.render(createElement(ActivationRow, { activation: first, busy: false, onStop: () => {}, onContinue, onMarkDone: () => {} })))
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(button('Continue')!.disabled).toBe(false)
    const next = activation({ unknownCalls: [...first.unknownCalls, { runId: 'run-2', invocationId: 'inv-new', tool: 'write', role: 'main', acknowledged: false }] })
    act(() => root.render(createElement(ActivationRow, { activation: next, busy: false, onStop: () => {}, onContinue, onMarkDone: () => {} })))
    expect(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false)
    expect(button('Continue')!.disabled).toBe(true)
  })

  it('an activation with nothing to check continues without the box', async () => {
    const onContinue = vi.fn()
    act(() => root.render(createElement(ActivationRow, { activation: activation({ unknownCalls: [], canMarkDone: false, endReason: 'restarted_twice' }), busy: false, onStop: () => {}, onContinue, onMarkDone: () => {} })))
    expect(document.querySelector('input[type="checkbox"]')).toBeNull()
    expect(button('Mark done')).toBeUndefined()
    await act(async () => button('Continue')!.click())
    expect(onContinue).toHaveBeenCalledWith(undefined)
  })

  it('an uncertain run needs the box even with no listed call', () => {
    act(() => root.render(createElement(ActivationRow, { activation: activation({ unknownCalls: [], uncertain: true, uncertainRunId: 'run-u' }), busy: false, onStop: () => {}, onContinue: () => {}, onMarkDone: () => {} })))
    expect(button('Continue')!.disabled).toBe(true)
  })
})

describe('Bots tab: escalation inbox', () => {
  it('offers allow for this bot, allow this time and deny', async () => {
    const onAnswer = vi.fn()
    act(() => root.render(createElement(EscalationRow, { escalation: escalation(), botName: 'Site editor', busy: false, onAnswer })))
    expect(document.body.textContent).toContain('Site editor asks: Read files in /home/me/blog')
    await act(async () => button('Allow for this bot')!.click())
    await act(async () => button('Allow this time')!.click())
    await act(async () => button('Deny')!.click())
    expect(onAnswer.mock.calls).toEqual([['allow_bot'], ['allow_once'], ['deny']])
  })

  it('a work-time wall asks for minutes and sends milliseconds', async () => {
    const onAnswer = vi.fn()
    act(() => root.render(createElement(EscalationRow, { escalation: escalation({ kind: 'budget', permission: { budget: { key: 'maxActiveMs' } }, permissionText: 'More work time' }), botName: 'Site editor', busy: false, onAnswer })))
    expect(button('Allow for this bot')).toBeUndefined()
    await act(async () => button('Allow 15 min more this time')!.click())
    expect(onAnswer).toHaveBeenCalledWith('allow_more', 15 * 60_000)
  })
})

describe('Bots tab: approval', () => {
  const approval = (ok: boolean): BotApprovalView => ({
    revision: 'r'.repeat(64),
    digest: 'd'.repeat(64),
    added: [{ kind: 'workspace', text: 'Read files in /home/me/site' }],
    threads: [{ key: 'main', instanceId: 'codex', model: 'gpt', ok, ...(ok ? {} : { reason: 'Codex can\'t limit tools to this list.' }) }]
  })

  it('Approve stays disabled until every thread passes', () => {
    act(() => root.render(createElement(ApprovalDialog, { name: 'Site editor', approval: approval(false), busy: false, onApprove: () => {}, onClose: () => {} })))
    expect(document.body.textContent).toContain('Read files in /home/me/site')
    expect(document.body.textContent).toContain('Codex can\'t limit tools to this list.')
    expect(button('Approve')!.disabled).toBe(true)
    act(() => root.render(createElement(ApprovalDialog, { name: 'Site editor', approval: approval(true), busy: false, onApprove: () => {}, onClose: () => {} })))
    expect(button('Approve')!.disabled).toBe(false)
  })

  it('the shell note names the bot\'s folders', () => {
    expect(shellNote(['/home/me/site'])).toContain('Tools installed system-wide, or inside /home/me/site, still work.')
  })
})

describe('Bots tab: list', () => {
  it('lists bots with the inbox badge and the open escalations', async () => {
    const bot: BotSummary = { id: 'site-editor', name: 'Site editor', role: 'Keeps the site tidy', draftHash: 'h'.repeat(64), revision: 'h'.repeat(64), grant: { digest: 'd'.repeat(64), approvedAt: 'now' }, needsApproval: [], openEscalations: 1 }
    const client = {
      list: vi.fn(async () => [bot]),
      escalations: vi.fn(async () => [escalation(), escalation({ id: 'esc-2', status: 'denied' })])
    } as unknown as PersonalBotsClient
    await act(async () => root.render(createElement(BotsWorkspace, { client, providers: [], skills: [] })))
    expect(document.querySelector('.bots__badge')?.textContent).toBe('1')
    expect(document.body.textContent).toContain('Waiting for you')
    expect(document.querySelectorAll('.bots__escalation')).toHaveLength(1)
  })
})

describe('Bots wiring', () => {
  it('every personal-bot method is allowed through the bridge and required of the daemon', () => {
    for (const method of BOTS_PERSONAL_METHODS) {
      expect(PLATFORM_REQUEST_METHODS.has(method)).toBe(true)
      expect(GUI_REQUIRED_METHODS).toContain(method)
    }
  })

  it('the client calls each method with exact params', async () => {
    const request = vi.fn(async (method: string) => method === 'bots.definitions.list' ? { bots: [] } : method === 'bots.escalations.list' ? { escalations: [] } : {})
    const client = createPersonalBotsClient({ request } as never)
    await client.list()
    await client.continue('act_x', { calls: ['inv-1'], uncertainRunId: 'run-u' })
    await client.markDone('act_x')
    await client.respond('esc-1', 'allow_more', 60_000)
    await client.escalations()
    expect(request.mock.calls).toEqual([
      ['bots.definitions.list', {}],
      ['bots.activations.continue', { activationId: 'act_x', acknowledge: { calls: ['inv-1'], uncertainRunId: 'run-u' } }],
      ['bots.activations.markDone', { activationId: 'act_x' }],
      ['bots.escalations.respond', { escalationId: 'esc-1', answer: 'allow_more', amount: 60_000 }],
      ['bots.escalations.list', {}]
    ])
  })

  it('bridges bots.changed and bots.escalation to the renderer', () => {
    const broadcast = vi.fn()
    const presentation = { getActiveThreadId: () => null } as never
    expect(bridgeProtocolEvent({ type: 'bots.changed', data: { botId: 'site-editor' } } as never, broadcast, presentation)).toBe(true)
    expect(bridgeProtocolEvent({ type: 'bots.escalation', data: escalation() } as never, broadcast, presentation)).toBe(true)
    expect(broadcast.mock.calls).toEqual([['bots:changed', { botId: 'site-editor' }], ['bots:escalation', escalation()]])
  })
})

describe('Bots tab: editor folders', () => {
  it('changing the access setting or the folder list keeps the access set for each folder', () => {
    const mixed = { roots: ['/a', '/b'], access: 'read' as const, rootAccess: { '/b': 'write' as const } }
    // A folder whose own access differs from the setting keeps it.
    expect(keepFolderAccess(['/a', '/b'], { ...mixed, access: 'write', rootAccess: { '/a': 'read' } })).toEqual({ roots: ['/a', '/b'], access: 'write', rootAccess: { '/a': 'read' } })
    expect(keepFolderAccess(['/a', '/b', '/c'], mixed)).toEqual({ roots: ['/a', '/b', '/c'], access: 'read', rootAccess: { '/b': 'write' } })
    expect(keepFolderAccess(['/a'], mixed)).toEqual({ roots: ['/a'], access: 'read' })
  })
})
