import { useMemo, useRef, useState } from 'react'
import type { WorkflowManifest } from '../../../shared/workflows'
import {
  WORKFLOW_RUN_STATE_LABELS,
  type WorkflowExecutionClient,
  type WorkflowPendingApproval,
  type WorkflowRunView
} from './client'
import { missingRequiredInputs, SchemaInputForm } from './SchemaInputForm'

export function WorkflowRunPanel({
  profileId,
  definitionId,
  manifest,
  semanticHash,
  revisionId,
  execution,
  run,
  draft,
  readOnlyReason,
  onRunChange
}: {
  profileId: string
  definitionId: string
  manifest: WorkflowManifest
  semanticHash?: string
  revisionId?: string
  execution?: WorkflowExecutionClient
  run: WorkflowRunView | null
  draft?: boolean
  readOnlyReason?: string
  onRunChange: (run: WorkflowRunView | null) => void
}) {
  const [input, setInput] = useState<unknown>({})
  const [error, setError] = useState<string | null>(null)
  const profileRef = useRef(profileId)
  profileRef.current = profileId
  const missing = useMemo(() => missingRequiredInputs(manifest.inputSchema, input), [input, manifest.inputSchema])
  const disabledReason =
    readOnlyReason ??
    (!execution ? 'Execution is not connected.' : missing.length ? `Required inputs: ${missing.join(', ')}` : null)

  const start = async () => {
    if (!execution || disabledReason) return
    setError(null)
    try {
      const startedProfile = profileId
      const started = await execution.start({
        profileId,
        definitionId,
        draft,
        input,
        revisionId: draft ? undefined : revisionId
      })
      if (profileRef.current !== startedProfile) return
      onRunChange(started)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <section className="wf-run" data-run-panel="" aria-label="Run and debug">
      <h2>{draft ? 'Run draft' : 'Run'}</h2>
      <SchemaInputForm schema={manifest.inputSchema} value={input} onChange={setInput} disabled={Boolean(disabledReason)} />
      <div className="wf-inline">
        <button
          type="button"
          className="btn btn-primary"
          data-action="start-run"
          disabled={Boolean(disabledReason)}
          title={disabledReason ?? undefined}
          onClick={() => void start()}
        >
          {draft ? 'Run draft' : 'Run'}
        </button>
        <RunControls
          execution={execution}
          profileId={profileId}
          definitionId={definitionId}
          revisionId={revisionId}
          semanticHash={semanticHash}
          draft={draft}
          input={input}
          run={run}
          onRunChange={onRunChange}
        />
      </div>
      {disabledReason ? (
        <p className="wf-status" data-run-disabled-reason="">
          {disabledReason}
        </p>
      ) : null}
      {error ? (
        <p className="wf-field-error" role="alert">
          {error}
        </p>
      ) : null}
      {run ? <RunTrace run={run} execution={execution} profileId={profileId} onRunChange={onRunChange} /> : null}
    </section>
  )
}

function RunControls({
  execution,
  profileId,
  definitionId,
  revisionId,
  semanticHash,
  draft,
  input,
  run,
  onRunChange
}: {
  execution?: WorkflowExecutionClient
  profileId: string
  definitionId: string
  revisionId?: string
  semanticHash?: string
  draft?: boolean
  input: unknown
  run: WorkflowRunView | null
  onRunChange: (run: WorkflowRunView) => void
}) {
  const [breakpointEnabled, setBreakpointEnabled] = useState(false)
  if (!run || !execution) return null
  const busy = run.state === 'running' || run.state === 'queued' || run.state === 'waiting-approval' || run.state === 'waiting-input'
  const breakpointNodeId = run.currentNodeId ?? run.attempts[run.attempts.length - 1]?.nodeId
  const startRequest = {
    profileId,
    definitionId,
    revisionId: draft ? undefined : revisionId,
    draft,
    input
  }
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        data-action="pause-run"
        disabled={!execution.pause || run.state !== 'running'}
        title={execution.pause ? undefined : 'Pause is not provided by the host execution port.'}
        onClick={() => execution.pause && void execution.pause({ profileId, runId: run.runId }).then(onRunChange)}
      >
        Pause
      </button>
      <button
        type="button"
        className="btn btn-sm"
        data-action="resume-run"
        disabled={!execution.resume || (run.state !== 'interrupted' && run.state !== 'waiting-condition')}
        title={execution.resume ? undefined : 'Resume is not provided by the host execution port.'}
        onClick={() => execution.resume && void execution.resume({ profileId, runId: run.runId }).then(onRunChange)}
      >
        Resume
      </button>
      <button
        type="button"
        className="btn btn-sm"
        data-action="cancel-run"
        disabled={!busy}
        onClick={() => void execution.cancel({ profileId, runId: run.runId, reason: 'user' }).then(onRunChange)}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-sm"
        data-action="dry-run"
        disabled={!execution.dryRun}
        title={execution.dryRun ? undefined : 'Dry run is not provided by the host execution port.'}
        onClick={() => execution.dryRun && void execution.dryRun(startRequest).then(onRunChange)}
      >
        Dry run
      </button>
      <button
        type="button"
        className="btn btn-sm"
        data-action="breakpoint"
        disabled={!execution.setBreakpoint || !breakpointNodeId}
        title={execution.setBreakpoint ? undefined : 'Breakpoints are not provided by the host execution port.'}
        onClick={() => {
          if (!execution.setBreakpoint || !breakpointNodeId) return
          const enabled = !breakpointEnabled
          setBreakpointEnabled(enabled)
          void execution.setBreakpoint({ profileId, runId: run.runId, nodeId: breakpointNodeId, enabled })
        }}
      >
        {breakpointEnabled ? 'Clear breakpoint' : 'Breakpoint'}
      </button>
    </>
  )
}

