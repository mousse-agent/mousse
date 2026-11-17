import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * The threads a piece of owned work belongs to: a turn, a send, a subagent run, a request that names only threads.
 * Work started inside it (an MCP call the turn makes, a chat run, a nested request) belongs to the same threads.
 *
 * `null` is work of the whole profile, or work whose reach is not known: a request that names a project, a folder or
 * a repository, an automation tick, a shared MCP connection. Deleting a thread waits for or refuses such work as it
 * always did; only work scoped to unrelated threads is let through (`MmsProfileServices.deleteGuard`).
 */
export interface WorkScope {
  readonly threadIds: readonly string[]
}

const storage = new AsyncLocalStorage<WorkScope | null>()

/** The scope of the work this code runs in; `null` outside any scoped work. */
export function currentWorkScope(): WorkScope | null {
  return storage.getStore() ?? null
}

/** Runs `work` as part of `scope`: owned work it starts is counted under the same threads. */
export function runInWorkScope<T>(scope: WorkScope | null, work: () => T): T {
  return storage.run(scope, work)
}

/** The scope of work that belongs to one thread; `null` when the thread is not known. */
export function threadScope(threadId: string | undefined | null): WorkScope | null {
  return threadId && threadId !== '__unbound__' ? { threadIds: [threadId] } : null
}

/** Parameter names that name a thread (`threadId`, `parentThreadId`, `taskId`, `threadIds`, ...). */
const THREAD_KEY = /^(?:[a-z]+)?(?:thread|task)Ids?$/i
/**
 * Words of parameter names that reach files beyond a thread: a project, a folder, a repository, a worktree, a file.
 * A request that names one of these (at any depth) is not scoped to its threads, so a delete keeps waiting for it.
 */
const LOCATION_WORDS = new Set(['path', 'paths', 'cwd', 'folder', 'folders', 'dir', 'dirs', 'directory', 'directories', 'root', 'roots',
  'project', 'projects', 'repo', 'repos', 'repository', 'repositories', 'worktree', 'worktrees', 'workspace', 'workspaces',
  'file', 'files', 'filename', 'location', 'locations', 'checkout', 'volume', 'drive', 'uri', 'url'])
const LOCATION_PARTS = ['worktree', 'workspace', 'repositor', 'folder', 'directory', 'checkout', 'filepath', 'filename']

function namesLocation(key: string): boolean {
  const lower = key.toLowerCase()
  if (LOCATION_PARTS.some((part) => lower.includes(part))) return true
  return key.split(/(?=[A-Z])|[_\-.\s]/).some((word) => LOCATION_WORDS.has(word.toLowerCase()))
}

/**
 * The scope of a protocol request, from its parameters: the threads it names, when it names nothing that reaches
 * beyond them (no project, folder, repository, worktree or file). Anything else is `null`, and so is a request that
 * names an id `isThread` does not know as a thread here (`__unbound__`, a chat's task id, another computer's thread).
 */
export function requestWorkScope(params: unknown, isThread: (id: string) => boolean): WorkScope | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const threads = new Set<string>()
  let local = true
  const visit = (value: unknown, depth: number): void => {
    if (!local || !value || typeof value !== 'object') return
    if (depth > 4) { local = false; return }
    if (Array.isArray(value)) { for (const item of value) visit(item, depth + 1); return }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!local) return
      // A thread named anywhere in the request is one of its threads.
      if (THREAD_KEY.test(key)) {
        for (const id of Array.isArray(item) ? item : [item]) {
          if (typeof id === 'string' && id && id !== '__unbound__' && isThread(id)) threads.add(id)
          else if (id !== undefined && id !== null) local = false
        }
        continue
      }
      if (namesLocation(key)) { local = false; return }
      visit(item, depth + 1)
    }
  }
  visit(params, 0)
  return local && threads.size ? { threadIds: [...threads] } : null
}
