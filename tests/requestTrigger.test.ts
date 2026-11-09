import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { curlLine, deliveryStartedRun, deliveryWord, fieldPath, fieldToken, requestFields, requestRefusal, sampleBody, takesRequests, withoutField } from '../src/shared/requestTrigger'
import { renderPrompt } from '../src/mms/scheduled/promptPlaceholders'
import { signWebhookBody } from '../src/mms/scheduled/ScheduledWebhookServer'

describe('the Request trigger', () => {
  it('reads the fields a prompt uses the way the daemon fills them', () => {
    expect(requestFields('{{body}} and {{headers.x}} are not fields')).toEqual([])
    const prompt = 'Review #{{body.pr.number}} in {{ body.repo }}; again {{body.pr.number}}; not {{headers.x}}'
    expect(requestFields(prompt)).toEqual(['pr.number', 'repo'])
    // Every field it lists is one the daemon replaces.
    const rendered = renderPrompt(prompt, { bodyText: JSON.stringify({ pr: { number: 7 }, repo: 'mousse' }) }, { frameId: '0'.repeat(16) })
    expect(rendered.missing).toEqual([])
    expect(rendered.prompt).toContain('>7<')
  })

  it('cleans a typed field for + Field, and refuses one that cannot be a path', () => {
    expect(fieldPath(' pr.number ')).toBe('pr.number')
    expect(fieldPath('body.pr.number')).toBe('pr.number')
    expect(fieldPath('{{body.repo}}')).toBe('repo')
    expect(fieldPath('items.0.id')).toBe('items.0.id')
    for (const bad of ['', 'a b', 'a..b', '__proto__.x', 'a.constructor', '$x']) expect(fieldPath(bad)).toBeNull()
    expect(fieldToken('pr.number')).toBe('{{body.pr.number}}')
    expect(withoutField('Review {{body.pr.number}} in {{body.repo}}', 'pr.number')).toBe('Review in {{body.repo}}')
  })

  it('builds a body with each field, nested, to fill in', () => {
    expect(sampleBody(['pr.number', 'repo'])).toBe('{"pr":{"number":"<pr.number>"},"repo":"<repo>"}')
    expect(sampleBody(['pr', 'pr.number'])).toBe('{"pr":{"number":"<pr.number>"}}')
    expect(sampleBody([])).toBe('{}')
  })

  it('writes a curl line signed the way the listener checks it', () => {
    const line = curlLine({ url: 'http://127.0.0.1:18790/hooks/j1', fields: ['repo'], secret: "whsec_a'b" })
    expect(line).toContain(`BODY='{"repo":"<repo>"}'`)
    expect(line).toContain(`printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac 'whsec_a'\\''b' -hex`)
    expect(line).toContain('-H "X-Mousse-Timestamp: $TS" -H "X-Mousse-Signature: sha256=$SIG" --data-binary "$BODY"')
    expect(line).toContain("'http://127.0.0.1:18790/hooks/j1'")
    // What the line signs ("<ts>.<body>") is what the listener's check computes.
    const ts = 1_800_000_000
    expect(signWebhookBody('k', ts, '{"repo":"<repo>"}')).toBe(`sha256=${createHmac('sha256', 'k').update(`${ts}.{"repo":"<repo>"}`).digest('hex')}`)
    // Without a secret on screen, it reads the secret from the environment.
    expect(curlLine({ url: 'u', fields: [] })).toContain('-hmac "$MOUSSE_SECRET"')
  })

  it('takes requests on an agent-added automation only once it is kept', () => {
    const manual = { schedule: { kind: 'manual' as const } }
    expect(requestRefusal({ ...manual, createdBy: { threadId: 't' }, expiresAt: '2026-11-15T00:00:00.000Z' })).toMatch(/^Keep it first/)
    expect(takesRequests({ createdBy: { threadId: 't' }, expiresAt: '2026-11-15T00:00:00.000Z' })).toBe(false)
    expect(requestRefusal({ ...manual, createdBy: { threadId: 't' } })).toBeNull()
    expect(takesRequests({ createdBy: { threadId: 't' } })).toBe(true)
    expect(requestRefusal({ schedule: { kind: 'once', runAt: '2026-11-15T00:00:00.000Z' } })).toMatch(/On demand/)
    expect(requestRefusal({ ...manual, bot: { botId: 'b', scheduleId: 's', createdBy: 'owner' } })).toMatch(/bot/)
  })

  it('words each outcome the way the log shows it', () => {
    expect(deliveryWord('completed')).toBe('Accepted')
    expect(deliveryWord('rejected_signature')).toBe('Rejected signature')
    expect(deliveryWord('rate_limited')).toBe('Rate limited')
    expect(deliveryWord('too_large')).toBe('Too large')
    expect(deliveryWord('replay')).toBe('Replay')
    expect(deliveryStartedRun('failed')).toBe(true)
    expect(deliveryStartedRun('paused')).toBe(false)
  })
})
