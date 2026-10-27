/**
 * Permission requests of ACP agents: options keep their identity and scope, only the agent's
 * once-only options are shown (a native "always" would outlive the thread's mode), a stopped turn
 * answers `cancelled`, and the thread's permission mode decides what is answered without asking.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { PermissionMode } from '../../src/shared/permissionMode'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import {
  answerPermission,
  classifyGenericOption,
  keepOption,
  questionsPrompter,
  writeWorkspaceFile,
  type AcpRequestScope,
  type PermissionPrompter
} from '../../src/mms/harness/acp/permissions'

const options: RequestPermissionRequest['options'] = [
  { optionId: 'once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  { optionId: 'never', name: 'Always reject', kind: 'reject_always' }
]
const request = (kind?: NonNullable<RequestPermissionRequest['toolCall']['kind']>): RequestPermissionRequest => ({
  sessionId: 's',
  toolCall: { toolCallId: 'c', title: 'Run npm test', ...(kind ? { kind } : {}) },
  options
})

function scope(permissionMode: PermissionMode | undefined = 'ask', aborted = false, cwd = '/w'): AcpRequestScope {
  return { threadId: 'thread', cwd, permissionMode, aborted: () => aborted, throwIfAborted: () => {} }
}

function prompter(answer: string | undefined): PermissionPrompter & { choose: ReturnType<typeof vi.fn> } {
  return { choose: vi.fn(async () => answer) }
}

const classify = { label: 'Agent', classify: classifyGenericOption }
const cancelled = { outcome: { outcome: 'cancelled' } }
const selected = (optionId: string) => ({ outcome: { outcome: 'selected', optionId } })

describe('ACP permission options', () => {
  it('classifies scopes and says that "always" may outlive the session', () => {
    expect(options.map(classifyGenericOption)).toEqual([
      { optionId: 'once', kind: 'allow_once', label: 'Allow', scope: 'once' },
      { optionId: 'always', kind: 'allow_always', label: 'Always allow (the agent may remember this beyond this session)', scope: 'persistent' },
      { optionId: 'no', kind: 'reject_once', label: 'Reject', scope: 'once' },
      { optionId: 'never', kind: 'reject_always', label: 'Always reject', scope: 'persistent' }
    ])
    expect(keepOption(options[1]!).label).toBe('Always allow')
  })

  it('shows only the once-only options: a native "always" or "session" option is never offered', async () => {
    const ask = prompter('once')
    expect(await answerPermission(ask, scope(), request(), classify)).toEqual(selected('once'))
    expect(ask.choose.mock.calls[0][0]).toMatchObject({ threadId: 'thread', title: 'Run npm test' })
    expect(ask.choose.mock.calls[0][0].options.map((option: { optionId: string }) => option.optionId)).toEqual(['once', 'no'])
    // A preset that keeps the agent's own labels hides them too.
    const kept = prompter('once')
    await answerPermission(kept, scope(), request(), { label: 'Agent', classify: keepOption })
    expect(kept.choose.mock.calls[0][0].options.map((option: { optionId: string }) => option.optionId)).toEqual(['once', 'no'])
  })

  it('cancels an answer outside the shown options, a stopped turn, and an agent that offers only "always"', async () => {
    expect(await answerPermission(prompter('always'), scope(), request(), classify)).toEqual(cancelled)
    const ask = prompter('once')
    expect(await answerPermission(ask, scope('ask', true), request(), classify)).toEqual(cancelled)
    expect(ask.choose).not.toHaveBeenCalled()
    const alwaysOnly = { ...request(), options: options.filter((option) => option.kind.endsWith('always')) }
    expect(await answerPermission(ask, scope('full'), alwaysOnly, classify)).toEqual(cancelled)
  })

  it('answers cancelled when the turn stops while the user decides', async () => {
    let stopped = false
    const ask: PermissionPrompter = { choose: async () => { stopped = true; return 'once' } }
    const live: AcpRequestScope = { ...scope(), aborted: () => stopped }
    expect(await answerPermission(ask, live, request(), classify)).toEqual(cancelled)
  })
})

describe('ACP permission requests under a permission mode', () => {
  it('asks for everything under Ask', async () => {
    for (const kind of ['edit', 'execute', 'read'] as const) {
      const ask = prompter('no')
      expect(await answerPermission(ask, scope('ask'), request(kind), classify)).toEqual(selected('no'))
      expect(ask.choose).toHaveBeenCalledTimes(1)
    }
  })

  it('answers a file change with the once-only allow under Auto-accept edits, and asks for anything else', async () => {
    for (const kind of ['edit', 'delete', 'move'] as const) {
      const ask = prompter('no')
      expect(await answerPermission(ask, scope('accept_edits'), request(kind), classify)).toEqual(selected('once'))
      expect(ask.choose).not.toHaveBeenCalled()
    }
    const ask = prompter('no')
    expect(await answerPermission(ask, scope('accept_edits'), request('execute'), classify)).toEqual(selected('no'))
    expect(ask.choose).toHaveBeenCalledTimes(1)
  })

  it('answers every request with the once-only allow under Full access, without a prompt, turn after turn', async () => {
    const ask = prompter('no')
    for (const kind of ['execute', 'edit', 'fetch', undefined] as const) {
      expect(await answerPermission(ask, scope('full'), request(kind), classify)).toEqual(selected('once'))
    }
    expect(ask.choose).not.toHaveBeenCalled()
  })

  it('asks when a request arrives outside a turn', async () => {
    const ask = prompter('no')
    expect(await answerPermission(ask, scope(undefined), request('edit'), classify)).toEqual(selected('no'))
    expect(ask.choose).toHaveBeenCalledTimes(1)
  })

  it('tells the prompter what kind of action is asked about, so who may answer is decided by the rule', async () => {
    const ask = prompter('once')
    await answerPermission(ask, scope('ask'), request('execute'), classify)
    // The agent's own description of the call travels with it: it is what a saved request is fingerprinted by.
    expect(ask.choose.mock.calls[0][0].approval).toMatchObject({ action: 'command', permissionKey: 'acp:execute', tool: { name: 'execute' } })
    const questions = new UserQuestionService()
    questions.setLineageSource(() => null)
    const waiter = questionsPrompter(questions).choose({ threadId: 'thread', title: 'Edit?', options: options.map(classifyGenericOption).filter((option) => option.scope === 'once'), approval: { action: 'edit', permissionKey: 'acp:edit' } })
    const requestId = questions.listPendingForThread('thread')[0]!.requestId
    // The agent's own option ids are mapped to what they mean.
    expect(questions.settle(requestId, { permission: 'once' }, { kind: 'user' })).toEqual({ ok: true, decision: 'allow' })
    await expect(waiter).resolves.toBe('once')
  })
})

describe('ACP client file writes', () => {
  const writeFrom = (mode: PermissionMode | undefined, answer?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'mousse-acp-write-'))
    const questions = new UserQuestionService()
    const asked: string[] = []
    questions.on('pending', (event: { requestId: string; questions: Array<{ prompt: string }> }) => {
      asked.push(event.questions[0]!.prompt)
      if (answer) questions.submitAnswers(event.requestId, { write: answer }, { kind: 'user' })
    })
    const done = writeWorkspaceFile(questions, scope(mode, false, dir), { sessionId: 's', path: join(dir, 'a.txt'), content: 'hello' }, 'Agent')
    return { dir, asked, done }
  }

  it('skips the prompt under Auto-accept edits and Full access', async () => {
    for (const mode of ['accept_edits', 'full'] as const) {
      const { dir, asked, done } = writeFrom(mode)
      await done
      expect(asked).toEqual([])
      expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello')
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('asks under Ask, and writes only when the user allows it', async () => {
    const allowed = writeFrom('ask', 'allow')
    await allowed.done
    expect(allowed.asked).toHaveLength(1)
    expect(readFileSync(join(allowed.dir, 'a.txt'), 'utf8')).toBe('hello')
    const rejected = writeFrom('ask', 'reject')
    await expect(rejected.done).rejects.toThrow('rejected')
    rmSync(allowed.dir, { recursive: true, force: true })
    rmSync(rejected.dir, { recursive: true, force: true })
  })
})
