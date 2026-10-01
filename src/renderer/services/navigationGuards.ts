export type NavigationReason = 'navigate' | 'profile' | 'unmount'
export type NavigationGuard = (reason: NavigationReason) => boolean | Promise<boolean>

/** Per-renderer only. A decision never authorizes a different window or profile. */
export class NavigationGuards {
  private readonly guards = new Map<symbol, { guard: NavigationGuard; scope?: string }>()
  private pending: { scope?: string; decision: Promise<boolean> } | null = null

  register(guard: NavigationGuard, scope?: string): () => void {
    const id = Symbol('navigation-guard')
    this.guards.set(id, { guard, scope })
    return () => { this.guards.delete(id) }
  }

  confirm(reason: NavigationReason = 'navigate', scope?: string): Promise<boolean> {
    if (this.pending) {
      if (this.pending.scope === scope) return this.pending.decision
      // A decision for one surface cannot authorize a profile-wide departure.
      return this.pending.decision.then((allowed) => allowed ? this.confirm(reason, scope) : false)
    }
    const relevant = () => [...this.guards].filter(([, item]) => scope === undefined || item.scope === scope)
    const snapshot = relevant()
    const decision = (async () => {
      for (const [id, { guard }] of snapshot) {
        if (!this.guards.has(id)) return false
        try { if (!await guard(reason)) return false }
        catch { return false }
      }
      // A newly mounted dirty editor was not covered by the displayed question.
      return relevant().every(([id]) => snapshot.some(([prior]) => prior === id))
    })()
    this.pending = { scope, decision }
    void decision.finally(() => { if (this.pending?.decision === decision) this.pending = null })
    return decision
  }
}

const navigation = new NavigationGuards()
export const registerNavigationGuard = (guard: NavigationGuard, scope?: string): (() => void) => navigation.register(guard, scope)
export const confirmNavigation = (reason?: NavigationReason, scope?: string): Promise<boolean> => navigation.confirm(reason, scope)
