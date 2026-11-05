import { useId } from 'react'
import type { StatusDescription } from '../../../shared/harness/status'
import type { AddOptionMethod } from '../../../shared/harness/types'
import { SecretRow } from '../settings/SecretRow'
import { SettingsRow } from '../settings/SettingsRow'
import { StatusLine, useAsyncAction } from './parts'

/**
 * The Setup row of a model API: replace the key, sign in again, or the cloud credentials it reuses.
 * Removing the provider lives in the editor header. A pasted key goes through
 * `providers.instances.setSecret` (in the shared secret row); a sign-in or guided key through
 * `providers.instances.signIn`.
 */
export function ApiSetupRow({
  label,
  method,
  guidedKey,
  ambientInstructions,
  status,
  retired,
  onReplaceKey,
  onSignIn
}: {
  label: string
  /** How the entry signs in: its saved credential's kind, else the first method its Add option offers. */
  method?: AddOptionMethod
  /** The key comes from the provider's guided sign-in, not a pasted one. */
  guidedKey?: boolean
  /** Where the environment's cloud credentials come from (`ambient`). */
  ambientInstructions?: readonly string[]
  status: StatusDescription
  /** Its sign-in is going away (the entry has a Move banner): no sign-in or key to set here. */
  retired?: boolean
  /** Blank runs the guided key sign-in. */
  onReplaceKey: (apiKey: string) => Promise<void>
  onSignIn: () => Promise<void>
}) {
  const { busy, error, run } = useAsyncAction()
  const inputId = useId()
  const errorLine = error ? <span className="prov-error">{error}</span> : null
  const statusLine = <StatusLine status={status} />

  if (method === 'ambient') {
    return <SettingsRow title="Cloud credentials" description={errorLine ?? (ambientInstructions?.join(' ') || statusLine)} />
  }

  // A retired entry: its sign-in stays until it moves, nothing runs on it, and there is no signing in to it again.
  if (retired) {
    return <SettingsRow title="Account" description={statusLine} />
  }

  if (method === 'oauth') {
    return (
      <SettingsRow
        title="Account"
        description={errorLine ?? statusLine}
        control={
          <button type="button" className="settings-btn" disabled={busy !== null} onClick={() => void run('signin', onSignIn)}>
            Sign in again
          </button>
        }
      />
    )
  }

  return (
    <SecretRow
      title="API key"
      inputId={`${inputId}-api-key`}
      fieldLabel={`New ${label} API key`}
      placeholder={`New ${label} key`}
      configured
      allowBlank
      description={errorLine ?? statusLine}
      editingHint="Leave blank for guided setup"
      onReplace={guidedKey ? () => onReplaceKey('') : undefined}
      onSave={onReplaceKey}
      busy={busy !== null}
    />
  )
}
