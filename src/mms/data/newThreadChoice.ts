import type { ModelOverride } from '../../shared/providerInstances'
import type { NewThreadChoice, Project, Thread } from '../../shared/types'

/**
 * The "Start new threads in a worktree" setting is gone: each project remembers its own checkout choice
 * (`Project.newThread`), and a project with none takes the global default for new checkouts (`runs.newThreadWorktree`,
 * a new worktree unless set otherwise). A setting that was turned off becomes that default, so projects added later
 * start in their folder too. The stored key is then removed. Writing the default first makes a second run (the key could
 * not be removed) write the same value again, so it is safe at every start.
 */
export function migrateWorktreeDefaultSetting(config: {
  assembleSettings(): { runs?: unknown }
  setRunsKey(key: string, value: unknown): void
  removeRunsKey(key: string): boolean
}): void {
  const runs = config.assembleSettings().runs as Record<string, unknown> | undefined
  if (!runs || !Object.hasOwn(runs, 'worktreeByDefault')) return
  if (runs.worktreeByDefault === false && runs.newThreadWorktree !== false) config.setRunsKey('newThreadWorktree', false)
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
 * What a new thread made in `project` starts with: the project's remembered choice, only for a new chat a window on
 * this computer asks for (`requested`, the `rememberedChoices` option). The CLI, scripts, agents and other computers
 * get nothing from it, so a thread they create never inherits a mode such as Full access without anyone seeing it; they
 * keep the values they pass, or the profile defaults. A remembered model it can no longer use (`usable` throws: its instance was removed,
 * turned off or retired, or the model is hidden) is left out and `unusableModel` is set, so the thread takes the
 * profile's default instead (when that one can be used).
 */
export function rememberedChoiceFor(
  connection: Caller,
  project: Project | undefined,
  requested: boolean,
  usable: (model: ModelOverride) => ModelOverride
): NewThreadChoice & { unusableModel?: true } {
  const fromWindow = connection?.clientType === 'gui' && !connection.bridgeCaller
  const choice = requested && fromWindow ? project?.newThread : undefined
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
