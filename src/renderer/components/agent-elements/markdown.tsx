"use client"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeHighlight from "rehype-highlight"
import { cn } from "./utils/cn"

export type MarkdownProps = { content: string; className?: string; textContrast?: "normal" | "high" }

function fixNumberedListBreaks(text: string): string {
  return text.replace(/^(\d+)\.\s*\n+\s*\n*/gm, "$1. ")
}

export function Markdown({ content, className }: MarkdownProps) {
  const safeContent = fixNumberedListBreaks(content)
  return (
    <div className={cn("an-markdown overflow-hidden wrap-break-word", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {safeContent}
      </ReactMarkdown>
    </div>
  )
}
