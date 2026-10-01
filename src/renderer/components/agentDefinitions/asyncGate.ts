/** Prevents a late response from a previous profile/definition from mutating the current draft. */
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
