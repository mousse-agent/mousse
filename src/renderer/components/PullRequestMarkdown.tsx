import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { inlineImageUrl, safeWebUrl } from './pullRequestPanelLogic'

/** Opens a web address in the user's own browser, never inside the app. */
export function openExternalUrl(url: string): void {
  const safe = safeWebUrl(url)
  if (safe) window.open(safe, '_blank', 'noopener,noreferrer')
}

function ExternalLink({ href, children }: { href?: string; children?: ReactNode }) {
  const url = safeWebUrl(href)
  // Anything but a web address (a script, a relative path, a mail link) is only text.
  if (!url) return <span>{children}</span>
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => {
        event.preventDefault()
        openExternalUrl(url)
      }}
    >
      {children}
    </a>
  )
}

/**
 * An image from GitHub's own hosts is drawn inline and opens full size in the browser; one that fails to load (a
 * private attachment needs a signed-in browser) or comes from anywhere else is a link, so nothing else is fetched.
 */
function CommentImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const [failed, setFailed] = useState(false)
  const url = typeof src === 'string' ? safeWebUrl(src) : null
  const inline = typeof src === 'string' ? inlineImageUrl(src) : null
  const label = alt ? `Image: ${alt}` : 'Image'
  if (!url) return <span className="pr-panel-image-omitted">{label} (not shown)</span>
  if (!inline || failed) return <ExternalLink href={url}>{label}</ExternalLink>
  return (
    <a
      className="pr-panel-image"
      href={url}
      title={alt || undefined}
      onClick={(event) => {
        event.preventDefault()
        openExternalUrl(url)
      }}
    >
      <img src={inline} alt={alt ?? ''} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    </a>
  )
}

const components: Components = {
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  img: ({ src, alt }) => <CommentImage src={src} alt={alt} />
}

const remarkPlugins = [remarkGfm]

/**
 * A remark's markdown as safe elements. Raw HTML in the text is dropped (`skipHtml`; nothing is injected),
 * links open in the user's browser, and images from GitHub show inline.
 */
export const PullRequestMarkdown = memo(function PullRequestMarkdown({ text }: { text: string }) {
  return (
    <div className="pr-panel-markdown">
      <ReactMarkdown skipHtml remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
