import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import {
  findQuickActionCardForApproval,
  isQuickActionApproval,
  parseQuickActionApprovalPrompt
} from '../src/renderer/chat/components/agent-elements/tools/quick-action-approval'
import type { PendingUserQuestions } from '../src/shared/types'

function pending(prompt: string, id = 'approval'): PendingUserQuestions {
  return {
    requestId: 'req-1',
    threadId: 'thread-1',
    questions: [{ id, prompt, options: [] }]
  }
}

function quickActionMessage(
  id: string,
  label: string,
  output?: string
): UIMessage {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-QuickAction',
        toolCallId: `call-${id}`,
        state: output === undefined ? 'input-available' : 'output-available',
        input: { label, kind: 'send-current', payload: 'hello' },
        ...(output === undefined ? {} : { output })
      }
    ]
  } as unknown as UIMessage
}

const APPROVAL_PROMPT =
  'Create quick action "Test Action" (send here)? Content: Hello from test action!'

describe('parseQuickActionApprovalPrompt', () => {
  it('extracts the label from the backend prompt', () => {
    expect(parseQuickActionApprovalPrompt(APPROVAL_PROMPT)).toBe('Test Action')
  })

  it('returns null for unrelated prompts', () => {
    expect(parseQuickActionApprovalPrompt('Pick a color?')).toBeNull()
    expect(parseQuickActionApprovalPrompt(undefined)).toBeNull()
  })
})

describe('isQuickActionApproval', () => {
  it('matches a single approval question', () => {
    expect(isQuickActionApproval(pending(APPROVAL_PROMPT))).toBe(true)
  })

  it('rejects multi-question, wrong-id, and null pendings', () => {
    expect(isQuickActionApproval(null)).toBe(false)
    expect(
      isQuickActionApproval(pending(APPROVAL_PROMPT, 'other'))
    ).toBe(false)
    const multi = pending(APPROVAL_PROMPT)
    multi.questions.push({ id: 'followup', prompt: 'More?', options: [] })
    expect(isQuickActionApproval(multi)).toBe(false)
  })
})

describe('findQuickActionCardForApproval', () => {
  it('matches the undecided card by label', () => {
    const messages = [
      quickActionMessage('m1', 'Old Action', 'Quick action created: "Old Action".'),
      quickActionMessage('m2', 'Test Action')
    ]
    expect(
      findQuickActionCardForApproval(messages, pending(APPROVAL_PROMPT))
    ).toEqual({ toolCallId: 'call-m2', label: 'Test Action' })
  })

  it('skips decided cards', () => {
    const messages = [
      quickActionMessage('m1', 'Test Action', 'Quick action "Test Action" was not created.')
    ]
    expect(
      findQuickActionCardForApproval(messages, pending(APPROVAL_PROMPT))
    ).toBeNull()
  })

  it('falls back to the newest undecided card on label mismatch', () => {
    const messages = [quickActionMessage('m1', 'Renamed')]
    expect(
      findQuickActionCardForApproval(messages, pending(APPROVAL_PROMPT))
    ).toEqual({ toolCallId: 'call-m1', label: 'Renamed' })
  })

  it('returns null without an approval pending', () => {
    const messages = [quickActionMessage('m1', 'Test Action')]
    expect(findQuickActionCardForApproval(messages, null)).toBeNull()
    expect(
      findQuickActionCardForApproval(messages, pending('Pick a color?'))
    ).toBeNull()
  })
})
