/** A delay from the environment variable `name` in milliseconds, or `fallback` when it is unset or not a positive number. */
export function idleCloseFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}
