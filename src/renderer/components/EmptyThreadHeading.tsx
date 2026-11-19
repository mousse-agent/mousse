import { isThreadStarted } from '../../shared/threadTitle'
import { useAppStore } from '../stores/appStore'
import { privateThreadHeadline } from '../utils/emptyThreadHeadline'
import { AnimatedHeadline } from './AnimatedHeadline'
import { EmptyThreadLogo } from './EmptyThreadLogo'
import { IncognitoGlasses } from './IncognitoGlasses'
import { MousseLogoOutline } from './MousseLogoOutline'

/** Whether the chat on screen is private: its thread's own setting once started, else the new chat's draft. */
function useActiveChatPrivate(): boolean {
  return useAppStore((state) => {
    const thread = state.activeThreadId ? state.threads.find((entry) => entry.id === state.activeThreadId) : undefined
    if (thread && isThreadStarted(thread)) return thread.localOnly === true
    const draft = state.composerWorkspaceDrafts[state.activeThreadId ?? '__blank__']
    return (draft ? draft.localOnly : thread?.localOnly) === true
  })
}

/**
 * The logo and headline above an empty chat's composer, anchored so the composer stays centred.
 * In a private chat the logo wears sunglasses and the headline says the chat is off the record.
 */
export function EmptyThreadHeading({ headline, incognito, animate = true }: { headline: string; incognito?: boolean; animate?: boolean }) {
  const privateChat = useActiveChatPrivate()
  const on = incognito ?? privateChat
  const label = on ? 'Mousse, incognito' : 'Mousse'
  const title = on ? 'Private: stays on this computer' : undefined
  const text = on ? privateThreadHeadline(headline) : headline
  if (!animate) {
    return (
      <>
        <MousseLogoOutline className="chat-empty-logo" label={label}>
          {on ? <IncognitoGlasses on /> : undefined}
        </MousseLogoOutline>
        <h1 className="chat-empty-title" title={title}>{text}</h1>
      </>
    )
  }
  return (
    <>
      <EmptyThreadLogo label={label} incognito={on} />
      <AnimatedHeadline className="chat-empty-title" title={title} text={text} />
    </>
  )
}
