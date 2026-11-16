import { maskedCopy, type SecretMasker } from '../../../secrets/secretMasking'

/**
 * A tool's result with the thread's secrets hidden, as Mousse's `PostToolUse` hook hands it back to Claude Code
 * (`updatedToolOutput`). Claude Code runs its own tools (reading a file, a shell command) and keeps their results in
 * its own session file; the hook replaces a result before the model sees it and before it is saved, so a secret the
 * agent opened never reaches the model or that file. Undefined when there is nothing to hide.
 */
export function claudeMaskedToolOutput(response: unknown, mask: SecretMasker | undefined): unknown | undefined {
  if (!mask || response === undefined || response === null) return undefined
  if (typeof response === 'string') {
    const masked = mask(response)
    return masked === response ? undefined : masked
  }
  const copy = maskedCopy(response, mask)
  return copy === response ? undefined : copy
}
