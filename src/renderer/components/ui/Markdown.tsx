import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

/** Collapse `1.<newline(s)>content` onto one line — LLMs often emit the marker alone. */
function fixNumberedListBreaks(text: string): string {
  return text.replace(/^(\d+)\.\s*\n+\s*\n*/gm, '$1. ')
}

/** Collapse 3+ consecutive newlines to a single blank line. */
function collapseExcessBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}

function normalizeMarkdown(text: string): string {
  return collapseExcessBlankLines(fixNumberedListBreaks(text))
}

export function Markdown({ children }: { children: string }) {
  const safeContent = normalizeMarkdown(children)
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ a: ({ href, children: c }) => <a href={href} target="_blank" rel="noopener noreferrer">{c}</a> }}>
      {safeContent}
    </ReactMarkdown>
  )
}
