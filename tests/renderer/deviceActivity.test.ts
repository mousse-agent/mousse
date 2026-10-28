import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeviceActivityView, type DeviceActivityViewProps } from '../../src/renderer/components/devices/DeviceActivityRows'
import { UserMessage } from '../../src/renderer/chat/components/agent-elements/user-message'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { turnSendersFrom } from '../../src/renderer/hooks/useTurnSenders'
import { activityHeadline, readsLine, ruleLine, rulesLine, showsActivity } from '../../src/renderer/lib/deviceActivity'
import type { Device } from '../../src/renderer/lib/netDevices'
import type { DeviceActivity, DeviceRuleView } from '../../src/shared/bridge/deviceActivity'
import type { ChatMessage } from '../../src/shared/types'

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)
const NODE = 'nod_build' as DeviceActivity['node']

const rule = (patch: Partial<DeviceRuleView['rule']> = {}, view: Partial<DeviceRuleView> = {}): DeviceRuleView => ({
  threadId: 'thread-1',
  threadName: 'Fix the build',
  rule: { id: 'fp-1', permissionKey: 'bash', action: 'command', summary: 'npm run build', grantedUnder: 'full', active: true, createdAt: '2026-10-28T10:00:00Z', ...patch },
  ...view
})

const activity = (patch: Partial<DeviceActivity> = {}): DeviceActivity => ({
  node: NODE,
  since: NOW - 7 * 86_400_000,
  counts: [
    { method: 'orchestrator.send', count: 3 },
    { method: 'orchestrator.answerQuestions', count: 2 },
    { method: 'git.push', count: 1 },
    { method: 'pty.create', count: 1 },
    { method: 'thread.first_use', count: 1 }
  ],
  uncertain: 0,
  refused: 0,
  entries: [
    { at: NOW - 5 * 60_000, method: 'git.push', kind: 'change', outcome: 'ok', thread: { id: 'thread-1', name: 'Fix the build' } },
    { at: NOW - 3_600_000, method: 'files.write', kind: 'refused', outcome: 'thread_not_found', thread: { id: 'gone', name: null } },
    { at: NOW - 2 * 3_600_000, method: 'projects.open', kind: 'change', outcome: 'ok', project: { name: 'docs-site' } },
    { at: NOW - 3 * 3_600_000, method: 'pty.first_open', kind: 'change', outcome: 'first_terminal', thread: { id: 'thread-1', name: 'Fix the build' } }
  ],
  reads: { calls: 120, bytes: 3_500_000, hours: [] },
  rules: [rule()],
  ...patch
})

const view = (patch: Partial<DeviceActivityViewProps> = {}) =>
  renderToStaticMarkup(createElement(DeviceActivityView, {
    name: 'Build Mac', activity: activity(), now: NOW, open: true, busy: false, blocked: false,
    onToggle: () => undefined, onOpenThread: () => undefined, onClearRule: () => undefined, onClearAll: () => undefined,
    onLimits: () => undefined, onBlock: () => undefined, ...patch
  }))
const text = (html: string) => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|')

