import type { Message as PiMessage } from '@earendil-works/pi-ai'
import type { Message } from '../../../../shared/transcript'

/**
 * Every message pi-ai produces is a valid entry of Mousse's transcript (`shared/transcript.ts`),
 * so the pi engine stores its messages as they are. Checked by `npm run typecheck`: this stops
 * compiling when a pi-ai upgrade changes the message shape. One direction only; Mousse's
 * entries reach pi-ai through its string-widened `api` and `provider`.
 */
export const PI_MESSAGES_ARE_TRANSCRIPT_MESSAGES: PiMessage extends Message ? true : false = true
