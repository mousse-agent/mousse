/**
 * Saved keys (#595, the automation part): an automation names secrets kept in the profile's secret store, and a run
 * that needs one that is not there ends Incomplete with "Add key <name>". The value is typed into a masked field and
 * sent once to the daemon; it is never part of a job, a prompt, a thread or a log. A key's name is how a tool's
 * settings refer to it (`${secret:NAME}`).
 */

/** A key's name: an environment-variable-style word, so it reads the same in a tool's settings. */
export const KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
/** The most one key's value may hold, in UTF-8 bytes. */
export const MAX_KEY_VALUE_BYTES = 16 * 1024
/** The most keys one automation may name. */
export const MAX_KEYS_PER_AUTOMATION = 20

export function isKeyName(value: unknown): value is string {
  return typeof value === 'string' && KEY_NAME.test(value)
}

/** A typed name made a key's name ("github token" → GITHUB_TOKEN), or null when it cannot be one. */
export function keyNameOf(text: string): string | null {
  const name = text.trim().toUpperCase().replace(/[\s.-]+/g, '_')
  return isKeyName(name) ? name : null
}

/** What a run that stopped at a missing key says, and what Needs you offers. */
export function missingKeyText(name: string): string {
  return `Add key ${name}`
}
