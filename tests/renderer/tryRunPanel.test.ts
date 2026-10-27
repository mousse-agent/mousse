// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TryRunPanel } from '../../src/renderer/components/agentDefinitions/TryRunPanel'
import type { AgentDefinitionsClient, AgentTryRunPending, AgentTryRunResult } from '../../src/renderer/components/agentDefinitions/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// #299: a Try Run's question (a shell command's approval where the shell is not contained) is asked
// on the run's hidden "Try Agent" thread. The panel shows it and the person answers it there.

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const question = {
  requestId: 'req-1',
  threadId: 'thread-try',
  questions: [{ id: 'approval', prompt: 'Allow bash?\nArguments: {"command":"npm test"}', options: [{ id: 'approve', label: 'Allow this action' }, { id: 'reject', label: 'Reject' }] }]
}

function fakeClient(pending: () => AgentTryRunPending) {
  let finish: (result: AgentTryRunResult) => void = () => {}
  const answers: unknown[] = []
  const client = {
    tryRun: vi.fn(() => new Promise<AgentTryRunResult>((resolve) => { finish = resolve })),
    tryRunPending: vi.fn(async () => pending()),
    tryRunAnswer: vi.fn(async (query: unknown) => (answers.push(query), { ok: true }))
  } as unknown as AgentDefinitionsClient
  return { client, answers, finish: (result: AgentTryRunResult) => finish(result) }
}

const text = () => host.textContent ?? ''
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((entry) => entry.textContent?.startsWith(label))!
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve() })

async function start(client: AgentDefinitionsClient) {
  act(() => root.render(createElement(TryRunPanel, { profileId: 'p1', id: 'agent-1', expectedDraftHash: 'a'.repeat(64), client })))
  const prompt = host.querySelector<HTMLTextAreaElement>('[data-field="try-run-prompt"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(prompt, 'run the tests')
    prompt.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => button('Try run').click())
  await flush()
}

describe('the Try Run panel', () => {
  it('shows the question the run waits on, says it is waiting for an answer, and sends the answer', async () => {
    let waiting = true
    const { client, answers, finish } = fakeClient(() => ({ runs: [{ runId: 'run-1', threadId: 'thread-try', threadTitle: 'Try Agent: Tester', questions: waiting ? [question] : [] }] }))
    await start(client)
    expect(host.querySelector('[data-try-run-waiting="true"]')).not.toBeNull()
    expect(text()).toContain('Waiting for your answer.')
    expect(text()).toContain('Try Agent: Tester')
    expect(text()).toContain('"command":"npm test"')
    expect(button('Waiting for your answer…').disabled).toBe(true)

    act(() => button('Allow this action').click())
    act(() => button('Submit').click())
    await flush()
    expect(answers).toEqual([{ profileId: 'p1', id: 'agent-1', requestId: 'req-1', answers: { approval: 'approve' } }])
    waiting = false
    expect(host.querySelector('[data-try-run-waiting="true"]')).toBeNull()

    await act(async () => finish({ ok: true, status: 'completed', summary: 'tests pass', trace: [] }))
    expect(text()).toContain('tests pass')
    expect(button('Try run')).toBeDefined()
  })

  it('a dismissed question is sent as dismissed; a run with no question just runs', async () => {
    const { client, answers } = fakeClient(() => ({ runs: [{ runId: 'run-1', threadId: 'thread-try', threadTitle: 'Try Agent: Tester', questions: [question] }] }))
    await start(client)
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Dismiss questions"]')!.click())
    await flush()
    expect(answers).toEqual([{ profileId: 'p1', id: 'agent-1', requestId: 'req-1', dismiss: true }])

    act(() => root.unmount())
    root = createRoot(host)
    const idle = fakeClient(() => ({ runs: [{ runId: 'run-2', threadId: 'thread-try', threadTitle: 'Try Agent: Tester', questions: [] }] }))
    await start(idle.client)
    expect(text()).toContain('Running…')
    expect(host.querySelector('[data-try-run-waiting="true"]')).toBeNull()
  })
})