describe('the Devices screen says what a device did', () => {
  it('leads with a line of plain words', () => {
    expect(activityHeadline(activity())).toBe('Started 3 turns, answered 2 approvals or questions, pushed to a remote, opened a terminal in the last 7 days')
    expect(activityHeadline(activity({ counts: [], uncertain: 2, refused: 5 }))).toBe(
      'Has changed nothing here in the last 7 days · 2 may not have finished · 5 refused'
    )
  })

  it('lists recent actions with links to their threads, and names a project without its path', () => {
    const html = view()
    expect(html).toContain('Pushed to a remote')
    expect(html).toContain('5m ago')
    // A thread opens from its name; one that is gone is plain text.
    expect(html).toMatch(/<button[^>]*class="devices-activity-link"[^>]*>Fix the build<\/button>/)
    expect(html).toContain('a deleted thread')
    expect(html).toContain('Saved a file (refused: the thread was gone)')
    expect(html).toContain('project docs-site')
    expect(html).toContain('Opened its first terminal here')
    expect(html).toContain('It read from this computer 120 times (3.3 MiB) in the last 24 hours.')
    expect(html).not.toMatch(/path:|[A-Z]:\\\\|\/home\//)
  })

  it('keeps Limits and Block beside the activity, and offers Unblock for a blocked device', () => {
    expect(text(view())).toMatch(/Hide details\|Limits…\|Block\|/)
    expect(text(view({ blocked: true }))).toContain('Unblock')
    expect(text(view({ onLimits: undefined }))).not.toContain('Limits…')
  })

  it('shows the list only when it is open', () => {
    const closed = view({ open: false })
    expect(closed).toContain('Show details')
    expect(closed).not.toContain('devices-activity-list')
  })

  it('lists the "Always" rules it made, with Clear for each and for all', () => {
    const html = view({ activity: activity({ rules: [rule(), rule({ id: 'fp-2', action: 'edit', summary: 'src/app.ts', active: false, grantedUnder: 'accept_edits' }, { threadId: 'thread-2', threadName: 'Docs' })] }) })
    expect(html).toContain('&quot;Always&quot; rules made on Build Mac')
    expect(html).toContain('npm run build')
    expect(html).toContain('src/app.ts')
    expect(html).toContain('not in use while the thread asks first')
    expect(html.match(/>Clear<\/button>/g)).toHaveLength(2)
    expect(html).toContain('>Clear all</button>')
    expect(rulesLine(activity({ rules: [rule(), rule({ id: 'fp-2' }, { threadId: 'thread-2' })] }).rules)).toBe(
      '2 rules in 2 threads answer for the owner without asking. Clear them and the next such action asks again.'
    )
    expect(ruleLine(rule())).toBe('allows a command · given under Full access')
  })

  it('shows no rules row when the device made none', () => {
    expect(view({ activity: activity({ rules: [] }) })).not.toContain('Always')
  })

  it('says what it read in the last day', () => {
    expect(readsLine({ calls: 0, bytes: 0, hours: [] })).toBe('It has read nothing from this computer in the last 24 hours.')
    expect(readsLine({ calls: 1, bytes: 900, hours: [] })).toBe('It read from this computer once (900 B) in the last 24 hours.')
  })
})

describe('which devices get an Activity row', () => {
  const computer = (patch: Partial<Device> = {}): Pick<Device, 'kind' | 'policy' | 'caps'> => ({
    kind: 'computer', caps: ['read', 'chat', 'write', 'settings'], policy: { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false }, ...patch
  })
  const quiet = activity({ entries: [], rules: [], counts: [] })

  it('shows a computer that works on threads, even before it has done anything', () => {
    expect(showsActivity(computer(), quiet)).toBe(true)
  })
  it('keeps showing a computer that lost the grant while it has left something behind', () => {
    const lost = computer({ caps: ['read'] })
    expect(showsActivity(lost, quiet)).toBe(false)
    expect(showsActivity(lost, activity({ entries: [], rules: [rule()] }))).toBe(true)
    expect(showsActivity(lost, activity())).toBe(true)
  })
  it('leaves out a phone, a daemon that cannot say, and a daemon that predates limits', () => {
    expect(showsActivity(computer({ kind: 'phone' }), activity())).toBe(false)
    expect(showsActivity(computer(), undefined)).toBe(false)
    expect(showsActivity(computer({ policy: undefined }), activity())).toBe(false)
  })
})

describe('turns sent from another computer are marked in the transcript', () => {
  const message = (patch: Partial<ChatMessage>): ChatMessage => ({ id: 'm', role: 'user', content: 'hello', timestamp: '2026-10-28T10:00:00Z', ...patch })
  const senders = turnSendersFrom({ runs: { 'run-1': { node: NODE, name: 'Build Mac' } } })

  it('marks the user message of a turn the run says another computer sent', () => {
    const ui = mousseToUIMessages([
      message({ id: 'a', turnId: 'run-1' }),
      message({ id: 'b', turnId: 'run-2', content: 'typed here' }),
      message({ id: 'c', content: 'no run yet' }),
      message({ id: 'd', turnId: 'run-1', steered: true, content: 'steered' })
    ], senders)
    const marked = Object.fromEntries(ui.map((entry) => [entry.id, (entry.metadata as { sentFrom?: { name: string } } | undefined)?.sentFrom?.name]))
    expect(marked).toEqual({ a: 'Build Mac', b: undefined, c: undefined, d: undefined })
  })

  it('changes nothing without senders', () => {
    expect(mousseToUIMessages([message({ id: 'a', turnId: 'run-1' })]).every((entry) => !(entry.metadata as { sentFrom?: unknown } | undefined)?.sentFrom)).toBe(true)
  })

  it('shows a small "from <computer>" label under the message', () => {
    const [ui] = mousseToUIMessages([message({ id: 'a', turnId: 'run-1' })], senders)
    const html = renderToStaticMarkup(createElement(UserMessage, { message: ui! }))
    expect(html).toContain('from Build Mac')
    expect(html).toContain('chat-user-sent-from')
    const [plain] = mousseToUIMessages([message({ id: 'a', turnId: 'run-9' })], senders)
    expect(renderToStaticMarkup(createElement(UserMessage, { message: plain! }))).not.toContain('chat-user-sent-from')
  })

  it('reads an unexpected answer as no senders', () => {
    expect(turnSendersFrom(undefined)).toEqual({})
    expect(turnSendersFrom({ runs: { x: { node: NODE, name: '' }, y: null as never } })).toEqual({})
  })
})
