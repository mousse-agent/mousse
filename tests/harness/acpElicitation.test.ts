/**
 * ACP form-based elicitation (`elicitation/create` with `mode: 'form'`): maps interactive agent
 * questions (such as Google Antigravity's `ask_question` on `agy` 1.5+) to Mousse's thread
 * question widget, pairs `<key>_other` write-in fields with Mousse's built-in "Other…" input, and
 * enforces `approvals: 'never'`, `oneShot`, out-of-turn idle refusal, and steer `toolAwaiting`.
 *
 * The Antigravity fixtures below are recorded from `agy` 1.5.14 over ACP (`initialize` with
 * `clientCapabilities.elicitation.form: {}`).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { methods, PROTOCOL_VERSION, type AgentApp, type CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { answerFormElicitation, encodeFormElicitationAnswers, parseFormElicitation } from '../../src/mms/harness/acp/elicitation'
import { ANTIGRAVITY_QUIRKS } from '../../src/mms/harness/acp/presets/antigravity'
import { AntigravityProviderService } from '../../src/mms/harness/acp/presets/antigravity/AntigravityProviderService'
import { NO_QUIRKS } from '../../src/mms/harness/acp/quirks'
import { AcpSessions, type SavedAcpSession } from '../../src/mms/harness/acp/session'
import type { AcpRequestScope } from '../../src/mms/harness/acp/permissions'
import { AcpAdapter } from '../../src/mms/harness/drivers/acp/adapter'
import { ANTIGRAVITY_CAPS } from '../../src/mms/harness/drivers/antigravity'
import { acpDriver } from '../../src/mms/harness/drivers/acp'
import { instanceEnv } from '../../src/mms/harness/env'
import { UserQuestionService } from '../../src/mms/orchestrator/UserQuestionService'
import { inProcessAgent } from '../../src/mms/run/testkit/acpAgent'
import type { AdapterHost, TurnInput, TurnSink } from '../../src/mms/harness/adapter'
import type { LlmModelOption } from '../../src/shared/settings'
import { holdControl } from '../support/steerHoldControl'

/** Recorded from `agy` 1.5.14 (`Antigravity ACP Server`) for a 2-question `ask_question` call. */
const AGY_TWO_QUESTIONS = {
  sessionId: 'afc349aa-9d20-4dd0-9a35-0070cd76438d',
  toolCallId: 'call_7812689366434236920',
  mode: 'form',
  message: 'The agent has 2 questions.',
  requestedSchema: {
    type: 'object',
    properties: {
      q1: {
        title: 'Favorite color',
        oneOf: [
          { const: '1', title: 'Red' },
          { const: '2', title: 'Blue' }
        ],
        type: 'string'
      },
      q1_other: {
        title: 'Other',
        description: 'Optional free-form answer to: Favorite color',
        type: 'string'
      },
      q2: {
        title: 'Languages',
        items: {
          anyOf: [
            { const: '1', title: 'TS' },
            { const: '2', title: 'Go' },
            { const: '3', title: 'Rust' }
          ]
        },
        type: 'array'
      },
      q2_other: {
        title: 'Other',
        description: 'Optional free-form answer to: Languages',
        type: 'string'
      }
    }
  }
} as unknown as CreateElicitationRequest

/** Recorded from `agy` 1.5.14 for a single `ask_question` call. */
const AGY_SINGLE_QUESTION = {
  sessionId: 'e9bc5121-d21c-4cea-b75a-b5efc530911a',
  toolCallId: 'call_9880650333549724779',
  mode: 'form',
  message: 'The agent has a question.',
  requestedSchema: {
    type: 'object',
    properties: {
      q1: {
        title: 'Favorite color?',
        oneOf: [
          { const: '1', title: 'Red' },
          { const: '2', title: 'Blue' }
        ],
        type: 'string'
      },
      q1_other: {
        title: 'Other',
        description: 'Optional free-form answer to: Favorite color?',
        type: 'string'
      }
    }
  }
} as unknown as CreateElicitationRequest

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function scope(patch: Partial<AcpRequestScope> = {}): AcpRequestScope {
  return {
    threadId: 'thread-1',
    cwd: '/work',
    aborted: () => false,
    throwIfAborted: () => {},
    ...patch
  }
}

