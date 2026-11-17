import { createContext, useContext } from 'react'
import type { UIMessage } from 'ai'
import type { SecretKeep, SecretRequestView } from '../../../shared/secretRequests'
import { SecretRequestCard } from './SecretRequestCard'

/** A secret request waiting in the transcript (#595): the form sits in the turn that asked, after what it said. */
export const SECRET_REQUEST_PART = 'data-secret-request'

export function isSecretRequestPart(part: unknown): part is { type: typeof SECRET_REQUEST_PART; data: SecretRequestView } {
  return Boolean(part && typeof part === 'object' && (part as { type?: unknown }).type === SECRET_REQUEST_PART && (part as { data?: unknown }).data)
}

/** Whether the message is a secret request still waiting for the person. */
export function isWaitingSecretRequest(message: UIMessage | undefined): boolean {
  return isSecretRequestPart(message?.parts?.[0])
}

/**
 * The transcript with the thread's open secret requests at its end: each is being asked now, in the turn that is
 * waiting for it. The part holds the request as the card shows it, never a value.
 */
export function withSecretRequests(messages: UIMessage[], requests: readonly SecretRequestView[]): UIMessage[] {
  if (requests.length === 0) return messages
  return [
    ...messages,
    ...requests.map((request) => ({
      id: `secret:${request.requestId}`,
      role: 'assistant',
      createdAt: request.createdAt,
      parts: [{ type: SECRET_REQUEST_PART, data: request }]
    }) as unknown as UIMessage)
  ]
}

/** What answering a request in the transcript does; the chat that shows the thread provides it. */
export interface SecretRequestActions {
  save(request: SecretRequestView, value: string, keep: SecretKeep): Promise<void>
  useSaved(request: SecretRequestView): Promise<void>
  decline(request: SecretRequestView): Promise<void>
}

export const SecretRequestActionsContext = createContext<SecretRequestActions | null>(null)

/** The form in the transcript; without a chat that can answer it (a read-only view), nothing. */
export function SecretRequestInline({ request }: { request: SecretRequestView }) {
  const actions = useContext(SecretRequestActionsContext)
  if (!actions) return null
  return (
    <SecretRequestCard
      inline
      request={request}
      onSave={(value, keep) => actions.save(request, value, keep)}
      onUseSaved={() => actions.useSaved(request)}
      onDecline={() => actions.decline(request)}
    />
  )
}
