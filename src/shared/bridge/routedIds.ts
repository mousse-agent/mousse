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
  'mousseThreadId'
]

/** Fields that hold a project id, wherever they are in a result or an event. */
export const ROUTED_PROJECT_ID_KEYS: readonly string[] = ['projectId', 'createdByProjectId']

/**
 * A place in a value: dot-separated keys, `[]` after a key for every item of an array. The value
 * found there is an id, not a field named like one.
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
  'threads.delete': { threads: ['taskId', 'thread.id'] },
  'threads.trash': { threads: ['taskId', 'thread.id'] },
  'threads.restore': { threads: ['taskId', 'thread.id'] },
  'threads.inventory': { threads: ['taskId', 'thread.id', 'threads[].id', 'resources[].ownerTaskId'] },
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
  'subagents.list': { threads: ['subagents[].threadId'] }
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

function qualifyReferenceText(content: string, context: QualifyContext): string {
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
            if (typeof copy[key] === 'string') copy[key] = ensureQualified(context.node, copy[key])
          return copy
        })
        return `${open}${encodeURIComponent(JSON.stringify(rewritten))}${close}`
      } catch {
        return whole
      }
    })
    .replace(REFERENCE_LINES, (_line, prefix: string, id: string) => `${prefix}${ensureQualified(context.node, id)}`)
}

/** The value at `path`, rewritten in place of a copy; every other part is shared with `value`. */
function rewriteAt(
  value: unknown,
  path: readonly string[],
  rewrite: (id: string) => string
): unknown {
  if (!path.length) return typeof value === 'string' ? rewrite(value) : value
  const [head, ...rest] = path
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

/**
 * Splits the ids a call names into the computer each belongs to and the id there. A call that names
 * ids of more than one computer, or of one computer and this one, is refused by the router.
 */
export function unqualifyRoutedParams(params: Record<string, unknown>): UnqualifiedParams {
  const nodes = new Set<string>()
  let hasLocal = false
  const out: Record<string, unknown> = { ...params }
  for (const key of [...ROUTED_PARAM_THREAD_KEYS, ...ROUTED_PARAM_PROJECT_KEYS]) {
    const value = out[key]
    if (typeof value !== 'string') continue
    const parsed = parseQualifiedId(value)
    if (parsed) {
      nodes.add(parsed.node)
      out[key] = parsed.id
    } else hasLocal = true
  }
  // A reference names a thread or a project by the fields of the reference itself.
  const reference = out.reference
  if (isRecord(reference)) {
    const copy: Record<string, unknown> = { ...reference }
    for (const key of ['threadId', 'projectId']) {
      const parsed = parseQualifiedId(copy[key])
      if (parsed) {
        nodes.add(parsed.node)
        copy[key] = parsed.id
      } else if (typeof copy[key] === 'string') hasLocal = true
    }
    out.reference = copy
  }
  return { params: out, nodes: [...nodes], hasLocal }
}
