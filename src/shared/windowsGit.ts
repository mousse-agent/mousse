/** Setup state reported by the desktop host before the workspace service is available. */
export type WindowsGitSetup =
  | { phase: 'downloading' }
  | { phase: 'installing' }
  | { phase: 'failed'; message: string }
  | null
