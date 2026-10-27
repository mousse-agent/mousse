import { describe, expect, it } from 'vitest'
import type { AgentActivityItem } from '../../src/shared/agentActivity'
import type { ChatMessage } from '../../src/shared/types'
import {
  closeStaleActivity,
  cutOffActivityOf,
  formatRestartNote,
  RESTART_NOTE_LABEL_CHARS,
  RESTART_NOTE_MAX_ENTRIES,
  type RestartNote
} from '../../src/mms/run/restartNote'

const note = (patch: Partial<RestartNote> = {}): RestartNote => ({
  runIds: ['r1'],
  uncertainRunIds: [],
  cutOffTools: [],
  epoch: 2,
  ...patch
})

describe('formatRestartNote', () => {
  it('reports interrupted runs only when nothing is uncertain', () => {
    expect(formatRestartNote(note({ runIds: ['r1', 'r2'] }))).toBe(
      'The Mousse daemon restarted during the previous turn. Interrupted: 2 run(s).'
    )
  })

  it('mentions queued runs that had not started, with or without an interrupted run', () => {
    expect(formatRestartNote(note({ queuedRunIds: ['q1'] }))).toBe(
      'The Mousse daemon restarted during the previous turn. Interrupted: 1 run(s). Queued before the restart: 1 run(s).'
    )
    expect(formatRestartNote(note({ runIds: [], queuedRunIds: ['q1', 'q2'] }))).toBe(
      'The Mousse daemon restarted before this turn started. Queued before the restart: 2 run(s).'
    )
  })

  it('lists the non-idempotent tools of uncertain runs once each', () => {

    const text = formatRestartNote(
      note({
        runIds: ['r1', 'r2'],
        uncertainRunIds: ['r1'],
        cutOffTools: [
          { runId: 'r1', invocationId: 'i1', tool: 'bash', idempotent: false },
          { runId: 'r1', invocationId: 'i2', tool: 'read_file', idempotent: true },
          { runId: 'r1', invocationId: 'i3', tool: 'bash', idempotent: false },
          { runId: 'r1', invocationId: 'i4', tool: 'write_file', idempotent: false },
          { runId: 'r2', invocationId: 'i5', tool: 'edit_file', idempotent: false }
        ]
      })
    )
    expect(text).toBe(
      'The Mousse daemon restarted during the previous turn. Interrupted: 2 run(s). ' +
        'These tool calls may have run without a recorded result; verify before repeating: ' +
        'bash, write_file.'
    )
  })

  describe('cut-off activity', () => {
    const HEADER = 'This work was cut off and will not report back on its own; resume or restart what you still need:'

    it('adds nothing when no activity was cut off', () => {
      const plain = formatRestartNote(note())
      expect(formatRestartNote(note({ cutOffActivity: [] }))).toBe(plain)
      expect(plain).not.toContain(HEADER)
    })

    it('lists each command and subagent on its own line, with the native id of a subagent', () => {
      const text = formatRestartNote(
        note({
          cutOffActivity: [
            { kind: 'command', label: 'npm test' },
            { kind: 'subagent', label: 'Find the auth bug', nativeId: 'task-7' },
            { kind: 'subagent', label: 'Explore' },
            { kind: 'other', label: 'Edit src/a.ts' }
          ]
        })
      )
      expect(text).toBe(
        'The Mousse daemon restarted during the previous turn. Interrupted: 1 run(s). ' +
          `${HEADER}\n- command: npm test\n- subagent: Find the auth bug (id task-7)\n- subagent: Explore\n- Edit src/a.ts`
      )
    })

    it('collapses whitespace, cuts a label at the limit and lists a repeated entry once', () => {
      const long = `echo ${'x'.repeat(500)}`
      const text = formatRestartNote(
        note({
          cutOffActivity: [
            { kind: 'command', label: 'npm   run\n\tbuild' },
            { kind: 'command', label: 'npm run build' },
            { kind: 'command', label: long }
          ]
        })
      )
      const lines = text.split('\n').slice(1)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toBe('- command: npm run build')
      expect(lines[1]!.slice('- command: '.length)).toHaveLength(RESTART_NOTE_LABEL_CHARS)
      expect(lines[1]).toMatch(/…$/)
    })

    it('lists at most ten entries and counts the rest, however many were cut off', () => {
      const many = Array.from({ length: 500 }, (_, index) => ({ kind: 'command' as const, label: `job ${index} ${'y'.repeat(400)}` }))
      const text = formatRestartNote(note({ cutOffActivity: many }))
      const lines = text.split('\n').slice(1)
      expect(lines).toHaveLength(RESTART_NOTE_MAX_ENTRIES + 1)
      expect(lines.at(-1)).toBe('- and 490 more')
      // Ten labels of at most 160 characters plus their prefixes, whatever the count or the length of a command.
      expect(text.length).toBeLessThan(RESTART_NOTE_MAX_ENTRIES * (RESTART_NOTE_LABEL_CHARS + 24) + 400)
    })

    it('exactly ten entries add no "and more" line', () => {
      const ten = Array.from({ length: 10 }, (_, index) => ({ kind: 'command' as const, label: `job ${index}` }))
      expect(formatRestartNote(note({ cutOffActivity: ten }))).not.toContain('more')
    })

    it('cuts a long native id and keeps credentials out of labels', () => {
      const text = formatRestartNote(
        note({
          cutOffActivity: [
            { kind: 'command', label: 'API_TOKEN=abc123 npm run deploy --password hunter2' },
            { kind: 'command', label: 'curl -H "Authorization: Bearer sk-live-abcdef123456" https://x.test' },
            { kind: 'subagent', label: 'Explore', nativeId: 'n'.repeat(300) }
          ]
        })
      )
      expect(text).toContain('command: API_TOKEN=[redacted] npm run deploy --password [redacted]')
      expect(text).not.toMatch(/abc123|hunter2|sk-live|Bearer/)
      expect(text).toContain(`(id ${'n'.repeat(64)})`)
      expect(text).not.toContain('n'.repeat(65))
    })
  })
})

