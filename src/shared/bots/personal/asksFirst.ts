const readingWords = new Set(['get', 'list', 'search', 'read', 'find', 'fetch', 'show', 'describe', 'query', 'count'])
const changingWords = new Set('send delete remove archive update create add set put post write edit modify move copy mark reply forward publish upload cancel close merge approve assign invite share submit run execute trigger start stop pay transfer book order buy rename clear reset import sync save unsubscribe and then or'.split(' '))

/** Call-time classification; never changes a grant. Names include the installation's short name when known. */
export function asksFirstFor(input: { tool: string; serverName: string | readonly string[]; readOnlyHint?: boolean; storedLevel?: string }): boolean {
  if (input.storedLevel === 'asks_first') return true
  if (input.readOnlyHint !== undefined) return !input.readOnlyHint
  const words = input.tool.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-.]+/)
  const names = typeof input.serverName === 'string' ? [input.serverName] : input.serverName
  if (names.some(name => name.toLowerCase() === words[0])) words.shift()
  return !readingWords.has(words[0] ?? '') || words.slice(1).some(word => changingWords.has(word))
}
