import type { ProfilePublicDto } from './profiles/types'
import type { ProjectIconImage } from './projectIcon'
import type { ChatMessage, Project, Thread, ThreadActivitySnapshot } from './types'

/**
 * What a window showed last time, kept by the main process so the next launch can show it before the background
 * service answers. The window reads it once, synchronously, before its first frame (`app.warmStartView`). Display
 * only: nothing in it is sent to the service, and the window drops it when its trusted profile binding names another
 * profile.
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
  /** The threads' last settled states (Done, Input), so the sidebar's badges show as they were. Never Working. */
  activity?: ThreadActivitySnapshot
  /** The projects' icons as last read, by project id; null for a project that has none (its folder shows). */
  projectIcons?: Record<string, ProjectIconImage | null>
  /** What the window knew of this computer and the profile's default provider (the rows' provider marks). */
  appInfo?: WarmStartAppInfo
}

export interface WarmStartAppInfo {
  platform: string
  repoRoot: string
  llmProvider: string
  deviceName?: string
}
