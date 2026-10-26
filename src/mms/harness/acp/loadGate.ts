// Adapted from T3 Code (MIT, (c) 2026 T3 Tools Inc., commit d53873b6a4); see THIRD_PARTY_NOTICES.md.
/**
 * The `session/load` gate (agent CLIs plan §2, S4). Loading a saved session makes the agent replay
 * its history as `session/update` notifications; some agents never answer the load request at
 * all. The gate applies to the one session being loaded:
 *
 * 1. it starts `waiting`;
 * 2. the load's RPC reply makes it `ready`;
 * 3. a first replayed update for the session makes it `replaying`, and 2 s without another one
 *    makes it `ready`;
 * 4. the gateway's deadline (`loadWithDeadline`, 90 s) covers an agent that does neither.
 *
 * While it is not ready, replayed messages and tool output of the session are discarded and setup
 * metadata (modes, config options, commands, usage) is kept. A reply after `ready` changes
 * nothing, and updates for other sessions pass through.
 */

export const LOAD_REPLAY_IDLE_MS = 2_000

export type LoadGateState = 'waiting' | 'replaying' | 'ready'

/** Session updates that describe the session rather than replay its conversation. */
const SETUP_UPDATES = new Set(['current_mode_update', 'config_option_update', 'available_commands_update', 'usage_update', 'session_info_update'])

export class LoadGate {
  state: LoadGateState = 'waiting'
  /** Settles once the gate is ready. */
  readonly ready: Promise<void>
  private markReady!: () => void
  private idle: ReturnType<typeof setTimeout> | undefined

  constructor(readonly sessionId: string, private readonly idleMs: number = LOAD_REPLAY_IDLE_MS) {
    this.ready = new Promise((resolve) => {
      this.markReady = resolve
    })
  }

  /** The load request answered. */
  reply(): void {
    this.finish()
  }

  /**
   * An update arrived: `pass` (deliver it), `keep` (setup metadata of the loading session: apply
   * it, it is not conversation) or `discard` (replayed conversation).
   */
  update(sessionId: string | undefined, update: unknown): 'pass' | 'keep' | 'discard' {
    if (this.state === 'ready' || (sessionId !== undefined && sessionId !== this.sessionId)) return 'pass'
    const kind = (update as { sessionUpdate?: unknown } | null)?.sessionUpdate
    if (typeof kind === 'string' && SETUP_UPDATES.has(kind)) return 'keep'
    this.state = 'replaying'
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.finish(), this.idleMs)
    this.idle.unref?.()
    return 'discard'
  }

  /** Stops the idle timer (the load was abandoned). */
  dispose(): void {
    clearTimeout(this.idle)
  }

  private finish(): void {
    if (this.state === 'ready') return
    clearTimeout(this.idle)
    this.state = 'ready'
    this.markReady()
  }
}
