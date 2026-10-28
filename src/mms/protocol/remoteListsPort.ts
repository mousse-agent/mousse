import type {
  Project,
  Thread,
  ThreadActivitySnapshot,
  ThreadSearchResult,
  ThreadSearchSkipped
} from '../../shared/types'

/**
 * What the protocol handlers and the server need from the merged lists of the user's other computers
 * (`bridge/routed/RemoteLists.ts`). The lists are composed with Bridge; a profile without them lists
 * only its own threads. Every row here names its thread and project with qualified ids (`<node>:<id>`)
 * and carries `node`.
 */
export interface RemoteListsPort {
  /**
   * The rows of other computers' threads. With `scope`, only those that belong to a project (a project
   * of another computer, or this computer's project that one of them matches by Git history) or, with
   * `null`, to no project. Empty while routing is off.
   */
  threads(scope?: { projectId: string | null }): Thread[]
  /** The projects of other computers, with `sameAs` where this computer has the same repository. */
  projects(): Project[]
  /** The status of the other computers' threads that are not idle, by qualified thread id. */
  activity(): ThreadActivitySnapshot
  /**
   * The matches on other computers for a search, each computer asked with a short deadline. A newer search
   * from the same connection ends the older one's calls.
   */
  search(
    connection: string | undefined,
    query: string,
    limit: number
  ): Promise<{ results: ThreadSearchResult[]; skipped: ThreadSearchSkipped[] }>
  /**
   * The Recently deleted lists of other computers, with the ids and names of their threads qualified and
   * each record marked with its computer. A computer that cannot be asked is named in `skipped`.
   */
  inventory(connection: string | undefined): Promise<{
    lifecycles: Array<Record<string, unknown>>
    taskNames: Record<string, string>
    skipped: ThreadSearchSkipped[]
  }>
  /**
   * A drag in the sidebar: the rows of other computers among `orderedIds` (qualified ids of the group, in the
   * order the person left them) take the places that keep the group in that order. The rows of this
   * computer must already have their new order.
   */
  reorder(orderedIds: readonly string[]): void
}
