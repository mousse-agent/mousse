import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/** Collapse `1.<newline(s)>content` onto one line — LLMs often emit the marker alone. */
function fixNumberedListBreaks(text: string): string {
  return text.replace(/^(\d+)[.)]\s*\n+\s*/gm, '$1. ')
}

/**
 * Collapse blank lines between consecutive list items so a loosely-emitted
 * list parses as a tight list. Tight lists render without wrapping each item
 * in <p>, which removes the paragraph-margin stacking that reads as
 * double-spaced. Paragraph breaks before the list itself are preserved.
 */
function collapseLooseListGaps(text: string): string {
  return text.replace(/\n{2,}([ \t]*(?:[-*+]|\d+[.)])\s)/g, '\n$1')
}

/** Collapse 3+ consecutive newlines to a single blank line. */
function collapseExcessBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

/**
 * Normalize outside fenced code blocks only — collapsing newlines inside a
 * fence would corrupt code, diffs, and ASCII diagrams.
 */
function normalizeMarkdown(text: string): string {
  const parts = text.split(/(```[\s\S]*?(?:```|$))/g)
  return parts
    .map((part, index) => {
      // Odd indices are the captured fence blocks; leave them byte-identical.
      if (index % 2 === 1) return part
      return collapseExcessBlankLines(collapseLooseListGaps(fixNumberedListBreaks(part)))
    })
    .join('')
}

export function Markdown({ children }: { children: string }) {
  const safeContent = normalizeMarkdown(children)
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ a: ({ href, children: c }) => <a href={href} target="_blank" rel="noopener noreferrer">{c}</a> }}>
      {safeContent}
    </ReactMarkdown>
  )
}
