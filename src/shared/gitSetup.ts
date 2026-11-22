/** Setup state reported by the desktop host before the workspace service is available. */
export type GitSetup =
  | { phase: 'downloading' }
  | { phase: 'installing'; native?: boolean }
  | { phase: 'required'; canInstall: boolean; message: string }
  | { phase: 'failed'; message: string }
  | null
