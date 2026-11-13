import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The folders and files Mousse keeps in the system's temporary folders `temps`, as they are now: every entry named
 * `mousse-…` (the ChatGPT token broker's socket folder; for the seconds a task runs, a pull request's text, the paths the
 * owner stages, Git's trace of their hooks, an ACP agent's check). A bot's sandbox closes them by name, read when its
 * turn starts: a pattern can't stand for them, since Codex's Linux sandbox lists a whole folder to expand one and
 * refuses every command when any folder in it can't be read, as some in `/tmp` never can.
 */
export function mousseTempEntries(temps: readonly string[]): string[] {
  const entries: string[] = []
  for (const temp of new Set(temps)) {
    let names: string[]
    try {
      names = readdirSync(temp)
    } catch {
      continue
    }
    for (const name of names) if (name.startsWith('mousse-')) entries.push(join(temp, name))
  }
  return entries
}
