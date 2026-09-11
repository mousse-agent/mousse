export type NavigationReason = 'navigate' | 'profile' | 'unmount'
export type NavigationGuard = (reason: NavigationReason) => boolean | Promise<boolean>

/** Per-renderer only. A decision never authorizes a different window or profile. */
export class NavigationGuards {
  private readonly guards = new Map<symbol, NavigationGuard>()
  private pending: Promise<boolean> | null = null

  register(guard: NavigationGuard): () => void {
    const id = Symbol('navigation-guard')
    this.guards.set(id, guard)
    return () => { this.guards.delete(id) }
  }

  confirm(reason: NavigationReason = 'navigate'): Promise<boolean> {
    if (this.pending) return this.pending
    const snapshot = [...this.guards]
    const decision = (async () => {
      for (const [id, guard] of snapshot) {
        if (!this.guards.has(id)) return false
        try { if (!await guard(reason)) return false }
        catch { return false }
      }
      // A newly mounted dirty editor was not covered by the displayed question.
      return [...this.guards.keys()].every((id) => snapshot.some(([prior]) => prior === id))
    })()
    this.pending = decision
    void decision.finally(() => { if (this.pending === decision) this.pending = null })
    return decision
  }
}

const navigation = new NavigationGuards()
export const registerNavigationGuard = (guard: NavigationGuard): (() => void) => navigation.register(guard)
export const confirmNavigation = (reason?: NavigationReason): Promise<boolean> => navigation.confirm(reason)