describe('parseFormElicitation and encodeFormElicitationAnswers', () => {
  it('folds Antigravity qN_other companions into one UserQuestion per prompt', () => {
    const fields = parseFormElicitation(AGY_TWO_QUESTIONS)
    expect(fields.map((field) => field.question)).toEqual([
      {
        id: 'q0',
        prompt: 'Favorite color',
        options: [
          { id: 'option-0', label: 'Red' },
          { id: 'option-1', label: 'Blue' }
        ]
      },
      {
        id: 'q1',
        prompt: 'Languages',
        allowMultiple: true,
        options: [
          { id: 'option-0', label: 'TS' },
          { id: 'option-1', label: 'Go' },
          { id: 'option-2', label: 'Rust' }
        ]
      }
    ])
  })

  it.each([
    {
      name: 'picked single and multi options',
      answers: { q0: 'option-1', q1: ['option-0', 'option-2'] },
      expected: { q1: '2', q2: ['1', '3'] }
    },
    {
      name: 'custom write-in routed to _other',
      answers: { q0: 'Green', q1: ['Zig'] },
      expected: { q1_other: 'Green', q2_other: 'Zig' }
    },
    {
      name: 'literal "1" typed into Other does not collide with option const "1"',
      answers: { q0: '1', q1: ['option-0', '1'] },
      expected: { q1_other: '1', q2: ['1'], q2_other: '1' }
    },
    {
      name: 'multi-select with both picked options and custom write-in',
      answers: { q0: 'option-0', q1: ['option-1', 'Python'] },
      expected: { q1: '1', q2: ['2'], q2_other: 'Python' }
    },
    {
      name: 'all empty answers produce null (treated as cancelled)',
      answers: { q0: '   ', q1: [] },
      expected: null
    }
  ])('encodes Antigravity answers: $name', ({ answers, expected }) => {
    const fields = parseFormElicitation(AGY_TWO_QUESTIONS)
    expect(encodeFormElicitationAnswers(fields, answers)).toEqual(expected)
  })

  it('handles generic ACP form field types: untitled enums, plain strings, booleans, numbers, integers', () => {
    const request = {
      mode: 'form',
      message: 'Configure build',
      sessionId: 's1',
      requestedSchema: {
        type: 'object',
        required: ['env', 'retries'],
        properties: {
          env: { type: 'string', title: 'Environment', enum: ['dev', 'prod'] },
          tags: { type: 'array', title: 'Tags', items: { type: 'string', enum: ['fast', 'strict'] } },
          note: { type: 'string', title: 'Release note' },
          publish: { type: 'boolean', title: 'Publish now?' },
          retries: { type: 'integer', title: 'Retries' },
          ratio: { type: 'number', title: 'Sample ratio' }
        }
      }
    } as unknown as CreateElicitationRequest

    const fields = parseFormElicitation(request)
    expect(fields.map((f) => ({ key: f.key, kind: f.kind, options: f.question.options.map((o) => o.label), allowMultiple: f.question.allowMultiple }))).toEqual([
      { key: 'env', kind: 'single', options: ['dev', 'prod'], allowMultiple: undefined },
      { key: 'tags', kind: 'multi', options: ['fast', 'strict'], allowMultiple: true },
      { key: 'note', kind: 'string', options: [], allowMultiple: undefined },
      { key: 'publish', kind: 'boolean', options: ['Yes', 'No'], allowMultiple: undefined },
      { key: 'retries', kind: 'integer', options: [], allowMultiple: undefined },
      { key: 'ratio', kind: 'number', options: [], allowMultiple: undefined }
    ])

    expect(encodeFormElicitationAnswers(fields, {
      q0: 'option-1',
      q1: ['option-0', 'option-1'],
      q2: 'v1.2',
      q3: 'true',
      q4: '3',
      q5: '0.25'
    })).toEqual({
      env: 'prod',
      tags: ['fast', 'strict'],
      note: 'v1.2',
      publish: true,
      retries: 3,
      ratio: 0.25
    })

    // Non-integer text for a required integer field refuses to send schema-invalid content.
    expect(encodeFormElicitationAnswers(fields, { q0: 'option-0', q4: '3.5' })).toBeNull()
  })

  it('keeps a required _other field separate and ignores unsupported or empty schemas', () => {
    const withRequiredOther = {
      mode: 'form',
      message: 'Pick',
      sessionId: 's1',
      requestedSchema: {
        type: 'object',
        required: ['pick_other'],
        properties: {
          pick: { type: 'string', title: 'Pick', enum: ['a', 'b'] },
          pick_other: { type: 'string', title: 'Reason' }
        }
      }
    } as unknown as CreateElicitationRequest
    expect(parseFormElicitation(withRequiredOther).map((f) => f.key)).toEqual(['pick', 'pick_other'])

    const empty = { mode: 'form', message: 'Empty', sessionId: 's1', requestedSchema: { type: 'object', properties: {} } } as unknown as CreateElicitationRequest
    expect(parseFormElicitation(empty)).toEqual([])
  })
})

