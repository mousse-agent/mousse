import type { ScheduledJob, ScheduledWebhookDeliveryOutcome } from './types'

/**
 * The Request trigger as the Automations page shows it: the request fields a prompt uses (`{{body.path}}`, filled from
 * the request body by `promptPlaceholders.ts` when a request starts the run), a ready-to-copy `curl` line signed the
 * way the listener checks it, and whether a job may take requests at all.
 */

/** One `{{body.path}}` in a prompt, as the daemon reads it (whitespace inside the braces allowed). */
const FIELD = /\{\{\s*body((?:\.[A-Za-z0-9_-]+)+)\s*\}\}/g
/** A field path the person types for + Field: `pr.number`, `repo`, `items.0.id`. */
const FIELD_PATH = /^[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64}){0,15}$/
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype'])

/** The request fields a prompt uses, in order of first use, without `body.` (`pr.number`). */
export function requestFields(prompt: string): string[] {
  const fields: string[] = []
  for (const match of prompt.matchAll(FIELD)) {
    const path = match[1]!.slice(1)
    if (!fields.includes(path)) fields.push(path)
  }
  return fields
}

/** A typed field path cleaned for + Field (a leading `body.` or braces are dropped), or null when it cannot be one. */
export function fieldPath(text: string): string | null {
  const path = text.trim().replace(/^\{\{\s*|\s*\}\}$/g, '').replace(/^body\./, '')
  if (!FIELD_PATH.test(path) || path.split('.').some((segment) => BLOCKED.has(segment))) return null
  return path
}

/** The token + Field inserts for a path: what the daemon fills from the request body. */
export function fieldToken(path: string): string {
  return `{{body.${path}}}`
}

/** The prompt with every use of one field taken out. */
export function withoutField(prompt: string, path: string): string {
  return prompt.replace(FIELD, (whole, dotted: string) => (dotted.slice(1) === path ? '' : whole)).replace(/[ \t]{2,}/g, ' ')
}

/**
 * A JSON body with each field the prompt uses, filled with a placeholder value to replace (`"<pr.number>"`). A path
 * whose start is also a whole field keeps the longer one (`pr` then `pr.number` gives `{"pr":{"number":…}}`).
 */
export function sampleBody(fields: readonly string[]): string {
  const root: Record<string, unknown> = {}
  for (const path of fields) {
    const segments = path.split('.')
    let node: Record<string, unknown> = root
    segments.forEach((segment, index) => {
      if (index === segments.length - 1) {
        if (typeof node[segment] !== 'object' || node[segment] === null) node[segment] = `<${path}>`
        return
      }
      if (typeof node[segment] !== 'object' || node[segment] === null) node[segment] = {}
      node = node[segment] as Record<string, unknown>
    })
  }
  return JSON.stringify(root)
}

/** Single quotes for a POSIX shell. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * A `curl` line that signs the body the way the listener checks it (`X-Mousse-Signature: sha256=HMAC(secret,
 * "<timestamp>.<body>")`, `X-Mousse-Timestamp` within five minutes), for a POSIX shell with `openssl`. The secret is
 * named only when it was just issued and is still on screen; otherwise the line reads it from `$MOUSSE_SECRET`.
 */
export function curlLine(input: { url: string; fields: readonly string[]; secret?: string }): string {
  const secret = input.secret ? shellQuote(input.secret) : '"$MOUSSE_SECRET"'
  return [
    `BODY=${shellQuote(sampleBody(input.fields))}; TS=$(date +%s);`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac ${secret} -hex | sed 's/^.* //');`,
    `curl -sS -X POST ${shellQuote(input.url)} -H "X-Mousse-Timestamp: $TS" -H "X-Mousse-Signature: sha256=$SIG" --data-binary "$BODY"`
  ].join(' ')
}

/**
 * Why a job cannot take requests, or null when it can. An automation an agent added takes them only after the person
 * keeps it (Keep removes its end); a bot runs on its schedule; a one-time automation runs once.
 */
export function requestRefusal(job: Pick<ScheduledJob, 'createdBy' | 'expiresAt' | 'schedule' | 'bot'> & { trigger?: ScheduledJob['trigger'] }): string | null {
  if (job.bot) return 'A bot runs on its schedule. Ask it in its chat for anything else.'
  if (job.trigger?.threadEvent) return 'It wakes on its pull request, so it takes no request URL.'
  if (job.createdBy && job.expiresAt) return 'Keep it first. An automation an agent added takes requests only after you keep it.'
  if (job.schedule.kind === 'once') return 'A one-time automation runs once. Change When to On demand first.'
  return null
}

/** Whether a job may take requests now: the listener and the store both ask (an agent-added one only once kept). */
export function takesRequests(job: Pick<ScheduledJob, 'createdBy' | 'expiresAt'>): boolean {
  return !job.createdBy || !job.expiresAt
}

/** How a delivery ended, in the log's words. */
export type DeliveryWord = 'Accepted' | 'Rejected signature' | 'Rate limited' | 'Too large' | 'Replay' | 'Busy' | 'Paused'

const OUTCOME_WORD: Record<ScheduledWebhookDeliveryOutcome, DeliveryWord> = {
  accepted: 'Accepted',
  queued: 'Accepted',
  completed: 'Accepted',
  failed: 'Accepted',
  dispatch_failed: 'Accepted',
  uncertain: 'Accepted',
  running: 'Busy',
  pending: 'Busy',
  paused: 'Paused',
  replay: 'Replay',
  rejected_signature: 'Rejected signature',
  rate_limited: 'Rate limited',
  too_large: 'Too large'
}

export function deliveryWord(outcome: ScheduledWebhookDeliveryOutcome): DeliveryWord {
  return OUTCOME_WORD[outcome] ?? 'Accepted'
}

/** A delivery that started (or will start) a run with its stored payload, so it can be resent. */
export function deliveryStartedRun(outcome: ScheduledWebhookDeliveryOutcome): boolean {
  return OUTCOME_WORD[outcome] === 'Accepted'
}
