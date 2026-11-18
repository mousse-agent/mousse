// Deliberately narrower than the memory heuristic: IDs, attachments and prose need review, not refusal.
export const UNMISTAKABLE_KEYS = /\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:AKIA|ASIA)[0-9A-Z]{16}\b|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}\b|ya29\.[0-9A-Za-z_-]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----/
export function unmistakableCredential(text: string): boolean {
  if (UNMISTAKABLE_KEYS.test(text)) return true
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi)) {
    try {
      const url = new URL(match[0])
      if (url.password || [...url.searchParams].some(([key, value]) => value && /(?:token|key|secret|signature|password|passwd|pwd|authorization|credentials?)$/i.test(key))) return true
    } catch { /* Invalid addresses remain visible to the owner. */ }
  }
  return false
}

/** The whole credential span, never just the private-key header or part of a credential URL. */
export function pastedSecretShape(text: string): { start: number; end: number; name: string } | undefined {
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi)) {
    if (unmistakableCredential(match[0])) return { start: match.index!, end: match.index! + match[0].length, name: 'API_KEY' }
  }
  const match = UNMISTAKABLE_KEYS.exec(text)
  if (!match) return undefined
  const start = match.index
  const key = match[0]
  const end = key.startsWith('-----BEGIN')
    ? (() => { const close = /-----END [A-Z ]*PRIVATE KEY-----/.exec(text.slice(start)); return close ? start + close.index + close[0].length : text.length })()
    : start + key.length
  const name = key.startsWith('sk-') ? 'OPENAI_API_KEY'
    : /^(?:gh[pousr]_|github_pat_)/.test(key) ? 'GITHUB_TOKEN'
    : /^(?:AKIA|ASIA)/.test(key) ? 'AWS_ACCESS_KEY_ID'
    : key.startsWith('xox') ? 'SLACK_TOKEN'
    : key.startsWith('AIza') ? 'GOOGLE_API_KEY' : 'API_KEY'
  return { start, end, name }
}
