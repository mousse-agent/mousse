import { useCallback, useEffect, useMemo, useState } from 'react'
import type { SecretEntryView } from '../../../shared/secretRequests'
import { createSecretsClient } from '../../services/secretsClient'
import { Lock } from '../../lib/icons'
import { ConfirmRemoveButton } from './IconButtons'
import { MoreDetails, SettingsGroup, SettingsRow } from './SettingsRow'

export const SECRETS_HELP =
  "An agent that needs a key, token or password asks for it with a private card in its thread. What you type there goes to Mousse's secret store on this computer, never into the conversation. The agent gets its name and a private file holding it, which only threads you gave it to can read: it uses the value in its commands, settings and logins, and never shows it in the chat (any output that holds it is masked). ${secret:NAME} reads it in an MCP server's settings. Keys you save for automations are listed here too. Removing one here deletes it at once; a thread that used it can no longer."

function when(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** One line on how long it is kept, which thread asked, and when it was last used. */
export function secretEntryLine(entry: SecretEntryView): string {
  const kept = entry.keep === 'key'
    ? 'Saved key'
    : entry.keep === 'saved'
      ? 'Saved'
      : entry.keep === 'thread'
        ? 'This thread only'
        : `Until ${when(entry.expiresAt) ?? 'tomorrow'}`
  const parts = [kept]
  if (entry.threadId) parts.push(`asked for in ${entry.threadTitle ? `“${entry.threadTitle}”` : 'a deleted thread'}`)
  const used = when(entry.lastUsedAt)
  parts.push(used ? `last used ${used}` : 'not used yet')
  return parts.join(' · ')
}

/** Settings → Agents → Secrets (#595): the secrets agents asked for and the saved keys, by name; each can be removed. */
export function SecretsSettings() {
  const client = useMemo(() => createSecretsClient(window.mousse?.platformRequest), [])
  const [entries, setEntries] = useState<SecretEntryView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    client.list().then((next) => setEntries(next), () => setEntries([]))
  }, [client])

  useEffect(() => {
    load()
    const off = window.mousse?.orchestrator?.onSecretsChanged?.(load)
    return () => off?.()
  }, [load])

  const remove = async (name: string) => {
    setError(null)
    try {
      await client.remove(name)
      setEntries((current) => current?.filter((entry) => entry.name !== name) ?? current)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'It could not be removed.')
    }
  }

  return (
    <SettingsGroup
      title="Secrets"
      icon={Lock}
      anchor="agents-secrets"
      description={<>
        Keys, tokens and passwords you gave agents, kept on this computer. Agents use them but never show them in the chat.
        <MoreDetails>{SECRETS_HELP}</MoreDetails>
      </>}
    >
      {entries && entries.length === 0 && <p className="settings-muted">No secrets yet. When an agent needs one, it asks in its thread.</p>}
      {entries?.map((entry) => (
        <SettingsRow
          key={entry.name}
          title={<span className="secret-entry-title"><code>{entry.name}</code>{entry.label ? <span className="secret-entry-label">{entry.label}</span> : null}</span>}
          description={secretEntryLine(entry)}
          control={<ConfirmRemoveButton label={`Remove ${entry.name}`} onRemove={() => void remove(entry.name)} />}
        />
      ))}
      {error ? <p className="agent-job-limit-error" role="alert">{error}</p> : null}
    </SettingsGroup>
  )
}
