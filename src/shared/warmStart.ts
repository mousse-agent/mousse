import type { ProfilePublicDto } from './profiles/types'
import type { ChatMessage, Project, Thread } from './types'

/**
 * What a window showed last time, kept by the main process so the next launch can show it before the background
 * service answers (`app:warmStart`). Display only: nothing in it is sent to the service, and the window drops it when
 * its trusted profile binding names another profile.
 */
export interface WarmStartView {
  /** The profile the last window was bound to. Never used for a request; only compared with the trusted binding. */
  profileId: string
  /** That profile's name, colour and avatar, for the profile button. */
  profile?: ProfilePublicDto
  threads: Thread[]
  projects: Project[]
  /** The thread the window showed, and its most recent messages. */
  activeThreadId: string | null
  messages: ChatMessage[]
}
