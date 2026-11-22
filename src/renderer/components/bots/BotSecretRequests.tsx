import { useMemo } from 'react'
import { createSecretsClient } from '../../services/secretsClient'
import { usePendingSecretRequests } from '../../hooks/usePendingSecretRequests'
import { SecretRequestCard } from '../secrets/SecretRequestCard'

/**
 * The private cards a bot's `secret_request` opened ("use secrets you give it"): filed under its chat thread whichever
 * of its turns asked, and shown above its composer, where the owner types the secret or picks a saved one. The value
 * goes only to this computer's daemon; the bot gets its name.
 */
export function BotSecretRequests({ homeThreadId, botName }: { homeThreadId: string | undefined; botName?: string }) {
  const client = useMemo(() => createSecretsClient(window.mousse?.platformRequest), [])
  const { requests, refresh } = usePendingSecretRequests(homeThreadId, client)
  if (!requests.length) return null
  return <div className="bot-secret-requests">
    {requests.map((request) => <SecretRequestCard
      key={request.requestId}
      request={request}
      botName={botName}
      onSave={async (value, keep) => { await client.answer(request.threadId, request.requestId, value, keep); refresh() }}
      onUseSaved={async () => { await client.useSaved(request.threadId, request.requestId); refresh() }}
      onDecline={async () => { await client.decline(request.threadId, request.requestId); refresh() }}
    />)}
  </div>
}
