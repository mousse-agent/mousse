/**
 * Which fields of a routed call, result or event hold the id of a thread or project of the computer
 * that runs the thread, and how the router rewrites them.
 *
 * On the computer that asks, a thread of another computer is named `<nodeId>:<threadId>` (see
 * `threadRef.ts`). Everything the owner sends back names its threads and projects by their own ids, so
 * the router qualifies them before anything reaches a window, and unqualifies them in what a window
 * sends. The lists below are the whole rule: an id field that is not named here comes through as the
 * owner wrote it. `tests/net/bridge/routed/ids.test.ts` walks real results and events and fails when
 * an owner id is left unqualified.
 */
import { ensureQualified, parseQualifiedId, qualifyId } from '../threadRef'

/** Fields that hold a thread id, wherever they are in a result or an event. */
export const ROUTED_THREAD_ID_KEYS: readonly string[] = [
  'threadId',
  'parentThreadId',
  'rootThreadId',
  'childThreadId',
  'originThreadId',
  'sourceThreadId',
  'forkThreadId',
  'forkedFromThreadId',
  'ownerThreadId',
  'workspaceThreadId',
  'createdByThreadId',
  'liveThreadId',
  'mousseThreadId',
  // A lifecycle record calls the thread that owns a resource its owner task.
  'ownerTaskId'
]

/** Fields that hold a project id, wherever they are in a result or an event. */
export const ROUTED_PROJECT_ID_KEYS: readonly string[] = ['projectId', 'createdByProjectId']

/**
 * A place in a value: dot-separated keys, `[]` after a key for every item of an array, and `{}` after
 * the last key when the keys of that map are the ids. The value found there is an id, not a field named
 * like one.
 */
export type IdPath = string

export interface RoutedIdPaths {
  /** Paths whose value is a thread id. */
  threads?: readonly IdPath[]
  /** Paths whose value is a project id. */
  projects?: readonly IdPath[]
}

/** The thread and project objects (`id`) that results and events carry. */
const THREAD_AND_PROJECT: RoutedIdPaths = { threads: ['thread.id'], projects: ['project.id', 'projects[].id'] }

/**
 * Results with an `id` that is a thread or project id (the fields named `…ThreadId` / `projectId`
 * are rewritten for every result and need no entry). A result that is not here has none.
 */
export const ROUTED_RESULT_ID_PATHS: Readonly<Record<string, RoutedIdPaths>> = {
  'threads.get': THREAD_AND_PROJECT,
  'thread.snapshot': { threads: ['thread.id'] },
  'threads.create': THREAD_AND_PROJECT,
  'threads.rename': THREAD_AND_PROJECT,
  'threads.pin': THREAD_AND_PROJECT,
  'threads.settle': THREAD_AND_PROJECT,
  'threads.regenerateTitle': THREAD_AND_PROJECT,
  'threads.setWorktreeEnabled': THREAD_AND_PROJECT,
  'threads.setModel': THREAD_AND_PROJECT,
  'threads.setPermissionMode': THREAD_AND_PROJECT,
  // A lifecycle record names its thread `taskId`, and what the thread owns names it `ownerTaskId`.
  'threads.delete': { threads: ['taskId', 'thread.id', 'lifecycle.taskId', 'lifecycle.ownerTaskId'] },
  'threads.trash': { threads: ['taskId', 'thread.id', 'lifecycle.taskId', 'lifecycle.ownerTaskId'] },
  'threads.restore': { threads: ['taskId', 'thread.id', 'lifecycle.taskId', 'lifecycle.ownerTaskId'] },
  'threads.inventory': {
    threads: [
      'taskId',
      'thread.id',
      'threads[].id',
      'resources[].ownerTaskId',
      'lifecycles[].taskId',
      'lifecycles[].ownerTaskId',
      'lifecycles[].resources[].ownerTaskId',
      'lifecycle.taskId',
      'lifecycle.ownerTaskId',
      'inventory.taskId',
      'taskNames{}'
    ]
  },
  'thread.fork': { threads: ['thread.id', 'fork.id'] },
  'thread.mergeBack': { threads: ['thread.id'] },
  'projects.open': THREAD_AND_PROJECT,
  'projects.rename': THREAD_AND_PROJECT,
  'projects.pin': THREAD_AND_PROJECT,
  'projects.remove': { projects: ['projects[].id'] },
  'projects.list': { projects: ['projects[].id'] },
  'projects.match': { projects: ['projectId'] },
  'pullRequests.startThread': { threads: ['thread.id', 'threadId', 'existing[].id'] },
  'composer.options': {},
  'subagents.list': { threads: ['subagents[].threadId'] },
  // The status of every thread that is not idle, by thread id.
  'activity.snapshot': { threads: ['activity{}'] }
}

