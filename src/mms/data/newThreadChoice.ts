import type { ModelOverride } from '../../shared/providerInstances'
import type { NewThreadChoice, Project, Thread } from '../../shared/types'

/**
 * Once: the "Start new threads in a worktree" setting is gone, and each project remembers its own checkout choice
 * (`Project.newThread`). A setting that was turned off carries on as the choice of every project there was; on (the
 * default) needs nothing, because a project with no choice starts in a new worktree. The stored key is then removed.
 */
export function migrateWorktreeDefaultSetting(
  config: { assembleSettings(): { runs?: unknown }; removeRunsKey(key: string): boolean },
  projects: { seedWorktreeChoice(worktreeEnabled: boolean): void }
): void {
  const runs = config.assembleSettings().runs as Record<string, unknown> | undefined
  if (!runs || !Object.hasOwn(runs, 'worktreeByDefault')) return
  if (runs.worktreeByDefault === false) projects.seedWorktreeChoice(false)
  config.removeRunsKey('worktreeByDefault')
}

type Caller = { readonly clientType?: string; readonly bridgeCaller?: unknown } | undefined

/**
 * The project whose new threads should remember a change to `thread`: a person changed it from a window on this
 * computer (not the CLI, an agent or another computer), in a thread of a project here that no agent started.
 */
export function projectRememberingPick(
  connection: Caller,
  thread: Pick<Thread, 'projectId' | 'lineage'> | undefined,
  getProject: (id: string) => Project | undefined
): string | undefined {
  if (connection?.clientType !== 'gui' || connection.bridgeCaller) return undefined
  if (!thread?.projectId || thread.lineage || !getProject(thread.projectId)) return undefined
  return thread.projectId
}

/**
 * What a new thread made in `project` starts with: the project's remembered choice, for a thread a window or the
 * CLI on this computer creates. A remembered model it can no longer use (`usable` throws: its instance was removed,
 * turned off or retired, or the model is hidden) is left out and `unusableModel` is set, so the thread takes the
 * profile's default instead (when that one can be used).
 */
export function rememberedChoiceFor(
  connection: Caller,
  project: Project | undefined,
  usable: (model: ModelOverride) => ModelOverride
): NewThreadChoice & { unusableModel?: true } {
  const local = connection?.clientType === 'gui' || connection?.clientType === 'cli'
  const choice = local && !connection?.bridgeCaller ? project?.newThread : undefined
  if (!choice) return {}
  let model: ModelOverride | undefined
  if (choice.model) {
    try {
      model = usable(choice.model)
    } catch {
      model = undefined
    }
  }
  return {
    ...(model ? { model } : choice.model ? { unusableModel: true as const } : {}),
    ...(choice.permissionMode ? { permissionMode: choice.permissionMode } : {}),
    ...(typeof choice.worktreeEnabled === 'boolean' ? { worktreeEnabled: choice.worktreeEnabled } : {})
  }
}
