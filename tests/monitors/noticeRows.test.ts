/**
 * A monitor's notice and another agent's note in the transcript (issue #1605): the daemon attaches what each reports to
 * the wake message, and the transcript draws one quiet row per notice that opens in place on the words, never the
 * notice text as a message from the person.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { OpenableNoticeRow } from '../../src/renderer/chat/components/agent-elements/tools/SubagentNotice'
import { SubagentCardsContext } from '../../src/renderer/chat/components/agent-elements/tools/subagent-cards-context'
import { monitorNoticeLine } from '../../src/renderer/chat/adapters/subagentNotice'
import { planWakeNotice } from '../../src/mms/run/delegation/notice'
import type { AgentNotePayload, InboxRecord, MonitorEventPayload, ThreadWakePayload } from '../../src/mms/run/types'
import type { SubagentNoticeItem } from '../../src/shared/subagents'

const row = (payload: unknown): InboxRecord => ({ inboxId: 'i1', threadId: 'parent', kind: 'reconcile_notice', payload }) as unknown as InboxRecord
const monitorEvent = (patch: Partial<MonitorEventPayload> = {}): MonitorEventPayload => ({
  kind: 'monitor_event', monitorId: 'mon-1', monitorKind: 'command', description: 'Build log', events: ['step 1 ok', 'step 2 ok'], attention: 'needed', ...patch
})
const note: AgentNotePayload = { kind: 'agent_note', senderThreadId: 'child-1', senderRunId: 'r1', senderTitle: 'Reviewer', senderAccess: 'agent', from: 'subagent', text: 'I took the parser.', attention: 'needed' }

describe('the daemon attaches what the notice reports', () => {
  it('a monitor event and a note each become an item; the agent still reads the full notice text', () => {
    const planned = planWakeNotice([row(monitorEvent({ droppedEvents: 2, end: { reason: 'exit', code: 3 } })), row(note)])
    expect(planned.items).toEqual([
      { delegationId: 'mon-1', childThreadId: 'parent', title: 'Build log', runStatus: 'monitor', fullyShown: true, event: 'monitor', monitor: { kind: 'command', lines: ['step 1 ok', 'step 2 ok'], dropped: 2, end: { reason: 'exit', code: 3 } } },
      { delegationId: '', childThreadId: 'child-1', title: 'Reviewer', runStatus: 'note', fullyShown: true, event: 'note', note: { from: 'subagent', text: 'I took the parser.' } }
    ])
    expect(planned.text).toContain('<mousse_notice kind="monitor_event"')
    expect(planned.text).toContain('<mousse_notice kind="agent_note"')
  })
})

describe('the row', () => {
  const item = (monitor: SubagentNoticeItem['monitor'], title: string | null = 'Build log'): SubagentNoticeItem =>
    ({ delegationId: 'mon-1', childThreadId: 't', title, runStatus: 'monitor', fullyShown: true, event: 'monitor', monitor })

  it.each([
    [{ kind: 'command', lines: ['a', 'b', 'c'] }, 'Monitor “Build log”', '3 new lines', 'done'],
    [{ kind: 'command', lines: ['a'], dropped: 4 }, 'Monitor “Build log”', '5 new lines', 'done'],
    [{ kind: 'command', lines: ['done'], end: { reason: 'exit', code: 0 } }, 'Monitor “Build log”', '1 new line · finished', 'done'],
    [{ kind: 'background', lines: [], end: { reason: 'exit', code: 2 } }, 'Command “Build log”', 'exited with code 2', 'failed'],
    [{ kind: 'command', lines: [], end: { reason: 'timeout', minutes: 10 } }, 'Monitor “Build log”', 'timed out after 10 min', 'stopped'],
    [{ kind: 'url', lines: [], end: { reason: 'chatty', limit: 'x' } }, 'Monitor “Build log”', 'stopped: too much output', 'failed'],
    [{ kind: 'command', lines: [], end: { reason: 'stopped' } }, 'Monitor “Build log”', 'stopped by you', 'stopped'],
    [{ kind: 'keep_working', lines: [], end: { reason: 'timeout', minutes: 30 } }, 'Waiting “Build log”', 'timed out after 30 min', 'stopped'],
    [{ kind: 'command', lines: [], end: { reason: 'restart' } }, 'Monitor “Build log”', 'ended when Mousse restarted', 'stopped']
  ] as const)('%j reads as %s: %s', (monitor, name, detail, tone) => {
    expect(monitorNoticeLine(item(monitor as SubagentNoticeItem['monitor']))).toEqual({ name, detail, tone })
  })

  it('opens in place on the lines and a command\'s last output; closed, it shows only its line', () => {
    const background = item({ kind: 'background', lines: [], end: { reason: 'exit', code: 1 }, tail: '1 test failed\n' })
    const closed = renderToStaticMarkup(createElement(OpenableNoticeRow, { item: background }))
    expect(closed).toContain('aria-expanded="false"')
    expect(closed).not.toContain('1 test failed')
    const open = renderToStaticMarkup(createElement(OpenableNoticeRow, { item: background, initiallyOpen: true }))
    expect(open).toContain('<pre class="subagent-notice-words" data-kind="monitor">1 test failed</pre>')
    // An end with nothing to show cannot be opened.
    expect(renderToStaticMarkup(createElement(OpenableNoticeRow, { item: item({ kind: 'command', lines: [], end: { reason: 'restart' } }) }))).toContain('disabled')
  })
})

describe('the transcript', () => {
  const message = (id: string, role: 'user' | 'assistant', parts: unknown[], metadata?: unknown): UIMessage =>
    ({ id, role, parts, createdAt: '2026-11-20T12:00:00.000Z', metadata }) as unknown as UIMessage
  const render = (messages: UIMessage[]) =>
    renderToStaticMarkup(createElement(SubagentCardsContext.Provider, { value: new Map() }, createElement(MessageList, { messages, status: 'ready' })))

  it('draws a monitor\'s notice and a note as quiet rows, not as something the user wrote', () => {
    const planned = planWakeNotice([row(monitorEvent()), row(note)])
    const html = render([
      message('wake', 'user', [{ type: 'text', text: planned.text }], { subagentNotice: planned.items }),
      message('a1', 'assistant', [{ type: 'text', text: 'Noted.' }])
    ])
    expect(html).toContain('Monitor “Build log”')
    expect(html).toContain('2 new lines')
    expect(html).toContain('Subagent “Reviewer”')
    expect(html).toContain('sent a note')
    expect(html).not.toContain('mousse_notice')
    expect(html).not.toContain('chat-user-bubble')
    expect(html).toContain('Noted.')
  })

  it('draws a due wake-up as a quiet row that opens on its brief', () => {
    const wake: ThreadWakePayload = { kind: 'thread_wake', wakeId: 'wake-1', label: 'Following up · acme/app#12 · checks passed', brief: 'Merge it if green.', text: '<mousse_notice kind="thread_wake">\nA wake-up you set is due.\n</mousse_notice>', attention: 'needed' }
    const timed: ThreadWakePayload = { ...wake, wakeId: 'wake-2', label: 'Following up', brief: 'Check the nightly.' }
    const planned = planWakeNotice([row(wake), row(timed)])
    const html = render([message('wake', 'user', [{ type: 'text', text: planned.text }], { subagentNotice: planned.items })])
    expect(html).toContain('Wake-up')
    expect(html).toContain('acme/app#12 · checks passed')
    expect(html).toContain('>due<')
    expect(html).not.toContain('mousse_notice')
    expect(html).not.toContain('chat-user-bubble')
    const open = renderToStaticMarkup(createElement(OpenableNoticeRow, { item: planned.items[0]!, initiallyOpen: true }))
    expect(open).toContain('<div class="subagent-notice-words" data-kind="note">Merge it if green.</div>')
  })
})
