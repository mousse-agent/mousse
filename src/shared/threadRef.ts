import { isId } from './net/ids'

/**
 * Names a thread or a project on another of the user's computers: `<nodeId>:<id>`.
 *
 * A thread or project of this computer keeps its plain id. Node ids are `nod_` plus 26 characters
 * and the ids of threads and projects never contain a colon, so the two forms cannot be mixed up.
 * Rows carry `node`, so the interface never has to parse an id; only the router does, here.
 */
export interface ThreadRef {
  /** The computer that runs the thread or holds the project. */
  node: string
  /** The id on that computer. */
  id: string
}

const SEPARATOR = ':'

/** The id of a thread or project on `node`, as this computer names it. */
export function qualifyId(node: string, id: string): string {
  return `${node}${SEPARATOR}${id}`
}

/** The computer and plain id of a qualified id; undefined for a plain id of this computer. */
export function parseQualifiedId(value: unknown): ThreadRef | undefined {
  if (typeof value !== 'string') return undefined
  const at = value.indexOf(SEPARATOR)
  if (at < 0) return undefined
  const node = value.slice(0, at)
  const id = value.slice(at + 1)
  if (!isId('node', node) || !id.length || id.includes(SEPARATOR)) return undefined
  return { node, id }
}

export function isQualifiedId(value: unknown): value is string {
  return parseQualifiedId(value) !== undefined
}

/**
 * The id on its own computer: the part after the node of a qualified id, and a plain id as it is.
 * `unqualifyId(qualifyId(node, id)) === id`.
 */
export function unqualifyId(value: string): string {
  return parseQualifiedId(value)?.id ?? value
}

/** Qualifies `id` for `node`; an id that is already qualified is returned as it is. */
export function ensureQualified(node: string, id: string): string {
  return parseQualifiedId(id) ? id : qualifyId(node, id)
}
