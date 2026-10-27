import { useEffect, useRef, useState } from 'react'
import type { PendingUserQuestions } from '../../../shared/types'
import { ComposerQuestionModal } from '../ComposerQuestionModal'
import type { AgentDefinitionsClient, AgentTryRunResult } from './client'
import { isAgentDefinitionClientError } from './client'

/** How often a running Try Run is checked for a question that waits on the person. */
export const TRY_RUN_QUESTION_POLL_MS = 1000

/** The first question a running Try Run waits on, with the hidden thread it was asked on. */
interface WaitingQuestion {
  pending: PendingUserQuestions
  threadTitle: string
}

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
  // A question the run waits on (a shell command's approval where the shell is not contained, an
  // `ask_user`): asked on the run's own "Try Agent" thread, which is not on screen, so it is shown here.
  const [waiting, setWaiting] = useState<WaitingQuestion | null>(null)
  const boundaryRef = useRef({ profileId, id, client })
  boundaryRef.current = { profileId, id, client }

  useEffect(() => {
    setPrompt('')
    setBusy(false)
    setResult(null)
    setError(null)
    setWaiting(null)
  }, [client, id, profileId])

  useEffect(() => {
    if (!busy || !client.tryRunPending) {
      setWaiting(null)
      return
    }
    let stopped = false
    const check = async () => {
      try {
        const { runs } = await client.tryRunPending!({ profileId, id })
        if (stopped) return
        const run = runs.find((entry) => entry.questions.length > 0)
        setWaiting(run ? { pending: run.questions[0]!, threadTitle: run.threadTitle } : null)
      } catch {
        // The next check tries again; the run's own result still arrives.
      }
    }
    void check()
    const timer = setInterval(() => void check(), TRY_RUN_QUESTION_POLL_MS)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [busy, client, id, profileId])

  const respond = async (requestId: string, reply: { answers: Record<string, string | string[]> } | { dismiss: true }) => {
    setWaiting(null)
    try {
      const outcome = await client.tryRunAnswer?.({ profileId, id, requestId, ...reply })
      if (outcome && !outcome.ok) setError('That question was already answered or closed.')
    } catch (caught) {
      setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
    }
  }

  const run = async () => {
    const started = { profileId, id, client }
    const isCurrent = () => {
      const current = boundaryRef.current
      return current.profileId === started.profileId && current.id === started.id && current.client === started.client
    }
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const next = await client.tryRun({ profileId, id, expectedDraftHash, prompt })
      if (isCurrent()) setResult(next)
    } catch (caught) {
      if (isCurrent()) setError(isAgentDefinitionClientError(caught) ? caught.message : String(caught))
    } finally {
      if (isCurrent()) setBusy(false)
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
        placeholder="Describe a task to test this agent."
      />
      <button
        type="button"
        className="btn btn-primary btn-sm"
        data-action="try-run"
        disabled={disabled || busy || !prompt.trim()}
        onClick={() => void run()}
      >
        {busy ? (waiting ? 'Waiting for your answer…' : 'Running…') : 'Try run'}
      </button>
      {busy && waiting ? (
        <div className="agent-try-run-question" data-try-run-waiting="true" role="status">
          <p>
            <strong>Waiting for your answer.</strong> The agent asked in {waiting.threadTitle}; answer here to continue.
          </p>
          <ComposerQuestionModal
            pending={waiting.pending}
            onSubmit={(answers) => void respond(waiting.pending.requestId, { answers })}
            onDismiss={() => void respond(waiting.pending.requestId, { dismiss: true })}
          />
        </div>
      ) : null}
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
