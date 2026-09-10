import { useState } from 'react'
import type { AgentDefinitionsClient, AgentTryRunResult } from './client'
import { isAgentDefinitionClientError } from './client'

export function TryRunPanel({
  profileId,
  id,
  expectedDraftHash,
  client,
  disabled,
  disabledReason
}: {
  profileId: string
  id: string
  expectedDraftHash: string
  client: AgentDefinitionsClient
  disabled?: boolean
  disabledReason?: string
}) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AgentTryRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const next = await client.tryRun({ profileId, id, expectedDraftHash, prompt })
      setResult(next)
    } catch (caught) {
      setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="agent-try-run" aria-label="Try this agent">
      <h3>Try a prompt</h3>
      {disabledReason ? <p className="agent-setting-disabled">{disabledReason}</p> : null}
      <textarea
        rows={4}
        value={prompt}
        data-field="try-run-prompt"
        disabled={disabled || busy}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="A one-off test prompt. This uses the injected runtime port; it is not a fake executor."
      />
      <button
        type="button"
        className="btn btn-primary btn-sm"
        data-action="try-run"
        disabled={disabled || busy || !prompt.trim()}
        onClick={() => void run()}
      >
        {busy ? 'Running…' : 'Try run'}
      </button>
      {error ? (
        <p className="agent-field-error" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <div data-try-run-status={result.status}>
          <p>
            <strong>{result.status}</strong> — {result.summary}
          </p>
          <pre>{result.trace.map((entry) => `${entry.at} ${entry.message}`).join('\n')}</pre>
        </div>
      ) : null}
    </section>
  )
}
