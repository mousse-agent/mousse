/** A delay from the environment variable `name` in milliseconds, or `fallback` when it is unset or not a positive number. */
export function idleCloseFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * How long a completed delegated child thread keeps its idle process or loaded Codex thread before release,
 * preserving its saved conversation for follow-ups (`continue_subagent`). `MOUSSE_DELEGATE_IDLE_CLOSE_MS` sets it.
 */
export const DELEGATE_IDLE_CLOSE_MS = idleCloseFromEnv('MOUSSE_DELEGATE_IDLE_CLOSE_MS', 2 * 60_000)
