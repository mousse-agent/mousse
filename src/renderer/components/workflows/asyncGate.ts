/** Prevents a late response from a previous profile/document from mutating the current UI. */
export function createAsyncGate() {
  let generation = 0
  return {
    bump(): number {
      generation += 1
      return generation
    },
    current(): number {
      return generation
    },
    isCurrent(started: number): boolean {
      return started === generation
    }
  }
}

export function shouldApplyAsyncResult(started: number, current: number): boolean {
  return started === current
}

export function isCurrentProfileBoundary(
  startedProfileId: string,
  currentProfileId: string,
  startedDocumentId?: string,
  currentDocumentId?: string
): boolean {
  if (startedProfileId !== currentProfileId) return false
  if (startedDocumentId !== undefined && startedDocumentId !== currentDocumentId) return false
  return true
}
