import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ComposerSuggestionList,
  MentionRowContent,
  splitMentionPath,
  type SuggestionRow
} from '../src/renderer/components/ComposerSuggestionList'
import type { MentionItem } from '../src/shared/channelCommands'

const noop = () => {}

function renderList(rows: SuggestionRow[], selected: number, extra: { footer?: string; emptyText?: string } = {}): string {
  return renderToStaticMarkup(
    createElement(ComposerSuggestionList, { rows, selected, ariaLabel: 'Suggestions', onHover: noop, onPick: noop, ...extra })
  )
}

const skillItem: MentionItem = { kind: 'skill', skill: { id: 'review', name: 'review', description: 'Review a change' } }
const fileItem: MentionItem = { kind: 'file', path: 'src/components/ChatComposer.tsx', positions: [15, 16, 17, 18] }
const folderItem: MentionItem = { kind: 'directory', path: 'src/shared', positions: [4, 5] }

describe('mention suggestion list', () => {
  it('marks matched characters of the basename and dims the parent folder', () => {
    const html = renderToStaticMarkup(createElement(MentionRowContent, { item: fileItem }))
    expect(html).toContain('<mark>Chat</mark>Composer.tsx')
    expect(html).toContain('composer-mention-path')
    expect(html).toContain('src/components/')
    expect(html).not.toContain('Skill</span>')
  })

  it('marks matches that fall in the parent folder', () => {
    const html = renderToStaticMarkup(createElement(MentionRowContent, { item: folderItem }))
    expect(html).toContain('<mark>sh</mark>ared')
    expect(html).toContain('src/')
  })

  it('shows a skill with a Skill badge and its description', () => {
    const html = renderToStaticMarkup(createElement(MentionRowContent, { item: skillItem }))
    expect(html).toContain('composer-mention-badge')
    expect(html).toContain('>Skill<')
    expect(html).toContain('Review a change')
  })

  it('splits a path into basename and folder, including a folder with a trailing slash', () => {
    expect(splitMentionPath('a/b/c.ts', [0, 4])).toEqual({
      dir: [{ text: 'a', match: true }, { text: '/b/', match: false }],
      name: [{ text: 'c', match: true }, { text: '.ts', match: false }]
    })
    expect(splitMentionPath('top.ts', []).dir).toEqual([])
    expect(splitMentionPath('a/inner/', []).name).toEqual([{ text: 'inner/', match: false }])
  })

  it('renders one option per row with the selected one flagged, keeping the shared ids', () => {
    const rows = [skillItem, fileItem, folderItem].map(
      (item, index): SuggestionRow => ({ key: String(index), content: createElement(MentionRowContent, { item }) })
    )
    const html = renderList(rows, 1)
    expect(html).toContain('role="listbox"')
    expect(html).toContain('id="composer-command-suggestions"')
    expect(html).toContain('id="composer-command-suggestion-0"')
    expect(html).toContain('id="composer-command-suggestion-2"')
    expect(html.match(/role="option"/g)).toHaveLength(3)
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
    expect(html).toMatch(/class="composer-command-suggestion selected"[^>]*aria-selected="true"/)
    expect(html.match(/composer-command-suggestion selected/g)).toHaveLength(1)
  })

  it('shows the footer and the empty text', () => {
    expect(renderList([], 0, { footer: 'Indexing files…' })).toContain('Indexing files…')
    expect(renderList([], 0, { emptyText: 'No skills enabled.' })).toContain('No skills enabled.')
    expect(renderList([{ key: 'a', content: 'A' }], 0, { emptyText: 'No skills enabled.' })).not.toContain('No skills enabled.')
  })

  it('keeps focus in the text box when the list is pressed, so composition is not interrupted', () => {
    const source = readFileSync(new URL('../src/renderer/components/ComposerSuggestionList.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/)
  })

  it('highlights the selected row with a background only, never a side or edge bar', () => {
    const css = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')
    const rules = [...css.matchAll(/([^{}]*\.composer-(?:command-suggestion|mention)[^{}]*)\{([^}]*)\}/g)]
    expect(rules.length).toBeGreaterThan(5)
    const selected = rules.filter(([, selector]) => /\.selected/.test(selector))
    expect(selected.length).toBeGreaterThan(0)
    for (const [, selector, body] of rules) {
      expect(body, selector).not.toMatch(/border-(left|right|inline-start|inline-end)\s*:/)
      expect(body, selector).not.toMatch(/box-shadow\s*:\s*inset/)
      expect(selector, selector).not.toMatch(/::?(before|after)/)
    }
    expect(selected.some(([, , body]) => /background\s*:/.test(body))).toBe(true)
  })
})
