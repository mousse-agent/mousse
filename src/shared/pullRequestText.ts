/** Text rules shared by the pull request panel and the message a thread starts from. */

const FENCE_OR_COMMENT = /(`{3,}[\s\S]*?(?:`{3,}|$))|(`[^`\n]*`)|(<!--[\s\S]*?(?:-->|$))/g

/**
 * Removes HTML comments (`<!-- ... -->`), which the host hides too. Code spans and fenced code keep
 * theirs; an unclosed comment runs to the end, as it does on the host.
 */
export function stripHtmlComments(text: string): string {
  if (!text.includes('<!--')) return text
  return text.replace(FENCE_OR_COMMENT, (match, fence: string | undefined, span: string | undefined) => {
    const isCode = fence !== undefined || span !== undefined
    return isCode ? match : ''
  })
}
