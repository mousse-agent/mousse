// #595: a secret that spans lines (a private key, a service account file) is masked however a tool returns it, including
// a file-reading tool that numbers each line, which splits the whole value.
import { describe, expect, it } from 'vitest'
import { secretMasker } from '../../src/mms/secrets/secretMasking'

const KEY_LINES = ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj', 'abc', '-----END PRIVATE KEY-----']
const KEY = KEY_LINES.join('\n')
const mask = secretMasker([{ name: 'SSH_KEY', value: KEY }])!

/** How a file-reading tool shows a file: each line after its number and a tab. */
const numbered = (text: string) => text.split('\n').map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join('\n')

// How the value comes back: [what returns it, the text]
const SHAPES: Array<[string, string]> = [
  ['as it is', KEY],
  ['with Windows line ends', KEY.replace(/\n/g, '\r\n')],
  ['with numbered lines', numbered(KEY)],
  ['one line quoted in a reply', `The key starts with ${KEY_LINES[1]} and goes on.`]
]

describe('a multiline secret', () => {
  it.each(SHAPES)('is masked when it comes back %s', (_how, text) => {
    const out = mask(text)
    for (const line of KEY_LINES.slice(1, 3)) expect(out).not.toContain(line)
    expect(out).toContain('[secret SSH_KEY hidden]')
  })

  it('leaves a short line alone, and a one-line secret is masked whole only', () => {
    expect(mask('abc')).toBe('abc')
    const single = secretMasker([{ name: 'API_TOKEN', value: 'tok_0123456789abcdef' }])!
    expect(single('tok_0123456789abcdef tok_0123')).toBe('[secret API_TOKEN hidden] tok_0123')
  })
})
