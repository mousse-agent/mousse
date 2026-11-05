import { MousseLogoOutline } from './MousseLogoOutline'

/** The logo and headline above an empty chat's composer, anchored so the composer stays centred. */
export function EmptyThreadHeading({ headline }: { headline: string }) {
  return (
    <>
      <MousseLogoOutline className="chat-empty-logo" />
      <h1 className="chat-empty-title">{headline}</h1>
    </>
  )
}
