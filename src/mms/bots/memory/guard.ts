import { dayLabel } from './render'

/**
 * The memory guard (docs/plans/bot-context.md §9): every `memory_save`, and every journal row that
 * enters a context pack, passes it first. It rejects invisible and bidi characters, credential
 * shapes (secrets belong in a vault, #595, never in memory) and instruction-shaped text. In a pack
 * only the credential piece of a row is held back. These are heuristics, not proofs: the pack still
 * frames everything it carries as data.
 */

export type GuardReason = 'invisible' | 'credential' | 'instruction'

export type GuardResult = { ok: true } | { ok: false; reason: GuardReason; message: string }

const OK: GuardResult = { ok: true }

// Zero-width and format characters that hide text, bidi overrides and isolates, the BOM, tag
// characters and C0/C1 controls other than tab and newline. ZWJ and ZWNJ (U+200C, U+200D) stay:
// emoji sequences and several scripts need them.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/u

/**
 * Credential shapes, checked everywhere in the text, web addresses included. With `label`, the
 * first group is a label kept in place ("password: ") and only what follows it is the secret.
 */
const CREDENTIALS: ReadonlyArray<{ pattern: RegExp; label?: true; line?: true }> = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { pattern: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { pattern: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g },
  { pattern: /\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g },
  { pattern: /\bdiscord(?:app)?\.com\/api\/webhooks\/[A-Za-z0-9/_-]{20,}/g },
  // A password in a web address: https://name:secret@host.
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi, label: true },
  // A password may have spaces: outside a web address, the rest of its line is the secret.
  { pattern: /(\b(?:password|passwd|pwd|passcode)\s*[:=]\s*)\S+/gi, label: true, line: true },
  { pattern: /(\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*)\S{6,}/gi, label: true }
]

// Web addresses. Their host and path are never checked for randomness (a document's or a
// parcel's ID is not a secret), nor are most query values; the shapes above still are.
const URLS = /\bhttps?:\/\/[^\s<>"'`]+/gi
// A query or fragment value whose name says it is a secret: ?token=…, &sig=…, #access_token=….
const URL_SECRET_PARAM = /[?&#;]((?:[A-Za-z0-9_.-]*?)(?:token|key|secret|signature|sig|password|passwd|pwd|auth|credentials?|session(?:id)?|sid|code))=([^&#\s]{16,})/gi

const INSTRUCTIONS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+|my\s+)?(?:previous|prior|above|earlier|preceding|system|original)\s+(?:instructions?|messages?|rules?|prompts?|directions?|context)/i,
  /\byou\s+must\s+now\b/i,
  /\byou\s+are\s+now\s+(?:a|an|in|the|my|no\s+longer)\b/i,
  /\bnew\s+(?:system\s+)?instructions?\s*:/i,
  /\b(?:system|developer)\s+prompt\s*:/i,
  /<\/?\s*(?:system|assistant|user|tool_call|tool_use|function_calls?|invoke|parameter|antml:[a-z_]+)\b[^>]*>/i,
  /\[\/?(?:INST|SYS)\]|<<\/?SYS>>|<\|(?:im_start|im_end|system|assistant|user)\|>/,
  /\{\s*"(?:name|tool|function|tool_name)"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|input|parameters|args)"\s*:/i
]

/** True when `token` looks like a random secret: long, mixed case and digits, and high entropy. */
function highEntropy(token: string): boolean {
  if (token.length < 32 || !/[a-z]/.test(token) || !/[A-Z]/.test(token) || !/\d/.test(token)) return false
  const counts = new Map<string, number>()
  for (const char of token) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / token.length
    bits -= p * Math.log2(p)
  }
  return bits >= 4.2
}

function invisible(text: string): GuardResult | undefined {
  return INVISIBLE.test(text) ? { ok: false, reason: 'invisible', message: 'It has hidden or direction-changing characters. Write it in plain text.' } : undefined
}

type Span = readonly [start: number, end: number]

