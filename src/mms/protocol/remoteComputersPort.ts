/**
 * What remote subagents (issue #469) need from Bridge: the user's other computers and the routed calls
 * that create, drive and read a thread on one of them (`bridge/routed/remoteComputers.ts`). Composed
 * with Bridge; without it no agent can start a subagent on another computer.
 *
 * The calls are those a window of this computer may make (`shared/bridge/routed.ts`), and the other
 * computer applies the same limits to them: its switch for working on its threads, and the permission
 * limit it set for this computer. Results name that computer's threads by its own ids, unqualified.
 */
export interface RemoteComputer {
  /** Its Net node id. */
  node: string
  name: string
  /** Connected to this computer right now. */
  online: boolean
}

export interface RemoteComputersPort {
  /** The user's other computers that run threads; undefined while the device list cannot be read. */
  computers(): RemoteComputer[] | undefined
  /** One routed call to `node`. Throws a `DomainRpcError` a person could read (offline, outdated, refused). */
  call(node: string, method: string, params: Record<string, unknown>, options?: { idem?: string; signal?: AbortSignal }): Promise<unknown>
  /**
   * The project of `node` that is the same Git repository as the folder `projectPath` here: its id, and
   * `weak` when only the root commit matched. Null when it has none, or the folder is not a repository.
   */
  matchProject(node: string, projectPath: string, signal?: AbortSignal): Promise<{ projectId: string; weak: boolean } | null>
}