/** Events with an `id` that is a thread or project id; the same rule as for results. */
export const ROUTED_EVENT_ID_PATHS: Readonly<Record<string, RoutedIdPaths>> = {
  'thread.metadata': { threads: ['thread.id'] },
  'threads.updated': { threads: ['threads[].id'] },
  'projects.updated': { projects: ['projects[].id'] }
}

/** Params of a call that name a thread or project, which the router rewrites to the owner's own ids. */
export const ROUTED_PARAM_THREAD_KEYS: readonly string[] = [
  'threadId',
  'originThreadId',
  'sourceThreadId',
  'forkThreadId'
]
export const ROUTED_PARAM_PROJECT_KEYS: readonly string[] = ['projectId']

/** Where a reference to a thread or project hides in a value that is not an id field: a message's text. */
const REFERENCE_BLOCK = /(\[Mousse references data=")([^"]+)("\])/g
const REFERENCE_LINES = /^(\s*(?:Thread|Project) ID: )(\S+)/gm

export interface QualifyContext {
  /** The computer that runs the thread. */
  node: string
  /** This computer, whose own project ids stay as they are. */
  self?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The id a reference carries, as this computer names it: the owner's own ids are qualified, and an id
 * the owner holds of this computer's (a reference a person on this computer wrote) is plain again.
 */
function incomingReferenceId(id: string, context: QualifyContext): string {
  const parsed = parseQualifiedId(id)
  if (parsed) return parsed.node === context.self ? parsed.id : id
  return qualifyId(context.node, id)
}

/** The id a reference carries to the owner: its own ids are plain, and this computer's are qualified with it. */
function outgoingReferenceId(id: string, context: QualifyContext): string {
  const parsed = parseQualifiedId(id)
  if (parsed) return parsed.node === context.node ? parsed.id : id
  return context.self ? qualifyId(context.self, id) : id
}

function mapReferenceText(
  content: string,
  map: (id: string) => string
): string {
  if (!content.includes('[Mousse references')) return content
  return content
    .replace(REFERENCE_BLOCK, (whole, open: string, encoded: string, close: string) => {
      try {
        const references = JSON.parse(decodeURIComponent(encoded)) as unknown
        if (!Array.isArray(references)) return whole
        const rewritten = references.map((reference) => {
          if (!isRecord(reference)) return reference
          const copy: Record<string, unknown> = { ...reference }
          for (const key of ['threadId', 'projectId'])
            if (typeof copy[key] === 'string') copy[key] = map(copy[key] as string)
          return copy
        })
        return `${open}${encodeURIComponent(JSON.stringify(rewritten))}${close}`
      } catch {
        return whole
      }
    })
    .replace(REFERENCE_LINES, (_line, prefix: string, id: string) => `${prefix}${map(id)}`)
}

function qualifyReferenceText(content: string, context: QualifyContext): string {
  return mapReferenceText(content, (id) => incomingReferenceId(id, context))
}

/**
 * A message this computer sends to the owner, with the thread and project references it carries named
 * the way the owner names them. Without it a reference to a thread of this computer would come back
 * qualified with the owner's node, pointing at a thread that is not there.
 */
export function outgoingMessageText(content: string, context: QualifyContext): string {
  return mapReferenceText(content, (id) => outgoingReferenceId(id, context))
}

/** The value at `path`, rewritten in place of a copy; every other part is shared with `value`. */
function rewriteAt(
  value: unknown,
  path: readonly string[],
  rewrite: (id: string) => string
): unknown {
  if (!path.length) return typeof value === 'string' ? rewrite(value) : value
  const [head, ...rest] = path
  // `name{}`: the keys of the map at `name` are the ids.
  if (head.endsWith('{}') && !rest.length) {
    const mapKey = head.slice(0, -2)
    if (!isRecord(value) || !isRecord(value[mapKey])) return value
    const renamed: Record<string, unknown> = {}
    for (const [id, entry] of Object.entries(value[mapKey] as Record<string, unknown>)) renamed[rewrite(id)] = entry
    return { ...value, [mapKey]: renamed }
  }
  const each = head.endsWith('[]')
  const key = each ? head.slice(0, -2) : head
  if (!isRecord(value) || !(key in value)) return value
  const inner = value[key]
  if (each) {
    if (!Array.isArray(inner)) return value
    return { ...value, [key]: inner.map((item) => rewriteAt(item, rest, rewrite)) }
  }
  const next = rewriteAt(inner, rest, rewrite)
  return next === inner ? value : { ...value, [key]: next }
}

/**
 * The record of a thread's `startedFrom` names a project of the computer that asked (`node`), not of
 * the one that runs the thread: it is qualified with that node, and left alone when it is this one.
 */
function qualifyStartedFrom(value: Record<string, unknown>, context: QualifyContext): unknown {
  const startedFrom = value.startedFrom
  if (!isRecord(startedFrom) || typeof startedFrom.projectId !== 'string') return value
  const origin = typeof startedFrom.node === 'string' ? startedFrom.node : undefined
  if (!origin || origin === context.self || parseQualifiedId(startedFrom.projectId)) return value
  return { ...value, startedFrom: { ...startedFrom, projectId: qualifyId(origin, startedFrom.projectId) } }
}

/** Keys whose objects are threads or projects, so that their `id` is an id of one. */
const ID_OBJECT_KEYS: Readonly<Record<string, 'thread' | 'project'>> = {
  thread: 'thread',
  threads: 'thread',
  project: 'project',
  projects: 'project'
}

function walk(value: unknown, context: QualifyContext, depth: number): unknown {
  if (depth > 64) return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = walk(item, context, depth + 1)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  if (!isRecord(value)) return value
  let out: Record<string, unknown> | undefined
  const set = (key: string, next: unknown): void => {
    out ??= { ...value }
    out[key] = next
  }
  for (const [key, inner] of Object.entries(value)) {
    if (
      typeof inner === 'string' &&
      (ROUTED_THREAD_ID_KEYS.includes(key) || ROUTED_PROJECT_ID_KEYS.includes(key))
    ) {
      const next = ensureQualified(context.node, inner)
      if (next !== inner) set(key, next)
      continue
    }
    if (key === 'startedFrom') continue
    // A reference to a thread or project is identified `thread:<id>` / `project:<id>`.
    if (key === 'reference' && isRecord(inner) && typeof inner.id === 'string') {
      const found = /^(thread|project):(.+)$/.exec(inner.id)
      const renamed = found ? { ...inner, id: `${found[1]}:${ensureQualified(context.node, found[2])}` } : inner
      const next = walk(renamed, context, depth + 1)
      if (next !== inner) set(key, next)
      continue
    }
    // An object under `thread`, `threads`, `project` or `projects` is a thread or a project: its `id` is the id.
    if (ID_OBJECT_KEYS[key] && (isRecord(inner) || Array.isArray(inner))) {
      const named = (item: unknown): unknown =>
        isRecord(item) && typeof item.id === 'string' ? { ...item, id: ensureQualified(context.node, item.id) } : item
      const next = walk(Array.isArray(inner) ? inner.map(named) : named(inner), context, depth + 1)
      if (next !== inner) set(key, next)
      continue
    }
    if (key === 'content' && typeof inner === 'string') {
      const next = qualifyReferenceText(inner, context)
      if (next !== inner) set(key, next)
      continue
    }
    const next = walk(inner, context, depth + 1)
    if (next !== inner) set(key, next)
  }
  const result = out ?? value
  return 'startedFrom' in result ? qualifyStartedFrom(result, context) : result
}

function rewritePaths(
  value: unknown,
  paths: RoutedIdPaths | undefined,
  context: QualifyContext
): unknown {
  let out = value
  for (const path of paths?.threads ?? [])
    out = rewriteAt(out, path.split('.'), (id) => ensureQualified(context.node, id))
  for (const path of paths?.projects ?? [])
    out = rewriteAt(out, path.split('.'), (id) => ensureQualified(context.node, id))
  return out
}

/** A result of the routed `method`, with every thread and project of the owner named by a qualified id. */
export function qualifyRoutedResult(method: string, value: unknown, context: QualifyContext): unknown {
  return walk(rewritePaths(value, ROUTED_RESULT_ID_PATHS[method], context), context, 0)
}

/** An event of the owner (by its local name), qualified like a result. */
export function qualifyRoutedEvent(type: string, data: unknown, context: QualifyContext): unknown {
  return walk(rewritePaths(data, ROUTED_EVENT_ID_PATHS[type], context), context, 0)
}

/** The qualified ids a call names, unqualified, and the computers they belong to. */
export interface UnqualifiedParams {
  params: Record<string, unknown>
  /** Every computer a qualified id in the call names, once each. A call that names none stays here. */
  nodes: string[]
  /** Whether the call also names a thread or project of this computer (a plain id). */
  hasLocal: boolean
}

/** A key that holds an id or a list of ids (`threadId`, `orderedIds`, `sourceThreadId`...). */
const ID_KEY = /Ids?$/
/** A key that names a thread or a project, so a plain id there is one of this computer's. */
const THREAD_OR_PROJECT_KEY = /(Thread|Project)Ids?$|^(threadIds?|projectIds?)$/
/** Free text is never read for ids: a message that happens to hold one is only text. */
const TEXT_KEYS = new Set([
  'content',
  'text',
  'message',
  'title',
  'name',
  'query',
  'summary',
  'reason',
  'comment',
  'description',
  'body',
  'data',
  'answers',
  'state',
  'draftInput',
  'feedback'
])
const MAX_DEPTH = 6

/**
 * Splits the ids a call names into the computer each belongs to and the id there. An id is found in any
 * field whose name ends in `Id` or `Ids`, at any depth and inside arrays, so a qualified id cannot slip
 * past routing (or the refusal of a connection that may not route) by being somewhere unexpected. A
 * call that names ids of more than one computer, or of one computer and this one, is refused.
 */
export function unqualifyRoutedParams(params: Record<string, unknown>): UnqualifiedParams {
  const nodes = new Set<string>()
  let hasLocal = false
  const visit = (value: unknown, key: string, depth: number): unknown => {
    if (depth > MAX_DEPTH) return value
    if (typeof value === 'string') {
      if (!ID_KEY.test(key)) return value
      const parsed = parseQualifiedId(value)
      if (parsed) {
        nodes.add(parsed.node)
        return parsed.id
      }
      if (THREAD_OR_PROJECT_KEY.test(key) && value) hasLocal = true
      return value
    }
    if (Array.isArray(value)) return value.length > 10_000 ? value : value.map((item) => visit(item, key, depth + 1))
    if (!isRecord(value)) return value
    const out: Record<string, unknown> = {}
    for (const [name, inner] of Object.entries(value)) out[name] = TEXT_KEYS.has(name) ? inner : visit(inner, name, depth + 1)
    return out
  }
  const out = visit(params, '', 0) as Record<string, unknown>
  return { params: out, nodes: [...nodes], hasLocal }
}
