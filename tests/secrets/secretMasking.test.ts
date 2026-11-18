// #595: a secret that spans lines (a private key, a service account file) is masked however a tool returns it, including
// a file-reading tool that numbers each line, which splits the whole value.
import { describe, expect, it } from 'vitest'
import { maskedCopy, secretMasker } from '../../src/mms/secrets/secretMasking'

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

// A JSON key file: its lines hold quotes and backslashes, which read differently once inside a JSON string.
const JSON_KEY_LINES = ['{', '  "type": "service_account",', '  "private_key_id": "a1b2c3d4e5f6a7b8",', '  "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----\\n",', '}']
const JSON_KEY = JSON_KEY_LINES.join('\n')
const jsonMask = secretMasker([{ name: 'GCP_KEY', value: JSON_KEY }])!

// Where a numbered read of it is kept: [what keeps it, the value]
const HOLDERS: Array<[string, unknown]> = [
  ['a tool result', { type: 'tool_result', content: numbered(JSON_KEY) }],
  ['a provider history entry that holds the result as JSON text', { role: 'tool', content: JSON.stringify({ output: numbered(JSON_KEY) }) }]
]

describe('a multiline JSON secret read with numbered lines', () => {
  it.each(HOLDERS)('is masked in a copy of %s', (_what, holder) => {
    const copy = maskedCopy(holder, jsonMask)
    expect(copy).not.toBe(holder)
    const text = JSON.stringify(copy)
    for (const secretPart of ['a1b2c3d4e5f6a7b8', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC']) expect(text).not.toContain(secretPart)
    expect(text).toContain('[secret GCP_KEY hidden]')
  })
})

const TOKEN = 'token/a+B<&\'0123456789'
const unicode = (c: string) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
const mixed = TOKEN.split('').map((c,i) => c === '/' ? '\\/' : i % 2 ? unicode(c).replace(/[a-f]/g, h=>h.toUpperCase()) : c).join('')
it.each([
 ['mixed printable Unicode and PHP escapes',mixed],
 ['nested JSON escapes',JSON.stringify(mixed).slice(1,-1)],
 ['whole base64',Buffer.from(TOKEN).toString('base64')],
 ['whole URL encoding',encodeURIComponent(TOKEN)],
 ['lowercase URL encoding',encodeURIComponent(TOKEN).replace(/%[0-9A-F]{2}/g,h=>h.toLowerCase())]
])('masks %s in saved rows and provider history',(_label,form)=>{
 const masker=secretMasker([{name:'TOKEN',value:TOKEN}])!
 expect(masker(`echo: ${form}`)).toBe('echo: [secret TOKEN hidden]')
 const holder={role:'tool',content:`echo: ${form}`}
 expect(maskedCopy(holder,masker).content).toBe('echo: [secret TOKEN hidden]')
})

it('keeps literal surrogate pairs covered when an encoder escapes another character',()=>{
 const value='token/🔐+0123456789'
 const form=value.replace('+','\\u002B')
 expect(secretMasker([{name:'UNICODE_KEY',value}])!(form)).toBe('[secret UNICODE_KEY hidden]')
})
