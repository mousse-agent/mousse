import { describePermissionMode, isStricter, narrowPermissionMode, normalizePermissionMode, type PermissionMode } from '../../shared/permissionMode'

/** The permission fields of a job. A stored value that is not a mode (a corrupted file) reads as `ask`. */
export interface JobPermissionFields {
  permissionMode?: PermissionMode
  permissionCeiling?: PermissionMode
}

function read(value: PermissionMode | undefined): PermissionMode | undefined {
  return value === undefined ? undefined : normalizePermissionMode(value)
}

/**
 * The mode a run of the job asks for: the stricter of the job's mode and its ceiling, or nothing when the
 * job has neither (the run then follows its thread). The turn builder narrows this further by the thread's
 * own mode and its subagent lineage, so a run is never wider than any of the three.
 */
export function jobPermissionRequest(job: JobPermissionFields): PermissionMode | undefined {
  const mode = read(job.permissionMode)
  const ceiling = read(job.permissionCeiling)
  if (mode === undefined && ceiling === undefined) return undefined
  return narrowPermissionMode(ceiling, mode)
}

/** Why `mode` cannot be set on a job whose ceiling is `ceiling`; undefined when it can. */
export function permissionAboveCeiling(mode: PermissionMode | undefined, ceiling: PermissionMode | undefined): string | undefined {
  if (mode === undefined || ceiling === undefined) return undefined
  if (!isStricter(ceiling, mode)) return undefined
  return `A job cannot run above the mode its creator holds: ${describePermissionMode(mode)} is wider than ${describePermissionMode(ceiling)}. Choose ${describePermissionMode(ceiling)} or stricter, or raise the mode of the thread the job is created from.`
}

/** Edits that change what a job does when it runs. Changing the name, the schedule, the repeat or pausing does not. */
export const EXECUTABLE_JOB_FIELDS = ['prompt', 'selection', 'mode', 'workspace', 'threadId', 'projectId', 'createThread', 'permissionMode'] as const

/** True when the patch changes something a run does (so it is bounded by the editor's own ceiling). */
export function isExecutableJobEdit(patch: object): boolean {
  return EXECUTABLE_JOB_FIELDS.some((key) => (patch as Record<string, unknown>)[key] !== undefined)
}

export type JobPermissionEdit =
  | { ok: true; permissionMode?: PermissionMode; permissionCeiling?: PermissionMode; changed: boolean }
  | { ok: false; error: string }

/**
 * The job's permission fields after an edit by someone who holds `editor`. An edit never raises the ceiling
 * above the editor's own, and only an explicit mode choice can raise it at all:
 * - A mode chosen on purpose becomes the job's mode, and the ceiling is the editor's (a mode above it is refused).
 * - Any other edit of what the job does (`executable`, or clearing the mode) leaves the stricter of the stored
 *   ceiling and the editor's, and brings the job's mode down to it if it was wider.
 * - An edit that changes nothing a run does leaves both fields as they were.
 */
export function permissionsAfterEdit(options: {
  stored: JobPermissionFields
  editor: PermissionMode
  /** The patch's `permissionMode`: a mode, `null` to clear, `undefined` when the patch does not mention it. */
  patchMode: PermissionMode | null | undefined
  executable: boolean
}): JobPermissionEdit {
  const { stored, editor, patchMode, executable } = options
  const storedMode = read(stored.permissionMode)
  const storedCeiling = read(stored.permissionCeiling)
  if (typeof patchMode === 'string') {
    const error = permissionAboveCeiling(patchMode, editor)
    if (error) return { ok: false, error }
    return { ok: true, permissionMode: patchMode, permissionCeiling: editor, changed: true }
  }
  if (patchMode === null) {
    return { ok: true, permissionMode: undefined, permissionCeiling: narrowPermissionMode(storedCeiling, editor), changed: true }
  }
  if (!executable) return { ok: true, permissionMode: storedMode, permissionCeiling: storedCeiling, changed: false }
  const ceiling = narrowPermissionMode(storedCeiling, editor)
  const mode = storedMode === undefined ? undefined : narrowPermissionMode(storedMode, ceiling)
  return { ok: true, permissionMode: mode, permissionCeiling: ceiling, changed: true }
}
