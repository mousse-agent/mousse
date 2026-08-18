import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ a: ({ href, children: c }) => <a href={href} target="_blank" rel="noopener noreferrer">{c}</a> }}>
      {children}
    </ReactMarkdown>
  )
}