/** Where `text` holds something that looks like a password, key or token, sorted and merged. */
function credentialSpans(text: string): Span[] {
  const spans: Array<[number, number]> = []
  const urls = [...text.matchAll(URLS)].map((url): Span => [url.index, url.index + url[0].length])
  for (const { pattern, label, line } of CREDENTIALS)
    for (const match of text.matchAll(pattern)) {
      const start = match.index + (label ? match[1]!.length : 0)
      let end = match.index + match[0].length
      if (line && !urls.some(([from, to]) => start >= from && start < to)) {
        const lineEnd = text.indexOf('\n', start)
        end = lineEnd === -1 ? text.length : lineEnd
      }
      spans.push([start, end])
    }
  // Long random-looking tokens, outside web addresses; inside one, only secret-named values.
  let outside = text
  for (const url of text.matchAll(URLS)) {
    outside = outside.slice(0, url.index) + ' '.repeat(url[0].length) + outside.slice(url.index + url[0].length)
    for (const param of url[0].matchAll(URL_SECRET_PARAM)) {
      const end = url.index + param.index + param[0].length
      spans.push([end - param[2]!.length, end])
    }
  }
  for (const token of outside.matchAll(/[A-Za-z0-9+/_=-]{32,}/g))
    if (highEntropy(token[0])) spans.push([token.index, token.index + token[0].length])
  spans.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const span of spans) {
    const last = merged.at(-1)
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1])
    else merged.push([span[0], span[1]])
  }
  return merged
}

const CREDENTIAL_MESSAGE = 'It looks like a password, key or token. Secrets are never kept in memory.'

function instruction(text: string): GuardResult | undefined {
  return INSTRUCTIONS.some((pattern) => pattern.test(text))
    ? { ok: false, reason: 'instruction', message: 'It reads like instructions to an assistant. Memory keeps facts and notes, not orders.' }
    : undefined
}

/** The guard for a `memory_save`: all three checks, and any credential refuses the save. */
export function guardMemoryText(text: string): GuardResult {
  return invisible(text) ??
    (credentialSpans(text).length ? { ok: false, reason: 'credential', message: CREDENTIAL_MESSAGE } : undefined) ??
    instruction(text) ?? OK
}

export type PackTextResult = { ok: true; text: string } | Extract<GuardResult, { ok: false }>

/**
 * The guard for a journal row entering a pack. Hidden characters, and instruction-shaped text
 * from anyone but the owner (their words are theirs to give), hold back the whole row. Anything
 * that looks like a credential is replaced by `marker`, and the rest of the row stays.
 */
export function guardPackText(text: string, who: string, marker: string): PackTextResult {
  const refused = invisible(text) ?? (who === 'owner' ? undefined : instruction(text))
  if (refused && !refused.ok) return refused
  const spans = credentialSpans(text)
  if (!spans.length) return { ok: true, text }
  let out = ''
  let at = 0
  for (const [start, end] of spans) {
    out += text.slice(at, start) + marker
    at = end
  }
  return { ok: true, text: out + text.slice(at) }
}

const WEEKDAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)'
const RELATIVE: ReadonlyArray<{ pattern: RegExp; days?: number }> = [
  { pattern: /\b(?:the\s+)?day\s+after\s+tomorrow\b/i, days: 2 },
  { pattern: /\b(?:the\s+)?day\s+before\s+yesterday\b/i, days: -2 },
  { pattern: /\btomorrow\b/i, days: 1 },
  { pattern: /\byesterday\b/i, days: -1 },
  { pattern: /\btoday\b|\btonight\b|\bthis\s+(?:morning|afternoon|evening)\b/i, days: 0 },
  { pattern: new RegExp(`\\b(?:next|last|this|coming)\\s+(?:week|weekend|month|year|${WEEKDAY})\\b`, 'i') },
  { pattern: /\blast\s+night\b/i, days: -1 },
  { pattern: /\bin\s+(?:a|an|one|two|three|four|five|six|seven|\d+)\s+(?:days?|weeks?|months?|years?)\b/i },
  { pattern: /\b(?:a|an|one|two|three|four|five|six|seven|\d+)\s+(?:days?|weeks?|months?|years?)\s+(?:ago|from\s+now)\b/i },
  { pattern: /\b(?:later\s+)?this\s+week\b/i }
]

/**
 * A relative date the text leaves unresolved ("tomorrow", "next week"), with a refusal that says
 * the absolute form; undefined when there is none. Memory outlives the day it was written.
 */
export function relativeDateRefusal(text: string, now: number, timeZone?: string): string | undefined {
  for (const { pattern, days } of RELATIVE) {
    const match = pattern.exec(text)
    if (!match) continue
    const today = dayLabel(now, timeZone)
    const hint = days === undefined
      ? `write the date instead (today is ${today})`
      : `write "${dayLabel(now + days * 86_400_000, timeZone)}" instead`
    return `"${match[0]}" will not make sense later: ${hint}.`
  }
  return undefined
}
