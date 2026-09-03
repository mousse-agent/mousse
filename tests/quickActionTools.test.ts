import { describe, expect, it, vi } from 'vitest'
import {
  QuickActionTools,
  validateStagedQuickAction,
  type CreatedQuickAction
} from '../src/mms/orchestrator/QuickActionTools'

const VALID_ARGS = {
  label: 'Commit and push',
  kind: 'send-current',
  payload: 'Commit and push your changes feature wise'
}

function makeTools(approved: boolean | Error) {
  const published: CreatedQuickAction[] = []
  const requestApproval = approved instanceof Error
    ? vi.fn().mockRejectedValue(approved)
    : vi.fn().mockResolvedValue(approved)
  const tools = new QuickActionTools(requestApproval, (action) => {
    published.push(action)
  })
  return { tools, published, requestApproval }
}

describe('validateStagedQuickAction', () => {
  it('accepts valid send/bash actions', () => {
    expect(validateStagedQuickAction(VALID_ARGS)).toBeUndefined()
    expect(
      validateStagedQuickAction({ label: 'Status', kind: 'bash', payload: 'git status --short' })
    ).toBeUndefined()
  })

  it('rejects empty/overlong/invalid fields', () => {
    expect(validateStagedQuickAction({ ...VALID_ARGS, label: '  ' })).toBeDefined()
    expect(validateStagedQuickAction({ ...VALID_ARGS, label: 'x'.repeat(61) })).toBeDefined()
    expect(validateStagedQuickAction({ ...VALID_ARGS, kind: 'email' })).toBeDefined()
    expect(validateStagedQuickAction({ ...VALID_ARGS, payload: '' })).toBeDefined()
    expect(validateStagedQuickAction({ ...VALID_ARGS, payload: 'x'.repeat(4001) })).toBeDefined()
  })
})

describe('QuickActionTools', () => {
  it('exposes a create_quick_action definition', () => {
    const { tools } = makeTools(true)
    const defs = tools.getToolDefinitions()
    expect(defs.map((d) => d.name)).toEqual(['create_quick_action'])
    expect(tools.isQuickActionTool('create_quick_action')).toBe(true)
    expect(tools.isQuickActionTool('ask_user')).toBe(false)
  })

  it('publishes the action when approved', async () => {
    const { tools, published, requestApproval } = makeTools(true)
    const result = await tools.execute('create_quick_action', { ...VALID_ARGS }, 'thread-1')
    expect(result.isError).toBe(false)
    expect(result.text).toContain('Commit and push')
    expect(requestApproval).toHaveBeenCalledWith(
      { label: 'Commit and push', kind: 'send-current', payload: VALID_ARGS.payload },
      'thread-1'
    )
    expect(published).toHaveLength(1)
    expect(published[0].id).toBeTruthy()
    expect(published[0].createdAt).toBeTruthy()
  })

  it('does not publish when rejected', async () => {
    const { tools, published } = makeTools(false)
    const result = await tools.execute('create_quick_action', { ...VALID_ARGS }, 'thread-1')
    expect(result.isError).toBe(false)
    expect(result.text).toMatch(/not created/i)
    expect(published).toHaveLength(0)
  })

  it('treats dismissed approval as not-created without error', async () => {
    const { tools, published } = makeTools(new Error('User dismissed the questions.'))
    const result = await tools.execute('create_quick_action', { ...VALID_ARGS }, 'thread-1')
    expect(result.isError).toBe(false)
    expect(result.text).toMatch(/not created/i)
    expect(published).toHaveLength(0)
  })

  it('requires a thread for approval and rejects bad args', async () => {
    const { tools, published } = makeTools(true)
    const noThread = await tools.execute('create_quick_action', { ...VALID_ARGS })
    expect(noThread.isError).toBe(true)
    const badArgs = await tools.execute(
      'create_quick_action',
      { ...VALID_ARGS, kind: 'nope' },
      'thread-1'
    )
    expect(badArgs.isError).toBe(true)
    const unknown = await tools.execute('other_tool', {}, 'thread-1')
    expect(unknown.isError).toBe(true)
    expect(published).toHaveLength(0)
  })
})
