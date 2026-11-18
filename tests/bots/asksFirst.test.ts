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
