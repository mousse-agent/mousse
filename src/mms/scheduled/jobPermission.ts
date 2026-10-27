import { describePermissionMode, isStricter, narrowPermissionMode, normalizePermissionMode, type PermissionMode } from '../../shared/permissionMode'

export { EXECUTABLE_JOB_FIELDS, isExecutableJobEdit, isWorkflowPrompt } from '../../shared/jobPermissionEdit'

/** The permission fields of a job. A stored value that is not a mode (a corrupted file) reads as `ask`. */
export interface JobPermissionFields {
  permissionMode?: PermissionMode
  permissionCeiling?: PermissionMode
}

function read(value: PermissionMode | undefined): PermissionMode | undefined {
  return value === undefined ? undefined : normalizePermissionMode(value)
}

/** Why a workflow job (a prompt starting with `/`) takes no permission mode. */
export const WORKFLOW_PERMISSION_REFUSAL =
  'A job that runs a workflow (its prompt starts with /) takes no permission mode: workflows do not run under one. Remove the permission mode, or use a plain prompt.'

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

export type JobPermissionEdit =
  | { ok: true; permissionMode?: PermissionMode; permissionCeiling?: PermissionMode; changed: boolean }
  | { ok: false; error: string }

/**
 * The job's permission fields after an edit by someone who holds `editor`. An edit never raises the ceiling
 * above the editor's own.
 * - A mode chosen on purpose becomes the job's mode. A person (`canRaise`) may thereby set the ceiling to their own
 *   mode, which can be above what it was; the mode may not exceed it. Anyone else (an agent) never raises the
 *   ceiling: it stays the stricter of what it was and the editor's, and a mode above that is refused.
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
  /** True for a person choosing a mode on purpose; an agent editor passes false and can never raise a ceiling. */
  canRaise: boolean
}): JobPermissionEdit {
  const { stored, editor, patchMode, executable, canRaise } = options
  const storedMode = read(stored.permissionMode)
  const storedCeiling = read(stored.permissionCeiling)
  if (typeof patchMode === 'string') {
    const ceiling = canRaise ? editor : narrowPermissionMode(storedCeiling, editor)
    const error = permissionAboveCeiling(patchMode, ceiling)
    if (error) return { ok: false, error }
    return { ok: true, permissionMode: patchMode, permissionCeiling: ceiling, changed: true }
  }
  if (patchMode === null) {
    return { ok: true, permissionMode: undefined, permissionCeiling: narrowPermissionMode(storedCeiling, editor), changed: true }
  }
  if (!executable) return { ok: true, permissionMode: storedMode, permissionCeiling: storedCeiling, changed: false }
  const ceiling = narrowPermissionMode(storedCeiling, editor)
  const mode = storedMode === undefined ? undefined : narrowPermissionMode(storedMode, ceiling)
  return { ok: true, permissionMode: mode, permissionCeiling: ceiling, changed: true }
}

/** A refusal of an edit's permission fields; the protocol shows its message as it is. */
export class JobPermissionRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JobPermissionRefused'
  }
}
