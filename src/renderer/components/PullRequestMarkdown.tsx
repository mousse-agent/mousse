import { memo, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { safeWebUrl } from './pullRequestPanelLogic'

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

/** Images are shown as links: attachments on private repositories need a signed-in browser to load, and nothing is fetched on the user's behalf. */
function ImageLink({ src, alt }: { src?: string | Blob; alt?: string }) {
  const url = typeof src === 'string' ? safeWebUrl(src) : null
  const label = alt ? `Image: ${alt}` : 'Image'
  if (!url) return <span className="pr-panel-image-omitted">{label} (not shown)</span>
  return <ExternalLink href={url}>{label}</ExternalLink>
}

const components: Components = {
  a: ({ href, children }) => <ExternalLink href={href}>{children}</ExternalLink>,
  img: ({ src, alt }) => <ImageLink src={src} alt={alt} />
}

const remarkPlugins = [remarkGfm]

/**
 * A remark's markdown as safe elements. Raw HTML in the text is dropped (`skipHtml`; nothing is injected),
 * links open in the user's browser, and images are links.
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
