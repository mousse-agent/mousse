import { describe, expect, it, vi } from 'vitest'
import { PlanModeTools } from '../src/mms/orchestrator/PlanModeTools'

describe('PlanModeTools', () => {
  it('advertises ask_user and present_plan — preview is a button on the inline plan card, not a model tool', () => {
    const tools = new PlanModeTools(
      async () => ({}),
      () => {}
    )
    const names = tools.getToolDefinitions().map((tool) => tool.name)
    expect(names).toEqual(['ask_user', 'present_plan'])
    // show_document is deprecated (not advertised) but still executable for in-flight turns.
    expect(names).not.toContain('show_document')
    expect(tools.isPlanTool('ask_user')).toBe(true)
    expect(tools.isPlanTool('present_plan')).toBe(true)
    expect(tools.isPlanTool('show_document')).toBe(true)
  })

  it('presents plans through callback', async () => {
    const presented: Array<{ title: string; markdown: string }> = []
    const tools = new PlanModeTools(
      async () => ({}),
      () => {},
      (payload) => { presented.push(payload) }
    )

    const result = await tools.execute('present_plan', {
      title: 'Auth plan',
      markdown: '# Plan\n\nStep 1'
    }, 'thread-1')

    expect(result.isError).toBe(false)
    expect(presented).toEqual([{ title: 'Auth plan', markdown: '# Plan\n\nStep 1' }])
  })

  it('rejects empty present_plan markdown', async () => {
    const tools = new PlanModeTools(async () => ({}), () => {}, () => {})
    const result = await tools.execute('present_plan', { title: 'Empty', markdown: '  ' })
    expect(result.isError).toBe(true)
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
    }, 'thread-1')

    expect(requestAnswers).toHaveBeenCalledWith(expect.any(Array), 'thread-1')
    expect(result.isError).toBe(false)
    expect(result.text).toContain('frontend-only')
  })

  it('rejects invalid ask_user payloads', async () => {
    const tools = new PlanModeTools(async () => ({}), () => {})
    const result = await tools.execute('ask_user', { questions: [] })
    expect(result.isError).toBe(true)
  })
})
