import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolGroup } from '../src/renderer/chat/components/agent-elements/tools/tool-group'

const nested = (id: string, type: string, input: Record<string, unknown>) => ({
  type,
  toolCallId: `parent:${id}`,
  state: 'output-available',
  input,
  output: 'ok'
})

const render = (part: Record<string, unknown>, nestedTools: unknown[]) =>
  renderToStaticMarkup(
    createElement(ToolGroup, {
      part,
      nestedTools,
      chatStatus: 'ready',
      completeLabel: 'Ran agent',
      interruptedLabel: 'Agent interrupted',
      defaultOpen: true
    })
  )

describe('ToolGroup for a subagent that was interrupted', () => {
  const stopped = {
    type: 'tool-Agent',
    toolCallId: 'parent',
    state: 'output-available',
    input: { description: 'Look around' },
    output: { interrupted: true, summary: 'Stopped' }
  }

  it('says why it ended and still shows the work nested under it', () => {
    const html = render(stopped, [
      nested('a', 'tool-Bash', { command: 'npm test', label: 'npm test' }),
      nested('b', 'tool-Read', { file_path: 'src/a.ts' })
    ])
    expect(html).toContain('Agent interrupted')
    expect(html).toContain('Stopped')
    expect(html).not.toContain('Ran agent')
    // Both nested rows are rendered, not just the interrupted line.
    expect(html).toContain('npm test')
    expect(html).toContain('a.ts')
  })

  it('is a plain interrupted line when it has nothing nested', () => {
    const html = render(stopped, [])
    expect(html).toContain('Agent interrupted')
    expect(html).toContain('Stopped')
  })
})
