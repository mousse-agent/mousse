import { dayLabel } from './render'

/**
 * The memory guard (docs/plans/bot-context.md §9): every `memory_save`, and every journal row that
 * enters a context pack, passes it first. It rejects invisible and bidi characters, credential
 * shapes (secrets belong in a vault, #595, never in memory) and instruction-shaped text. These are
 * heuristics, not proofs: the pack still frames everything it carries as data.
 */

export type GuardReason = 'invisible' | 'credential' | 'instruction'

export type GuardResult = { ok: true } | { ok: false; reason: GuardReason; message: string }

const OK: GuardResult = { ok: true }

// Zero-width and format characters that hide text, bidi overrides and isolates, the BOM, tag
// characters and C0/C1 controls other than tab and newline. ZWJ and ZWNJ (U+200C, U+200D) stay:
// emoji sequences and several scripts need them.
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb]|[\u{e0000}-\u{e007f}]/u

const CREDENTIALS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|passcode)\s*[:=]\s*\S+/i,
  /\b(?:api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*\S{6,}/i
]

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

function credential(text: string): GuardResult | undefined {
  const found = CREDENTIALS.some((pattern) => pattern.test(text)) ||
    (text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []).some(highEntropy)
  return found ? { ok: false, reason: 'credential', message: 'It looks like a password, key or token. Secrets are never kept in memory.' } : undefined
}

function instruction(text: string): GuardResult | undefined {
  return INSTRUCTIONS.some((pattern) => pattern.test(text))
    ? { ok: false, reason: 'instruction', message: 'It reads like instructions to an assistant. Memory keeps facts and notes, not orders.' }
    : undefined
}

/** The guard for a `memory_save`: all three checks. */
export function guardMemoryText(text: string): GuardResult {
  return invisible(text) ?? credential(text) ?? instruction(text) ?? OK
}

/**
 * The guard for a journal row entering a pack. The owner's own words skip the instruction check:
 * they are the owner's to give. Everything else gets all three.
 */
export function guardPackText(text: string, who: string): GuardResult {
  return invisible(text) ?? credential(text) ?? (who === 'owner' ? undefined : instruction(text)) ?? OK
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
