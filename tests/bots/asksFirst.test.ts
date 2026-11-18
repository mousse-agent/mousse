import { expect, it } from 'vitest'
import { asksFirstFor } from '../../src/shared/bots/personal/asksFirst'

it.each([
  ...['get', 'list', 'search', 'read', 'find', 'fetch', 'show', 'describe', 'query', 'count'].map(word => [`${word}_items`, undefined, false] as const),
  ['send_email', undefined, true], ['update_list', undefined, true], ['listing_update', undefined, true],
  ['getaway', undefined, true], ['github_list_issues', undefined, false], ['github-list-issues', undefined, false],
  ['github.list.issues', undefined, false], ['githubListIssues', undefined, false], ['listIssues', undefined, false],
  ['search_and_delete', false, true], ['send_email', true, false], ['fetch_and_archive', undefined, false]
])('%s with hint %s asks: %s', (tool, readOnlyHint, expected) => {
  expect(asksFirstFor({ tool, serverName: 'GitHub', readOnlyHint })).toBe(expected)
})
it('stored asks-first is a floor even with a read-only hint', () => {
  expect(asksFirstFor({ tool: 'list', serverName: 'Mail', readOnlyHint: true, storedLevel: 'asks_first' })).toBe(true)
})

it('asks first defaults on but the new support lever turns it off', async () => {
  const { getDefaultSettings, normalizeExperimentalSettings } = await import('../../src/shared/settings')
  expect(getDefaultSettings().experimental.botAsksFirstOff).toBe(false)
  expect(normalizeExperimentalSettings({ botAsksFirstOff: true }).botAsksFirstOff).toBe(true)
})

it('turns on a profile saved with master defaults and only honors the new support lever', async () => {
  const { normalizeExperimentalSettings } = await import('../../src/shared/settings')
  const { botAsksFirst } = await import('../../src/mms/bots/actions/BotActions')
  const saved = { botAsksFirst: false, subagentWorktrees: false, profiler: { enabled: false } }
  expect(botAsksFirst({ experimental: normalizeExperimentalSettings(saved as never) })).toBe(true)
  expect(botAsksFirst({ experimental: normalizeExperimentalSettings({ ...saved, botAsksFirstOff: true } as never) })).toBe(false)
})

it.each(['send','delete','remove','archive','update','create','add','set','put','post','write','edit','modify','move','copy','mark','reply','forward','publish','upload','cancel','close','merge','approve','assign','invite','share','submit','run','execute','trigger','start','stop','pay','transfer','book','order','buy','rename','clear','reset','import','sync','save','unsubscribe','and','then','or'])('asks when a reading name contains %s', word => {
  expect(asksFirstFor({ tool: `get_${word}_items`, serverName: 'Mail' })).toBe(true)
})
it.each(['fetch_and_archive','get_and_send','listDelete'])('asks for compound %s', tool => {
  expect(asksFirstFor({ tool, serverName: 'Mail' })).toBe(true)
})
