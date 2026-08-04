/**
 * Reversible spawn setup. Register compensating actions as resources are acquired; commit
 * only after the agent record is durable. This prevents an orphan worker/worktree on errors.
 */
export class SpawnTransaction {
  private rollbacks: Array<() => void | Promise<void>> = []
  private committed = false

  defer(rollback: () => void | Promise<void>): void {
    if (this.committed) throw new Error('Cannot add rollback after transaction commit')
    this.rollbacks.push(rollback)
  }

  commit(): void {
    this.committed = true
    this.rollbacks = []
  }

  async rollback(): Promise<void> {
    if (this.committed) return
    const actions = this.rollbacks.splice(0).reverse()
    for (const action of actions) {
      try {
        await action()
      } catch {
        // Rollback is best-effort; retain the original spawn failure.
      }
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const value = await operation()
      this.commit()
      return value
    } catch (error) {
      await this.rollback()
      throw error
    }
  }
}