function RunTrace({
  run,
  execution,
  profileId,
  onRunChange
}: {
  run: WorkflowRunView
  execution?: WorkflowExecutionClient
  profileId: string
  onRunChange: (run: WorkflowRunView) => void
}) {
  return (
    <div data-run-id={run.runId} data-run-origin={run.origin} data-run-state={run.state}>
      <p className="wf-run-state" data-state={run.state}>
        {WORKFLOW_RUN_STATE_LABELS[run.state]}
        {run.origin === 'fixture' ? ' · Fixture result (no live model or script)' : ''}
      </p>
      {run.error ? <p className="wf-field-error">{run.error}</p> : null}
      <h3>Timeline</h3>
      <ol data-run-events="">
        {run.events.map((event) => (
          <li key={event.seq}>
            {event.at} {event.kind}
            {event.nodeId ? ` · ${event.nodeId}` : ''} — {event.message}
          </li>
        ))}
      </ol>
      <h3>Node attempts</h3>
      <ul data-run-attempts="">
        {run.attempts.map((attempt) => (
          <li key={attempt.instanceKey}>
            {attempt.nodeId} #{attempt.attempt} {attempt.outcome}
            {attempt.error ? ` — ${attempt.error}` : ''}
          </li>
        ))}
      </ul>
      <h3>Output</h3>
      <pre data-run-output="">{JSON.stringify(run.result ?? {}, null, 2)}</pre>
      {run.artifacts.length > 0 ? (
        <>
          <h3>Artifacts</h3>
          <ul>
            {run.artifacts.map((artifact) => (
              <li key={artifact.id}>
                {artifact.displayName} ({artifact.mediaType}, {artifact.byteLength} bytes)
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {run.unknownEffect ? (
        <UnknownEffectForm run={run} execution={execution} profileId={profileId} onRunChange={onRunChange} />
      ) : null}
      {run.pendingApproval ? (
        <ApprovalForm approval={run.pendingApproval} execution={execution} profileId={profileId} onRunChange={onRunChange} />
      ) : null}
      {run.pendingInput ? (
        <AskUserForm run={run} execution={execution} profileId={profileId} onRunChange={onRunChange} />
      ) : null}
    </div>
  )
}

function ApprovalForm({
  approval,
  execution,
  profileId,
  onRunChange
}: {
  approval: WorkflowPendingApproval
  execution?: WorkflowExecutionClient
  profileId: string
  onRunChange: (run: WorkflowRunView) => void
}) {
  if (!execution?.approve) {
    return <p data-approval-disabled="">Approvals are not provided by the host execution port.</p>
  }
  const decide = (approved: boolean) =>
    void execution.approve!({
      profileId,
      runId: approval.runId,
      approvalId: approval.approvalId,
      nodeId: approval.nodeId,
      instanceKey: approval.instanceKey,
      attempt: approval.attempt,
      approved
    }).then(onRunChange)
  return (
    <div className="wf-banner" data-approval="" data-approval-id={approval.approvalId}>
      <p>
        Approval {approval.approvalId} for run {approval.runId}, node {approval.nodeId}, attempt {approval.attempt}.
      </p>
      <p>{approval.description}</p>
      <button type="button" className="btn btn-primary" data-action="approve-run" onClick={() => decide(true)}>
        Approve
      </button>
      <button type="button" className="btn" data-action="deny-run" onClick={() => decide(false)}>
        Deny
      </button>
    </div>
  )
}

function AskUserForm({
  run,
  execution,
  profileId,
  onRunChange
}: {
  run: WorkflowRunView
  execution?: WorkflowExecutionClient
  profileId: string
  onRunChange: (run: WorkflowRunView) => void
}) {
  const [text, setText] = useState('')
  if (!run.pendingInput) return null
  if (!execution?.answer) return <p>Ask-user answers are not provided by the host execution port.</p>
  return (
    <div className="wf-banner" data-ask-user="">
      <p>{run.pendingInput.prompt}</p>
      <textarea value={text} onChange={(event) => setText(event.target.value)} />
      <button
        type="button"
        className="btn btn-primary"
        data-action="answer-run"
        onClick={() =>
          void execution.answer!({
            profileId,
            runId: run.runId,
            nodeId: run.pendingInput!.nodeId,
            instanceKey: run.pendingInput!.instanceKey,
            data: text
          }).then(onRunChange)
        }
      >
        Send answer
      </button>
    </div>
  )
}

function UnknownEffectForm({
  run,
  execution,
  profileId,
  onRunChange
}: {
  run: WorkflowRunView
  execution?: WorkflowExecutionClient
  profileId: string
  onRunChange: (run: WorkflowRunView) => void
}) {
  if (!run.unknownEffect) return null
  if (!execution?.reconcile) {
    return (
      <p data-unknown-effect="">
        Unknown effect on {run.unknownEffect.nodeId} attempt {run.unknownEffect.attempt}. Reconciliation is not provided by
        the host.
      </p>
    )
  }
  return (
    <div className="wf-banner wf-banner--error" data-unknown-effect="">
      <p>
        Unknown effect: {run.unknownEffect.description}. This is not treated as success. Choose how to reconcile before
        retrying.
      </p>
      <button
        type="button"
        className="btn"
        onClick={() =>
          void execution.reconcile!({
            profileId,
            runId: run.runId,
            nodeId: run.unknownEffect!.nodeId,
            instanceKey: run.unknownEffect!.instanceKey,
            attempt: run.unknownEffect!.attempt,
            decision: 'fail'
          }).then(onRunChange)
        }
      >
        Mark failed
      </button>
    </div>
  )
}