describe('answerFormElicitation policy and lifecycle', () => {
  it('cancels without prompting under approvals: never or when aborted, and declines unsupported forms', async () => {
    const questions = new UserQuestionService()
    const spy = vi.spyOn(questions, 'requestAnswers')

    expect(await answerFormElicitation(questions, scope({ approvals: 'never' }), AGY_SINGLE_QUESTION)).toEqual({ action: 'cancel' })
    expect(await answerFormElicitation(questions, scope({ aborted: () => true }), AGY_SINGLE_QUESTION)).toEqual({ action: 'cancel' })
    expect(await answerFormElicitation(questions, scope({ threadId: undefined }), AGY_SINGLE_QUESTION)).toEqual({ action: 'cancel' })
    expect(await answerFormElicitation(questions, scope(), {
      mode: 'form',
      message: 'Nothing',
      sessionId: 's1',
      requestedSchema: { type: 'object', properties: {} }
    } as unknown as CreateElicitationRequest)).toEqual({ action: 'decline' })
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns cancel when the user dismisses the question card', async () => {
    const questions = new UserQuestionService()
    const pending = answerFormElicitation(questions, scope(), AGY_SINGLE_QUESTION)
    await vi.waitFor(() => expect(questions.listPendingForThread('thread-1')).toHaveLength(1))
    questions.dismiss(questions.listPendingForThread('thread-1')[0]!.requestId, { kind: 'user' })
    expect(await pending).toEqual({ action: 'cancel' })
  })
})