const at = '2026-10-27T10:00:00.000Z'

function row(id: string, activity: AgentActivityItem, patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role: 'system',
    kind: 'mcp_tool_call',
    content: '',
    timestamp: at,
    toolCall: { title: activity.toolName, summary: '', details: [], status: activity.status === 'running' ? 'processing' : 'complete' },
    activity,
    ...patch
  } as ChatMessage
}

const command = (id: string, status: AgentActivityItem['status'], runId: string | undefined, text: string, extra: Record<string, unknown> = {}): ChatMessage =>
  row(id, { id, callId: `call-${id}`, toolName: 'Bash', kind: 'command', command: text, status, startedAt: at, ...(runId ? { runId } : {}), ...extra } as AgentActivityItem)

describe('cutOffActivityOf', () => {
  it('names the interrupted commands, subagents and other work of the listed runs only', () => {
    const messages: ChatMessage[] = [
      command('c1', 'interrupted', 'r1', "bash -lc 'npm test'", { interruptedBy: 'stop' }),
      row('s1', { id: 's1', callId: 'a', toolName: 'Agent', kind: 'subagent', description: 'Find the auth bug', nativeId: 'task-7', status: 'interrupted', interruptedBy: 'daemon_restart', startedAt: at, runId: 'r1' }),
      row('f1', { id: 'f1', callId: 'b', toolName: 'Edit', kind: 'file_change', changes: [{ path: 'src/a.ts', change: 'update' }], status: 'interrupted', startedAt: at, runId: 'r1' }),
      row('g1', { id: 'g1', callId: 'c', toolName: 'mcp__docs__search', kind: 'generic', status: 'interrupted', startedAt: at, runId: 'r1' }),
      command('done', 'done', 'r1', 'ls'),
      command('failed', 'failed', 'r1', 'false'),
      command('other-run', 'interrupted', 'r2', 'npm run lint'),
      command('old', 'interrupted', undefined, 'npm run old')
    ]
    expect(cutOffActivityOf(messages, ['r1'])).toEqual([
      { runId: 'r1', kind: 'command', label: 'npm test' },
      { runId: 'r1', kind: 'subagent', label: 'Find the auth bug', nativeId: 'task-7' },
      { runId: 'r1', kind: 'other', label: 'Edit src/a.ts' },
      { runId: 'r1', kind: 'other', label: 'mcp__docs__search' }
    ])
    expect(cutOffActivityOf(messages, [])).toEqual([])
  })

  it('falls back to the agent type, then a plain word, for a subagent without a description', () => {
    const sub = (id: string, extra: Record<string, unknown>) =>
      row(id, { id, callId: id, toolName: 'Agent', kind: 'subagent', status: 'interrupted', startedAt: at, runId: 'r1', ...extra } as AgentActivityItem)
    expect(cutOffActivityOf([sub('a', { agentType: 'explorer' }), sub('b', {})], ['r1']).map((entry) => entry.label)).toEqual(['explorer', 'subagent'])
  })

  it('never reads output, cwd, a prompt or a result', () => {
    const messages = [
      command('c1', 'interrupted', 'r1', 'npm test', { output: 'SECRET OUTPUT sk-abcdef123456', cwd: '/home/secret-dir' }),
      row('g1', { id: 'g1', callId: 'g', toolName: 'delegate_task', kind: 'generic', input: { prompt: 'SECRET PROMPT TEXT' }, output: 'SECRET RESULT', status: 'interrupted', startedAt: at, runId: 'r1' }, {
        toolCall: { title: 'delegate_task', summary: '', details: [], status: 'complete', input: { prompt: 'SECRET PROMPT TEXT' } },
        content: 'SECRET PROMPT TEXT'
      })
    ]
    const text = formatRestartNote(note({ cutOffActivity: cutOffActivityOf(messages, ['r1']) }))
    expect(text).toContain('command: npm test')
    expect(text).toContain('delegate_task')
    expect(text).not.toMatch(/SECRET|sk-abcdef|secret-dir/)
  })

  it('commands come before subagents and the rest, so the cap never hides them', () => {
    const entries = [
      ...Array.from({ length: 12 }, (_, index) => row(`g${index}`, { id: `g${index}`, callId: `g${index}`, toolName: `tool${index}`, kind: 'generic', status: 'interrupted', startedAt: at, runId: 'r1' })),
      command('c1', 'interrupted', 'r1', 'npm test')
    ]
    const text = formatRestartNote(note({ cutOffActivity: cutOffActivityOf(entries, ['r1']) }))
    expect(text.split('\n')[1]).toBe('- command: npm test')
    expect(text).toMatch(/- and 3 more$/)
  })
})

