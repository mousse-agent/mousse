import type { ReactNode } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { isSafePreviewHref, resolvePreviewImageSrc } from './markdownPreviewPolicy'
import { routeLink } from '../../utils/chatLinks'
import { mayContainMath } from '../../markdown/math/math-detect'
import { readMathClass } from '../../markdown/math/math-markup'
import { MathBlock, MathInline } from '../../markdown/math/MathView'
import { remarkMousseMath } from '../../markdown/math/remark-mousse-math'
import { useRenderMath } from '../../markdown/math/renderMathSetting'

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

const remarkPlugins = [remarkGfm]
const remarkPluginsWithMath = [remarkGfm, remarkMousseMath]

/** Math arrives as `code` tagged by remarkMousseMath: inline, or inside `pre` for blocks. */
const mathComponents: Components = {
  code: ({ className, children, ...props }) => {
    const math = readMathClass(className)
    if (!math) return <code className={className} {...props}>{children}</code>
    return <MathInline tex={String(children ?? '')} display={math.display} delimiter={math.delimiter} />
  },
  pre: ({ node, children, ...props }) => {
    const code = node?.children[0]
    const classes = code?.type === 'element' ? code.properties.className : undefined
    if (code?.type !== 'element' || !Array.isArray(classes) || !readMathClass(classes.join(' '))) {
      return <pre {...props}>{children}</pre>
    }
    const text = code.children[0]
    const meta = code.properties.metastring
    return (
      <MathBlock
        code={text?.type === 'text' ? text.value : ''}
        isIncomplete={false}
        language="math"
        meta={typeof meta === 'string' ? meta : undefined}
      />
    )
  }
}

export function MarkdownPreview({
  value,
  className = 'files-text-preview chat-markdown',
  allowRelativeImages = false
}: MarkdownPreviewProps) {
  const math = useRenderMath() && mayContainMath(value)
  const components: Components = {
    ...(math ? mathComponents : {}),
    a: ({ href, children }) => <PreviewLink href={href}>{children}</PreviewLink>,
    img: ({ src, alt }) => (
      <PreviewImage src={src} alt={alt} allowRelativeImages={allowRelativeImages} />
    )
  }

  return (
    <article className={className}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={math ? remarkPluginsWithMath : remarkPlugins}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {value}
      </ReactMarkdown>
    </article>
  )
}