describe('AntigravityProviderService and ACP sessions form elicitation', () => {
  it('Antigravity advertises elicitation.form and routes agy ask_question through the question widget', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-agy-elicit-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    const profileDir = join(home, 'providers', 'antigravity')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'settings.json'), JSON.stringify({
      nativeSignedIn: true,
      models: [{ id: 'gemini-test', label: 'Gemini Test' }]
    }))

    let initParams: unknown
    let elicitReply: unknown
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, (c) => {
          initParams = c.params
          return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' } }
        })
        .onRequest(methods.agent.session.new, () => ({
          sessionId: 'agy-s1',
          configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'gemini-test', options: [{ value: 'gemini-test', name: 'Gemini Test' }] }]
        }))
        .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions: [] }))
        .onRequest(methods.agent.session.prompt, async (c) => {
          elicitReply = await c.client.request(methods.client.elicitation.create, AGY_TWO_QUESTIONS)
          await c.client.notify(methods.client.session.update, {
            sessionId: c.params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done with answers' } }
          })
          return { stopReason: 'end_turn' }
        })
    })

    const questions = new UserQuestionService()
    const service = new AntigravityProviderService(home, home, questions, undefined, {
      connect: agent.connect,
      findUserAgy: () => '/usr/local/bin/agy'
    })
    cleanups.push(() => service.stop())

    const turn = service.chat({
      threadId: 'thread-agy',
      cwd: home,
      model: 'gemini-test',
      prompt: 'Ask me two questions',
      onText: vi.fn()
    })

    await vi.waitFor(() => expect(questions.listPendingForThread('thread-agy')).toHaveLength(1))
    const [card] = questions.listPendingForThread('thread-agy')
    expect(card!.questions).toEqual([
      { id: 'q0', prompt: 'Favorite color', options: [{ id: 'option-0', label: 'Red' }, { id: 'option-1', label: 'Blue' }] },
      { id: 'q1', prompt: 'Languages', allowMultiple: true, options: [{ id: 'option-0', label: 'TS' }, { id: 'option-1', label: 'Go' }, { id: 'option-2', label: 'Rust' }] }
    ])

    questions.submitAnswers(card!.requestId, { q0: 'Green (write-in)', q1: ['option-0', 'option-2'] })
    expect(await turn).toBe('Done with answers')
    expect(initParams).toMatchObject({ clientCapabilities: { elicitation: { form: {} } } })
    expect(elicitReply).toEqual({
      action: 'accept',
      content: { q1_other: 'Green (write-in)', q2: ['1', '3'] }
    })
  })

  it('generic ACP driver advertises both URL and form elicitation and routes form questions to the widget', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'mousse-acp-elicit-'))
    cleanups.push(() => rmSync(stateDir, { recursive: true, force: true }))
    let elicitReply: unknown
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'acp-s1' }))
        .onRequest(methods.agent.session.prompt, async (c) => {
          elicitReply = await c.client.request(methods.client.elicitation.create, AGY_SINGLE_QUESTION)
          return { stopReason: 'end_turn' }
        })
    })
    const questions = new UserQuestionService()
    const driver = acpDriver({ connect: (_ctx, request) => agent.connect(request), pty: { available: () => false } })
    const runtime = driver.create({
      instanceId: 'acp:test',
      builtIn: false,
      config: driver.decodeConfig({ binaryPath: process.execPath }),
      env: instanceEnv({ instanceId: 'acp:test', driver: 'acp', configRevision: 0, searchPath: [] }),
      profileHome: stateDir,
      installationHome: stateDir,
      stateDir,
      questions,
      findBinary: () => undefined,
      changed: vi.fn()
    })
    cleanups.push(() => runtime.stop())

    const turn = runtime.adapter.startTurn(
      { runId: 'r1', attemptId: 'a1', threadId: 't-acp', cwd: stateDir, instanceId: 'acp:test', llmProvider: '', model: 'default', modelPinned: false, mode: 'agent', prompt: 'hi', messages: [], signal: new AbortController().signal } as unknown as TurnInput,
      { text: () => {}, thinking: () => {}, tool: () => {}, nativeMessages: () => {}, compaction: () => {}, retry: () => {}, progress: () => {}, usage: () => {}, providerRef: () => {}, steerAccepted: () => {}, providerMetrics: () => {}, lineEdits: () => {} } as unknown as TurnSink,
      { drainSteer: () => undefined, heartbeat: () => {} },
      { tools: {}, context: { recoverOverflow: () => null, prepareNativeContext: () => null, nativeHistoryAfterTurn: (t: string) => t } } as unknown as AdapterHost
    )
    await vi.waitFor(() => expect(questions.listPendingForThread('t-acp')).toHaveLength(1))
    const [card] = questions.listPendingForThread('t-acp')
    questions.submitAnswers(card!.requestId, { q0: 'option-0' })
    await turn
    expect(elicitReply).toEqual({ action: 'accept', content: { q1: '1' } })
  })

  it('refuses form elicitation during oneShot without prompting', async () => {
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'oneshot-1' }))
        .onRequest(methods.agent.session.prompt, async (c) => {
          await c.client.request(methods.client.elicitation.create, AGY_SINGLE_QUESTION).catch(() => undefined)
          return { stopReason: 'end_turn' }
        })
    })
    const questions = new UserQuestionService()
    const asked = vi.fn()
    questions.on('pending', asked)
    const sessions = new AcpSessions({
      label: 'Antigravity',
      defaultInstanceId: 'antigravity',
      questions,
      connect: agent.connect,
      quirks: NO_QUIRKS,
      formElicitation: true,
      store: { saved: () => undefined, setSaved: () => {}, models: () => [], setModels: () => {} },
      launchGeneration: () => 0,
      signInGeneration: () => 0,
      markSignedOut: vi.fn(),
      signInRequiredMessage: 'Sign in'
    })
    cleanups.push(() => sessions.stop())

    await expect(sessions.oneShot({
      cwd: process.cwd(),
      model: 'default',
      system: 'Title only',
      prompt: 'Hi',
      signal: new AbortController().signal,
      onActivity: () => {}
    })).rejects.toThrow(/tried to use a tool \(a question\)/)
    expect(asked).not.toHaveBeenCalled()
    expect(agent.connections[0]!.killed).toBe(true)
  })

  it('cancels an unsolicited form elicitation arriving outside a turn without prompting and closes the idle process', async () => {
    let idleClient: { request: (method: string, params: unknown) => Promise<unknown> } | undefined
    const agent = inProcessAgent((app: AgentApp) => {
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [] }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 'idle-1' }))
        .onRequest(methods.agent.session.prompt, async (c) => {
          idleClient = c.client as unknown as typeof idleClient
          return { stopReason: 'end_turn' }
        })
    })
    const saved = new Map<string, SavedAcpSession>()
    const questions = new UserQuestionService()
    const pending = vi.fn()
    questions.on('pending', pending)
    const sessions = new AcpSessions({
      label: 'Antigravity',
      defaultInstanceId: 'antigravity',
      questions,
      connect: agent.connect,
      quirks: NO_QUIRKS,
      formElicitation: true,
      store: {
        saved: (id) => saved.get(id),
        setSaved: (id, value) => (value ? saved.set(id, value) : saved.delete(id)),
        models: () => [],
        setModels: () => {}
      },
      launchGeneration: () => 0,
      signInGeneration: () => 0,
      markSignedOut: vi.fn(),
      signInRequiredMessage: 'Sign in'
    })
    cleanups.push(() => sessions.stop())

    await sessions.chat({ threadId: 't', cwd: process.cwd(), model: 'default', prompt: 'first', onText: vi.fn() })
    sessions.commitConversation('t', 'h')
    expect(saved.get('t')?.sessionId).toBe('idle-1')

    const answer = await idleClient!.request(methods.client.elicitation.create, AGY_SINGLE_QUESTION)
    expect(answer).toEqual({ action: 'cancel' })
    expect(pending).not.toHaveBeenCalled()
    expect(questions.listPendingForThread('t')).toEqual([])
    expect(saved.get('t')).toBeUndefined()
    await vi.waitFor(() => expect(agent.connections[0]!.killed).toBe(true))
  })

  it('marks the ask_question tool call awaiting so a steer does not hold behind it', async () => {
    const STEER = 'Skip it and use blue'
    let asked: unknown
    const agent = inProcessAgent((app: AgentApp) => {
      let cancel: (() => void) | undefined
      app
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'agy', version: '1.4.0' } }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: 's-steer', configOptions: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'fast', options: [{ value: 'fast', name: 'Fast' }] }] }))
        .onRequest(methods.agent.session.setConfigOption, () => ({ configOptions: [] }))
        .onRequest(methods.agent.session.prompt, async (c) => {
          const text = (c.params.prompt[0] as { text: string }).text
          if (text !== 'work') {
            await c.client.notify(methods.client.session.update, { sessionId: c.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `then ${text}` } } })
            return { stopReason: 'end_turn' }
          }
          const cancelled = new Promise<void>((resolve) => { cancel = resolve })
          await c.client.notify(methods.client.session.update, {
            sessionId: c.params.sessionId,
            update: { sessionUpdate: 'tool_call', toolCallId: 'call_9880650333549724779', title: 'Run ask_question', name: 'ask_question', status: 'in_progress' }
          })
          asked = await c.client.request(methods.client.elicitation.create, AGY_SINGLE_QUESTION)
          await cancelled
          return { stopReason: 'cancelled' }
        })
        .onNotification(methods.agent.session.cancel, () => cancel?.())
    })

    const saved = new Map<string, SavedAcpSession>()
    let models: LlmModelOption[] = []
    const questions = new UserQuestionService()
    const sessions = new AcpSessions({
      label: 'Antigravity',
      defaultInstanceId: 'antigravity',
      questions,
      connect: agent.connect,
      quirks: ANTIGRAVITY_QUIRKS,
      formElicitation: true,
      store: {
        saved: (id) => saved.get(id),
        setSaved: (id, value) => (value ? saved.set(id, value) : saved.delete(id)),
        models: () => models,
        setModels: (next) => { models = next }
      },
      launchGeneration: () => 0,
      signInGeneration: () => 0,
      markSignedOut: vi.fn(),
      signInRequiredMessage: 'Sign in'
    })
    cleanups.push(() => sessions.stop())

    const hold = holdControl(ANTIGRAVITY_CAPS, { questions: { pending: () => questions.listPendingForThread('t').length > 0 } })
    const sink = hold.wrap({ text: () => {}, thinking: () => {}, tool: () => {}, progress: () => {}, providerRef: () => {}, usage: () => {}, steerAccepted: () => {} } as unknown as TurnSink)
    const adapter = new AcpAdapter(() => ({ chat: (input) => sessions.chat(input), commitConversation: () => {}, configured: () => true }), { driver: 'antigravity', label: 'Antigravity', capabilities: ANTIGRAVITY_CAPS })
    const input = { threadId: 't', instanceId: 'antigravity', llmProvider: '', model: 'fast', mode: 'agent', prompt: 'work', cwd: process.cwd(), signal: new AbortController().signal } as unknown as TurnInput
    const result = adapter.startTurn(input, sink, hold.ctl, { context: { nativeHistoryAfterTurn: (v: string) => v } } as unknown as AdapterHost)

    await vi.waitFor(() => expect(questions.listPendingForThread('t')).toHaveLength(1))
    hold.steer(STEER)
    expect((await result).text).toBe(`then ${STEER}`)

    const events = hold.log.map(([event, detail]) => `${event}:${detail}`)
    expect(events).toContain('awaiting:call_9880650333549724779:true')
    expect(events).toContain('awaiting:call_9880650333549724779:false')
    expect(events.indexOf('awaiting:call_9880650333549724779:true')).toBeLessThan(events.indexOf(`drain:${STEER}`))
    expect(asked).toEqual({ action: 'cancel' })
    expect(questions.listPendingForThread('t')).toEqual([])
  })
})