describe('closeStaleActivity', () => {
  const endedAt = '2026-10-27T11:00:00.000Z'

  it('ends running items as interrupted by a restart and leaves everything else alone', () => {
    const running = command('c1', 'running', 'r1', 'npm test')
    const done = command('c2', 'done', 'r1', 'ls', { endedAt: at })
    const stopped = command('c3', 'interrupted', 'r1', 'sleep 9', { interruptedBy: 'stop' })
    const plain: ChatMessage = { id: 'm1', role: 'user', content: 'hi', timestamp: at }
    const closed = closeStaleActivity([running, done, stopped, plain], endedAt)
    expect([...closed.keys()]).toEqual(['c1'])
    expect(closed.get('c1')).toMatchObject({
      activity: { status: 'interrupted', interruptedBy: 'daemon_restart', summary: 'Cut off by a Mousse restart', endedAt, command: 'npm test', runId: 'r1' },
      toolCall: { status: 'complete' }
    })
    // The input rows are not changed in place.
    expect(running.activity?.status).toBe('running')
  })

  it('is idempotent: a second sweep over the result changes nothing', () => {
    const first = closeStaleActivity([command('c1', 'running', 'r1', 'npm test')], endedAt)
    const swept = [...first.values()]
    expect(closeStaleActivity(swept, '2026-10-27T12:00:00.000Z').size).toBe(0)
    expect(swept[0]!.activity?.endedAt).toBe(endedAt)
  })

  it('also ends a subagent and its nested child', () => {
    const parent = row('s1', { id: 's1', callId: 'a', toolName: 'Agent', kind: 'subagent', status: 'running', startedAt: at, runId: 'r1' })
    const child = command('c1', 'running', 'r1', 'npm test', { parentId: 's1' })
    const closed = closeStaleActivity([parent, child], endedAt)
    expect([...closed.values()].map((message) => message.activity?.status)).toEqual(['interrupted', 'interrupted'])
  })
})
