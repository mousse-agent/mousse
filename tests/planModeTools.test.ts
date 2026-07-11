import { describe, expect, it, vi } from 'vitest'
import { PlanModeTools } from '../src/mms/orchestrator/PlanModeTools'

describe('PlanModeTools', () => {
  it('registers ask_user and show_document tools', () => {
    const tools = new PlanModeTools(
      async () => ({}),
      () => {}
    )
    const names = tools.getToolDefinitions().map((tool) => tool.name)
    expect(names).toEqual(['ask_user', 'show_document'])
  })

  it('opens documents through callback', async () => {
    const openDocument = vi.fn()
    const tools = new PlanModeTools(async () => ({}), openDocument)

    const result = await tools.execute('show_document', {
      title: 'Implementation Plan',
      markdown: '# Plan\n\nStep 1'
    })

    expect(result.isError).toBe(false)
    expect(openDocument).toHaveBeenCalledWith({
      title: 'Implementation Plan',
      markdown: '# Plan\n\nStep 1'
    })
  })

  it('requests answers for ask_user', async () => {
    const requestAnswers = vi.fn(async () => ({ scope: 'frontend-only' }))
    const tools = new PlanModeTools(requestAnswers, () => {})

    const result = await tools.execute('ask_user', {
      questions: [
        {
          id: 'scope',
          prompt: 'Which area?',
          options: [
            { id: 'ui', label: 'UI' },
            { id: 'api', label: 'API' }
          ]
        }
      ]
    })

    expect(requestAnswers).toHaveBeenCalled()
    expect(result.isError).toBe(false)
    expect(result.text).toContain('frontend-only')
  })

  it('rejects invalid ask_user payloads', async () => {
    const tools = new PlanModeTools(async () => ({}), () => {})
    const result = await tools.execute('ask_user', { questions: [] })
    expect(result.isError).toBe(true)
  })
})
