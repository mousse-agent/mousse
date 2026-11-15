import type { CustomToolRendererProps } from '../../chat/components/agent-elements/types'
import { useAppStore } from '../../stores/appStore'
import { useProjectComputerName } from '../../hooks/useProjectComputerName'
import { Lock } from '../../lib/icons'

/** The name a `secret_request` result says the secret is kept under; the result never holds the value. */
export function secretNameFromResult(output: unknown): string | undefined {
  const text = typeof output === 'string' ? output : Array.isArray(output) ? output.map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : String(part))).join(' ') : ''
  return /kept by Mousse as ([A-Z][A-Z0-9_]{0,63})\b/.exec(text)?.[1]
}

/**
 * A `secret_request` in the transcript (#595). While it waits, it says where to answer: the card above the composer on
 * the computer that runs the thread. A thread another computer runs shows no card here, so the row names that computer.
 */
export function SecretRequestRow({ input, output, status }: CustomToolRendererProps) {
  const projectId = useAppStore((state) => state.threads.find((thread) => thread.id === state.activeThreadId)?.projectId ?? null)
  const computer = useProjectComputerName(projectId)
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : 'a secret'
  const waiting = status === 'pending' || status === 'streaming'
  const name = secretNameFromResult(output)
  const line = waiting
    ? computer ? `Answer on ${computer}: the secret is typed and kept on the computer that runs this thread.` : 'Waiting for you: enter it in the card above the message box.'
    : status === 'success' && name ? `Given. The agent uses it by name: ${name}.` : 'Not given. Nothing was stored.'
  return (
    <p className="secret-request-row" data-testid="secret-request-row" role="status">
      <Lock size={13} aria-hidden="true" />
      <span className="secret-request-row-label">Asked for {label}</span>
      <span className="secret-request-row-line">{line}</span>
    </p>
  )
}
