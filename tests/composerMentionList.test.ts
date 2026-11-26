import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  ComposerSuggestionList,
  MentionRowContent,
  skillSource,
  splitMentionPath,
  type SuggestionRow
} from '../src/renderer/components/ComposerSuggestionList'
import type { MentionItem } from '../src/shared/composerCommands'
import type { SkillDescriptor } from '../src/shared/integrations'

const noop = () => {}

function renderList(rows: SuggestionRow[], selected: number, extra: { footer?: string; emptyText?: ReactNode } = {}): string {
  return renderToStaticMarkup(
    createElement(ComposerSuggestionList, { rows, selected, ariaLabel: 'Suggestions', onHover: noop, onPick: noop, ...extra })
  )
}

const skillItem: MentionItem<SkillDescriptor> = {
  kind: 'skill',
  skill: { id: 'review', name: 'review', description: 'Review a change', rootPath: '', skillPath: '', scope: 'project', source: 'mousse-project' }
}
const fileItem: MentionItem = { kind: 'file', path: 'src/components/ChatComposer.tsx', positions: [15, 16, 17, 18] }
const folderItem: MentionItem = { kind: 'directory', path: 'src/shared', positions: [4, 5] }

describe('mention suggestion list', () => {
  it('marks matched characters of the basename and puts the parent folder on the second line', () => {
    const html = renderToStaticMarkup(createElement(MentionRowContent, { item: fileItem }))
    expect(html).toContain('<mark>Chat</mark>Composer.tsx')
    expect(html).toContain('src/components/')
    expect(html).toContain('aria-label="File"')
  })

  it('marks matches that fall in the parent folder', () => {
    const html = renderToStaticMarkup(createElement(MentionRowContent, { item: folderItem }))
    expect(html).toContain('<mark>sh</mark>ared')
    expect(html).toContain('src/')
    expect(html).toContain('aria-label="Folder"')
  })

  it('shows a skill with its source and description, the query marked', () => {
    const html = renderToStaticMarkup(createElement(MentionRowContent, { item: skillItem, query: 'rev' }))
    expect(html).toContain('<mark>rev</mark>iew')
    expect(html).toContain('aria-label="Project"')
    expect(html).toContain('Review a change')
  })

  // [source, scope, managed, the label its icon gives]
  const sources: Array<[SkillDescriptor['source'], SkillDescriptor['scope'], boolean | undefined, string]> = [
    ['mousse-profile', 'global', undefined, 'Personal'],
    ['generated-agent', 'project', undefined, 'Project'],
    ['claude-project', 'project', undefined, 'Claude Code · project'],
    ['codex-global', 'global', undefined, 'Codex · personal'],
    ['cursor-project', 'project', undefined, 'Cursor · project'],
    ['opencode-global', 'global', undefined, 'OpenCode · personal'],
    ['agents-project', 'project', undefined, 'Agents folder · project'],
    ['claude-project', 'project', true, 'Project']
  ]
  it.each(sources)('names a %s skill (%s, managed %s) %j', (source, scope, managed, label) => {
    expect(skillSource({ source, scope, managed }).label).toBe(label)
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
    expect(renderList([], 0, { emptyText: 'No skills' })).toContain('No skills')
    expect(renderList([{ key: 'a', content: 'A' }], 0, { emptyText: 'No skills' })).not.toContain('No skills')
  })

  it('shows an empty text with an action in it', () => {
    const html = renderList([], 0, { emptyText: createElement('button', { type: 'button' }, 'Settings') })
    expect(html).toContain('<div class="composer-command-suggestion-empty"><button type="button">Settings</button></div>')
  })

  it('keeps focus in the text box when the list is pressed, so composition is not interrupted', () => {
    // The component is a plain function: call it and fire the handler of the element it returns.
    const tree = ComposerSuggestionList({ rows: [], selected: 0, ariaLabel: 'Suggestions', onHover: noop, onPick: noop }) as unknown as { props: { onMouseDown?: (event: { preventDefault(): void }) => void } }
    const preventDefault = vi.fn()
    tree.props.onMouseDown?.({ preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
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
