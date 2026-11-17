import { Fragment, type ReactNode } from 'react'
import { Reply } from '../lib/icons'
import { splitSentMessage } from '../lib/composerQuotes'

/** A quote a sent message replied to (#364): the reply icon and the quoted words, at its place in the message. */
export function SentQuotePill({ text }: { text: string }) {
  return (
    <span className="sent-quote-pill" title={text}>
      <Reply size={13} strokeWidth={2} className="sent-quote-icon" aria-hidden />
      <span className="sr-only">Replying to: </span>
      <span className="sent-quote-text">{text}</span>
    </span>
  )
}

/**
 * A sent message's words with each quote it replied to drawn as a pill. The words themselves are what the agent got:
 * every quote in double quotes, in a paragraph of its own (`lib/composerQuotes.ts`).
 */
export function WithSentQuotes({ text, render }: { text: string; render: (text: string) => ReactNode }) {
  const segments = splitSentMessage(text)
  if (segments.length === 1 && segments[0]!.kind === 'text') return <>{render(text)}</>
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={index}>{segment.kind === 'quote' ? <SentQuotePill text={segment.text} /> : render(segment.text)}</Fragment>
      ))}
    </>
  )
}
