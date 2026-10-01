import type { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { isSafePreviewHref, resolvePreviewImageSrc } from './markdownPreviewPolicy'
import { routeLink } from '../../utils/chatLinks'

export interface MarkdownPreviewProps {
  value: string
  className?: string
  /** When true, relative image paths are left as-is. Default false to avoid origin fetches. */
  allowRelativeImages?: boolean
}

function PreviewLink({
  href,
  children
}: {
  href?: string
  children?: ReactNode
}) {
  if (!isSafePreviewHref(href)) {
    return <span>{children}</span>
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
      if (href && /^https?:\/\//i.test(href)) { event.preventDefault(); routeLink(href) }
    }}>
      {children}
    </a>
  )
}

function PreviewImage({
  src,
  alt,
  allowRelativeImages
}: {
  src?: string
  alt?: string
  allowRelativeImages: boolean
}) {
  const safeSrc = resolvePreviewImageSrc(src, allowRelativeImages)
  if (!safeSrc) {
    return (
      <span className="markdown-preview-blocked-image" role="note">
        {alt ? `Image omitted: ${alt}` : 'Image omitted'}
      </span>
    )
  }
  return <img src={safeSrc} alt={alt ?? ''} />
}

export function MarkdownPreview({
  value,
  className = 'files-text-preview chat-markdown',
  allowRelativeImages = false
}: MarkdownPreviewProps) {
  const components: Components = {
    a: ({ href, children }) => <PreviewLink href={href}>{children}</PreviewLink>,
    img: ({ src, alt }) => (
      <PreviewImage src={src} alt={alt} allowRelativeImages={allowRelativeImages} />
    )
  }

  return (
    <article className={className}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {value}
      </ReactMarkdown>
    </article>
  )
}
