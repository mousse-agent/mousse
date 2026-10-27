/**
 * "Always for this thread" over real daemons (SPEC §17.8): a rule belongs to the one thread it was made
 * in. A subagent's thread and a fork's thread are other threads, so they ask for the very request their
 * parent or source may do without asking.
 */
import { describe, expect, it } from 'vitest'
import type { ApprovalTag } from '../../src/mms/orchestrator/UserQuestionService'
import { useSubagentWorld, type Json } from './subagentWorld'

const approval = (command: string): ApprovalTag => ({
  action: 'command',
  permissionKey: 'claude:command',
  options: [{ id: 'allow', decision: 'allow', scope: 'once' }, { id: 'reject', decision: 'reject' }],
  tool: { name: 'Bash', input: { command }, cwd: '/work/app' }
})
const question = [{ id: 'permission', prompt: 'Allow Claude Code to run a command (Bash)?', options: [{ id: 'allow', label: 'Allow once' }, { id: 'reject', label: 'Reject' }] }]

describe('"Always for this thread" is per thread: forks and subagents ask for themselves', () => {
  const setup = useSubagentWorld()

  /** A world whose parent learns an "always" for `npm test`; every other thread's turn asks for the same command. */
  const world = () => {
    const asked: Array<{ threadId: string; options: string[] }> = []
    let parentId = ''
    let w!: ReturnType<typeof setup>
    const probe = async (threadId: string, command = 'npm test'): Promise<void> => {
      await w.d.questions.requestAnswers(question, threadId, { approval: approval(command) }).catch(() => undefined)
    }
    w = setup(async (input) => {
      await probe(input.threadId)
      return `done: ${input.threadId}`
    })
    parentId = w.parent.id
    // The user says "always" in the parent's thread and "reject" everywhere else.
    w.d.questions.on('pending', (event: { requestId: string; threadId: string; questions: Array<{ options: Array<{ id: string }> }> }) => {
      const options = event.questions[0]!.options.map((option) => option.id)
      asked.push({ threadId: event.threadId, options })
      w.d.questions.submitAnswers(event.requestId, { permission: event.threadId === parentId && options.includes('allow_always') ? 'allow_always' : 'reject' }, { kind: 'user', via: 'gui' })
    })
    return { w, asked, probe }
  }

  it('the parent is asked once and then not; its subagent and its fork are asked for the same request', async () => {
    const { w, asked, probe } = world()
    let child: Json = {}
    w.steps.learn = async () => { await probe(w.parent.id); await probe(w.parent.id) }
    w.steps.delegate = async (tools) => { child = await w.start(tools, 'Child') }

    await w.say('learn', { source: 'gui' })
    // Asked the first time, with "always" offered; the repeat was answered by the rule.
    expect(asked).toEqual([{ threadId: w.parent.id, options: ['allow', 'allow_always', 'reject'] }])
    expect(w.d.engine.approvals.listRules(w.parent.id)).toHaveLength(1)

    await w.say('delegate')
    await w.settled(child.childRunId)
    const childThread = child.childThreadId as string
    // The subagent's thread has its own rules: none. It asked, and could be offered "always" for itself.
    expect(asked.map((entry) => entry.threadId)).toEqual([w.parent.id, childThread])
    expect(w.d.engine.approvals.listRules(childThread)).toEqual([])

    // A fork copies the transcript and the mode, never the rules.
    const forked = await w.d.engine.forkThread({ sourceThreadId: w.parent.id, clientRequestId: 'fork-rules' })
    expect(w.d.engine.approvals.listRules(forked.threadId)).toEqual([])
    await w.d.orch.send('Run the tests', false, { threadId: forked.threadId, clientRequestId: 'fork-turn', source: 'gui' })
    expect(asked.map((entry) => entry.threadId)).toEqual([w.parent.id, childThread, forked.threadId])

    // The parent's own rule is untouched by all of it.
    w.steps.again = async () => { await probe(w.parent.id) }
    await w.say('again', { source: 'gui' })
    expect(asked).toHaveLength(3)
    expect(w.d.engine.approvals.listRules(w.parent.id)).toHaveLength(1)
  })

  it('answers only turns a person started: scheduled, webhook, agent-sent, channel, wake and unknown sources ask as before, and a rule firing says so in the thread', async () => {
    const { w, asked, probe } = world()
    w.steps.learn = async () => { await probe(w.parent.id) }
    w.steps.again = async () => { await probe(w.parent.id) }
    await w.say('learn', { source: 'gui' })
    expect(asked).toHaveLength(1)

    const askedBy = async (extra: { source?: string; origin?: 'schedule' }): Promise<number> => {
      const before = asked.length
      await w.say('again', extra)
      return asked.length - before
    }
    for (const extra of [{ source: 'gui' }, { source: 'cli' }]) expect(await askedBy(extra), JSON.stringify(extra)).toBe(0)
    for (const extra of [
      { source: 'schedule', origin: 'schedule' as const }, { origin: 'schedule' as const, source: 'gui' }, { source: 'schedule' }, { source: 'webhook' },
      { source: 'internal' }, { source: 'agent' }, { source: 'mcp' }, { source: 'channel' }, { source: 'wake' }, { source: 'protocol' }, {}
    ]) {
      expect(await askedBy(extra), JSON.stringify(extra)).toBe(1)
      // The card for such a turn offers no "always" either.
      expect(asked.at(-1)!.options).toEqual(['allow', 'reject'])
    }
    // Two answered by the rule above, and each said so in the thread.
    const notices = w.d.orch.getMessages(w.parent.id).filter((message) => message.content.includes('Allowed without asking by your "Always for this thread" rule'))
    expect(notices).toHaveLength(2)
  })

  it('a rule goes when its thread is deleted', async () => {
    const { w, probe } = world()
    w.steps.learn = async () => { await probe(w.parent.id) }
    await w.say('learn', { source: 'gui' })
    expect(w.d.engine.approvals.listRules(w.parent.id)).toHaveLength(1)

    w.d.orch.markThreadDeleted(w.parent.id)
    expect(w.d.engine.approvals.listRules(w.parent.id)).toEqual([])
  })
})
