import { redactErrorText } from './errors'

/** Longest line kept from Git output; a progress line or a minified hook message can be far longer. */
const MAX_GIT_LINE_LENGTH = 500

/**
 * Makes Git output safe to show: removes credentials and caps each line.
 * Adds the remote shapes Git prints that `redactErrorText` does not know:
 * `ssh://` and `git://` URLs with a password, and `user:password@host` without a scheme.
 */
export function redactGitText(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const redacted = redactErrorText(line)
        .replace(/\b((?:ssh|git|git\+ssh|ssh\+git):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
        .replace(/(^|[\s'"(=])[\w.~%+-]+:[^\s/@'"]+@(?=[\w-]+\.[\w-])/g, '$1[redacted]@')
      return redacted.length > MAX_GIT_LINE_LENGTH ? `${redacted.slice(0, MAX_GIT_LINE_LENGTH)}…` : redacted
    })
    .join('\n')
}
