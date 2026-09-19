"use client"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { cn } from "./utils/cn"
import { classifyLink, routeLink, safeMarkdownUrl } from "../../lib/linkRouting"

export type MarkdownProps = { content: string; className?: string; textContrast?: "normal" | "high" }

function fixNumberedListBreaks(text: string): string {
  return text.replace(/^(\d+)\.\s*\n+\s*\n*/gm, "$1. ")
}

export function Markdown({ content, className }: MarkdownProps) {
  const safeContent = fixNumberedListBreaks(content)
  return (
    <div className={cn("an-markdown overflow-hidden wrap-break-word", className)}>
      <ReactMarkdown urlTransform={safeMarkdownUrl} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ a: ({ href, children }) => href && classifyLink(href).kind !== 'reject' ? <a href={href} onClick={(event) => { event.preventDefault(); routeLink(href) }}>{children}</a> : <span>{children}</span> }}>
        {safeContent}
      </ReactMarkdown>
    </div>
  )
}
