/**
 * Progress file written by agents of the retired progress-file protocol (docs/run-engine/SPEC.md
 * §14.5). Nothing writes it any more; worktrees and retirement manifests created before Phase 4 may
 * still hold it, so it stays a recognised control file for their validation and reconstruction.
 */
export const LEGACY_AGENT_PROGRESS_FILE = '.mousse/task-progress.json'

/** Mousse control files that may exist in a worker checkout without being worker output. */
export const MOUSSE_CONTROL_FILE_PATHS: readonly string[] = [
  LEGACY_AGENT_PROGRESS_FILE,
  '.mousse/materialized-inputs.exclude'
]
