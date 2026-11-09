import { THREAD_EVENT_KINDS, type ThreadEventKind } from '../../../shared/types'

/**
 * "when #712 gets a review address the comments" in the create row: an automation that wakes on a pull request's
 * activity. Like When, it never guesses: "when #712" with no event it can read is `ambiguous`.
 */
export type ThreadEventParse =
  | { kind: 'none' }
  | { kind: 'ambiguous'; number: number; reason: string }
  | { kind: 'ok'; number: number; events: ThreadEventKind[]; phrase: string; prompt: string }

const SOME = String.raw`(?:(?:a|an|any|new|another|more)\s+)*`
const CHECKS = String.raw`(?:checks?|ci|tests?|the\s+build|builds?)`

/** Event phrases, read right after "#712". */
const EVENTS: Array<{ pattern: RegExp; events: ThreadEventKind[] }> = [
  { pattern: new RegExp(String.raw`^(?:gets?|has|receives?)\s+${SOME}reviews?\b|^(?:is|gets)\s+reviewed\b`, 'i'), events: ['review'] },
  { pattern: new RegExp(String.raw`^(?:gets?|has|receives?)\s+${SOME}comments?\b|^(?:is\s+)?commented\s+on\b`, 'i'), events: ['comment'] },
  { pattern: new RegExp(String.raw`^(?:${CHECKS}\s+(?:fail(?:s|ed)?|break(?:s)?|go(?:es)?\s+red)|fails?\s+(?:its\s+)?${CHECKS}|(?:gets?|has)\s+failing\s+${CHECKS}|goes\s+red)\b`, 'i'), events: ['checks_failed'] },
  { pattern: new RegExp(String.raw`^(?:${CHECKS}\s+(?:pass(?:es|ed)?|go(?:es)?\s+green)|pass(?:es)?\s+(?:its\s+)?${CHECKS}|goes\s+green)\b`, 'i'), events: ['checks_passed'] },
  { pattern: new RegExp(String.raw`^(?:gets?\s+|has\s+)?(?:any\s+)?(?:activity|changes|updates?|news)\b|^changes\b`, 'i'), events: [...THREAD_EVENT_KINDS] }
]

/** "when #712", "when PR #712", "when pull request 712". */
const WHEN = /\bwhen\s+(?:(?:pr|pull\s+request)\s*)?#?(\d{1,7})\b\s*/i

export function parseThreadEvent(text: string): ThreadEventParse {
  const when = WHEN.exec(text)
  // "when 9" would be a time; a pull request needs # or the words PR / pull request.
  if (!when || !/#|pr|pull/i.test(when[0])) return { kind: 'none' }
  const number = Number(when[1])
  const after = text.slice(when.index + when[0].length)
  for (const entry of EVENTS) {
    const match = entry.pattern.exec(after)
    if (!match) continue
    const end = when.index + when[0].length + match[0].length
    const prompt = `${text.slice(0, when.index)} ${text.slice(end)}`
      .replace(/\s+/g, ' ')
      .replace(/^[\s,;:.…-]+|[\s,;:…-]+$/g, '')
      .replace(/^(?:then|to|and)\s+/i, '')
      .trim()
    return { kind: 'ok', number, events: entry.events, phrase: text.slice(when.index, end).trim(), prompt }
  }
  return { kind: 'ambiguous', number, reason: `Say what on #${number}: a review, a comment, checks failing or passing` }
}
