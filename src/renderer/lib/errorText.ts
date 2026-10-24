/** The message of a thrown value, whatever its type. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * A failure's own first line, without the IPC transport prefix or an `Error:` label.
 * Empty when the failure carries no message.
 */
export function ipcErrorLine(error: unknown): string {
  const stripped = errorText(error)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:Error|GitError):\s*/i, '')
  return stripped.split('\n').map((part) => part.trim()).find(Boolean) ?? ''
}
