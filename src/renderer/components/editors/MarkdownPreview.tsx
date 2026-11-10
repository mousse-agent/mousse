import { memo, useEffect, useState, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import type { Element, Root } from 'hast'
import type rehypeHighlight from 'rehype-highlight'
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

/**
 * rehype-highlight registers every common grammar each time it is attached, and react-markdown
 * attaches it on each render of each preview. One highlighter serves them all. It and its grammars
 * (highlight.js) load on the first preview or the idle preload after startup, not with the app.
 */
let highlight: ReturnType<typeof rehypeHighlight> | undefined
let highlightLoad: Promise<unknown> | undefined
const highlightedPlugins = [() => highlight!]
export function preloadMarkdownHighlight(): Promise<unknown> {
  return highlightLoad ??= import('rehype-highlight').then(({ default: rehypeHighlight }) => {
    highlight ??= rehypeHighlight()
  }).catch((error: unknown) => {
    highlightLoad = undefined
    throw error
  })
}

/**
 * Until the highlighter loads, code blocks get the class it would add (`hljs`), so their type and
 * spacing are already final and only the colours arrive with it. Same rule as rehype-highlight: a
 * `language-*` or `lang-*` class, and no `no-highlight`.
 */
function markHighlightable(node: Root | Element): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (child.tagName === 'code' && node.type === 'element' && node.tagName === 'pre') {
      const classes = Array.isArray(child.properties.className) ? child.properties.className.map(String) : []
      const named = classes.some((name) => name.startsWith('lang-') || name.startsWith('language-'))
      const off = classes.some((name) => name === 'no-highlight' || name === 'nohighlight')
      if (named && !off && !classes.includes('hljs')) child.properties.className = ['hljs', ...classes]
    }
    markHighlightable(child)
  }
}
const plainPlugins = [() => markHighlightable]

function useHighlightPlugins() {
  const [ready, setReady] = useState(() => highlight !== undefined)
  useEffect(() => {
    if (ready) return
    let live = true
    preloadMarkdownHighlight().then(() => { if (live) setReady(true) }, () => { /* code stays uncoloured */ })
    return () => { live = false }
  }, [ready])
  return ready ? highlightedPlugins : plainPlugins
}

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

/**
 * Markdown rendered for reading. Parsing and highlighting are the costly part, so the same text
 * renders again only when its props change: a parent that renders for something else (a poll, a
 * status line) leaves it alone.
 */
export const MarkdownPreview = memo(function MarkdownPreview({
  value,
  className = 'files-text-preview chat-markdown',
  allowRelativeImages = false
}: MarkdownPreviewProps) {
  const math = useRenderMath() && mayContainMath(value)
  const rehypePlugins = useHighlightPlugins()
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
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {value}
      </ReactMarkdown>
    </article>
  )
})
