import { describe, expect, it } from 'vitest'
import {
  COMPOSER_COMMANDS,
  filterComposerCommandSuggestions,
  findSlashQueryAtCaret,
  slashSuggestions
} from '../src/shared/composerCommands'

const skills = [
  { id: 'review', name: 'review', description: 'Review a change' },
  { id: 'test-writer', name: 'test-writer', description: 'Write tests' },
  { id: 'pdf', name: 'pdf', description: 'Read a review PDF' }
]

/** The `/` list for `text` with the caret at the end (or at `|`), as row labels. */
function rows(marked: string, skillsAtStart = true) {
  const caret = marked.includes('|') ? marked.indexOf('|') : marked.length
  const text = marked.replace('|', '')
  const result = slashSuggestions(text, caret, { commands: filterComposerCommandSuggestions(text), skills, skillsAtStart })
  return {
    labels: result.items.map((item) => (item.kind === 'command' ? `/${item.command.name}` : `skill:${item.skill.name}`)),
    midMessage: result.midMessage,
    range: result.range
  }
}

describe('where a / opens the skill list', () => {
  // [text with caret at | (or the end), the query, or null when the list stays closed]
  const cases: Array<[string, string | null]> = [
    ['/te', 'te'],
    ['fix this /te', 'te'],
    ['fix this\n/te', 'te'],
    ['fix this\t/', ''],
    ['open src/re', null],
    ['this and/or that', null],
    ['run /usr/bin', null],
    ['run /usr|/bin', null],
    ['see (/te', null],
    ['x /te|st', 'te'],
    ['```\ncode /te', null],
    ['```\ncode\n```\nthen /te', 'te'],
    ['fix /te now', null]
  ]
  it.each(cases)('%j → %j', (marked, query) => {
    const caret = marked.includes('|') ? marked.indexOf('|') : marked.length
    const found = findSlashQueryAtCaret(marked.replace('|', ''), caret)
    expect(found?.query ?? null).toBe(query)
  })
})

describe('what the / list shows', () => {
  it('lists matching commands then matching skills at the start of the message', () => {
    expect(rows('/re')).toEqual({ labels: ['/rename', 'skill:review'], midMessage: false, range: { index: 0, end: 3 } })
    expect(rows('/').labels).toEqual([...COMPOSER_COMMANDS.map((command) => `/${command.name}`), 'skill:review', 'skill:test-writer', 'skill:pdf'])
  })

  it('lists skills only mid-message, with the range a pick replaces', () => {
    expect(rows('fix this /re')).toEqual({ labels: ['skill:review'], midMessage: true, range: { index: 9, end: 12 } })
    expect(rows('please /new').labels).toEqual([])
  })

  it('matches names, not descriptions, an exact name and prefixes first', () => {
    expect(rows('x /pdf').labels).toEqual(['skill:pdf'])
    expect(rows('x /e').labels).toEqual(['skill:review', 'skill:test-writer'])
    expect(rows('x /t').labels).toEqual(['skill:test-writer'])
  })

  it('stays closed with no matching skill, so Enter sends the text as typed', () => {
    expect(rows('fix /zzz')).toEqual({ labels: [], midMessage: true, range: null })
    expect(rows('/zzz')).toEqual({ labels: [], midMessage: false, range: null })
  })

  it('leaves the start of the message to the commands when asked', () => {
    expect(rows('/re', false).labels).toEqual(['/rename'])
    expect(rows('fix /re', false).labels).toEqual(['skill:review'])
  })
})
