import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditTool } from '../../src/renderer/chat/components/agent-elements/tools/edit-tool'

function render(part: Record<string, unknown>, isCollapsible = true): string {
  return renderToStaticMarkup(createElement(EditTool, { part, isCollapsible }))
}

const edit = {
  type: 'tool-Edit',
  toolCallId: 'c1',
  state: 'output-available',
  input: { file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' }
}

describe('edit card', () => {
  it('names the file with a control that opens it', () => {
    const markup = render(edit)
    expect(markup).toContain('aria-label="Open app.ts"')
    expect(markup).toContain('title="/repo/src/app.ts"')
  })

  it('has one expand control', () => {
    const markup = render(edit)
    expect(markup.match(/aria-expanded=/g)).toHaveLength(1)
    expect(markup).toContain('aria-label="Expand diff for app.ts"')
    expect(markup).not.toContain('Show more')
  })

  it('opens each file of a card about several files', () => {
    const markup = render({
      ...edit,
      output: {
        changes: [
          { path: 'src/a.ts', change: 'update', added: 1, removed: 1, diffUnavailable: true },
          { path: 'src/b.ts', change: 'update', added: 2, removed: 0, diffUnavailable: true }
        ]
      }
    }, false)
    // The header names no single file; the expanded body names each one.
    expect(markup).toContain('2 files')
    expect(markup).not.toContain('aria-label="Open 2 files"')
    expect(markup).toContain('aria-label="Open src/a.ts"')
    expect(markup).toContain('aria-label="Open src/b.ts"')
  })
})
