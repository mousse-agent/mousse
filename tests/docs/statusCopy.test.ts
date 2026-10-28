/**
 * The card's words in the docs are the card's own (plan PR 5 §6): every headline and step quoted in
 * "What the provider card says" (docs/PROVIDER_CREDENTIALS.md) is a string of
 * `src/shared/harness/status.ts`, and every headline `describeStatus` has is in that table.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..')
const doc = readFileSync(join(ROOT, 'docs', 'PROVIDER_CREDENTIALS.md'), 'utf8').replace(/\r\n/g, '\n')
const source = readFileSync(join(ROOT, 'src', 'shared', 'harness', 'status.ts'), 'utf8')

/** A template part (`${version}`) and a doc placeholder (`<version>`) both read as `<>`. */
const normalized = source.replace(/\$\{[^}]*\}/g, '<>')
const placeholder = (text: string) => text.replace(/<[^>]+>/g, '<>')

function table(heading: string): string[][] {
  const start = doc.indexOf(`## ${heading}\n`)
  if (start < 0) throw new Error(`no "${heading}" section`)
  const end = doc.indexOf('\n## ', start + 1)
  return doc.slice(start, end < 0 ? undefined : end).split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[-| ]+\|$/.test(line))
    .slice(1)
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
}

const quoted = (cell: string) => [...cell.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
const rows = table('What the provider card says')

describe('the card words in the docs', () => {
  it('quotes only headlines and steps status.ts has', () => {
    expect(rows.length).toBeGreaterThan(0)
    for (const [said, , next] of rows) {
      for (const text of [...quoted(said!), ...quoted(next!)]) expect(normalized, text).toContain(`${placeholder(text)}`)
    }
  })

  it('lists every headline describeStatus has', () => {
    const headlines = [...source.matchAll(/headline: '([^']+)'/g)].map((match) => match[1]!)
    expect(headlines.length).toBeGreaterThan(10)
    const listed = rows.flatMap(([said]) => quoted(said!))
    for (const headline of headlines) expect(listed, headline).toContain(headline)
    expect(listed).toContain('Signed in')
  })
})
