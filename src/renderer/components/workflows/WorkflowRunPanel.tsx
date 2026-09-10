import { useEffect, useMemo, useRef, useState } from 'react'
import type { WorkflowManifest } from '../../../shared/workflows'
import {
  WORKFLOW_RUN_STATE_LABELS,
  type WorkflowExecutionClient,
  type WorkflowPendingApproval,
  type WorkflowRunView,
  type WorkflowStartRequest
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
  const definitionRef = useRef(definitionId)
  const executionRef = useRef(execution)
  const generationRef = useRef(0)
  profileRef.current = profileId
  definitionRef.current = definitionId
  executionRef.current = execution
  useEffect(() => {
    generationRef.current += 1
    return () => {
      generationRef.current += 1
    }
  }, [definitionId, execution, profileId, run?.runId])
  useEffect(() => {
    setInput({})
    setError(null)
  }, [definitionId, profileId])
  const missing = useMemo(() => missingRequiredInputs(manifest.inputSchema, input), [input, manifest.inputSchema])
  const disabledReason =
    readOnlyReason ??
    (draft && !semanticHash ? 'Save the draft before running it.' : null) ??
    (!execution ? 'Execution is not connected.' : missing.length ? `Required inputs: ${missing.join(', ')}` : null)

  const isCurrent = (started: {
    generation: number
    profileId: string
    definitionId: string
    execution: WorkflowExecutionClient
  }) =>
    generationRef.current === started.generation &&
    profileRef.current === started.profileId &&
    definitionRef.current === started.definitionId &&
    executionRef.current === started.execution

  const runAction = (action: () => Promise<WorkflowRunView>) => {
    if (!execution) return
    const started = { generation: generationRef.current, profileId, definitionId, execution }
    setError(null)
    void action()
      .then((next) => {
        if (isCurrent(started)) onRunChange(next)
      })
      .catch((caught: unknown) => {
        if (isCurrent(started)) setError(caught instanceof Error ? caught.message : String(caught))
      })
  }

  const voidAction = (action: () => Promise<void>, onApplied?: () => void) => {
    if (!execution) return
    const started = { generation: generationRef.current, profileId, definitionId, execution }
    setError(null)
    void action()
      .then(() => {
        if (isCurrent(started)) onApplied?.()
      })
      .catch((caught: unknown) => {
        if (isCurrent(started)) setError(caught instanceof Error ? caught.message : String(caught))
      })
  }

  const start = () => {
    if (!execution || disabledReason) return
    const request: WorkflowStartRequest = draft
      ? { profileId, definitionId, draft: true, expectedDraftSemanticHash: semanticHash!, input }
      : { profileId, definitionId, draft: false, revisionId, input }
    runAction(() => execution.start(request))
  }

  return (
    <section className="wf-run" data-run-panel="" aria-label="Run and debug">
      <h2>{draft ? 'Run draft' : 'Run'}</h2>
      <SchemaInputForm schema={manifest.inputSchema} value={input} onChange={setInput} disabled={Boolean(readOnlyReason)} />
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
          runAction={runAction}
          voidAction={voidAction}
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
      {run ? <RunTrace run={run} execution={execution} profileId={profileId} runAction={runAction} /> : null}
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
  runAction,
  voidAction
}: {
  execution?: WorkflowExecutionClient
  profileId: string
  definitionId: string
  revisionId?: string
  semanticHash?: string
  draft?: boolean
  input: unknown
  run: WorkflowRunView | null
  runAction: (action: () => Promise<WorkflowRunView>) => void
  voidAction: (action: () => Promise<void>, onApplied?: () => void) => void
}) {
  const [breakpointEnabled, setBreakpointEnabled] = useState(false)
  useEffect(() => setBreakpointEnabled(false), [run?.runId])
  if (!run || !execution) return null
  const busy = run.state === 'running' || run.state === 'queued' || run.state === 'waiting-approval' || run.state === 'waiting-input'
  const breakpointNodeId = run.currentNodeId ?? run.attempts[run.attempts.length - 1]?.nodeId
  const startRequest: WorkflowStartRequest = draft
    ? { profileId, definitionId, draft: true, expectedDraftSemanticHash: semanticHash!, input }
    : { profileId, definitionId, draft: false, revisionId, input }
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        data-action="pause-run"
        disabled={!execution.pause || run.state !== 'running'}
        title={execution.pause ? undefined : 'Pause is not provided by the host execution port.'}
        onClick={() => execution.pause && runAction(() => execution.pause!({ profileId, runId: run.runId }))}
      >
        Pause
      </button>
      <button
        type="button"
        className="btn btn-sm"
        data-action="resume-run"
        disabled={!execution.resume || (run.state !== 'interrupted' && run.state !== 'waiting-condition')}
        title={execution.resume ? undefined : 'Resume is not provided by the host execution port.'}
        onClick={() => execution.resume && runAction(() => execution.resume!({ profileId, runId: run.runId }))}
      >
        Resume
      </button>
      <button
        type="button"
        className="btn btn-sm"
        data-action="cancel-run"
        disabled={!busy}
        onClick={() => runAction(() => execution.cancel({ profileId, runId: run.runId, reason: 'user' }))}
      >
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-sm"
        data-action="dry-run"
        disabled={!execution.dryRun}
        title={execution.dryRun ? undefined : 'Dry run is not provided by the host execution port.'}
        onClick={() => execution.dryRun && runAction(() => execution.dryRun!(startRequest))}
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
          voidAction(
            () => execution.setBreakpoint!({ profileId, runId: run.runId, nodeId: breakpointNodeId, enabled }),
            () => setBreakpointEnabled(enabled)
          )
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
  runAction
}: {
  run: WorkflowRunView
  execution?: WorkflowExecutionClient
  profileId: string
  runAction: (action: () => Promise<WorkflowRunView>) => void
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
        <UnknownEffectForm run={run} execution={execution} profileId={profileId} runAction={runAction} />
      ) : null}
      {run.pendingApproval ? (
        <ApprovalForm approval={run.pendingApproval} execution={execution} profileId={profileId} runAction={runAction} />
      ) : null}
      {run.pendingInput ? (
        <AskUserForm run={run} execution={execution} profileId={profileId} runAction={runAction} />
      ) : null}
    </div>
  )
}

function ApprovalForm({
  approval,
  execution,
  profileId,
  runAction
}: {
  approval: WorkflowPendingApproval
  execution?: WorkflowExecutionClient
  profileId: string
  runAction: (action: () => Promise<WorkflowRunView>) => void
}) {
  if (!execution?.approve) {
    return <p data-approval-disabled="">Approvals are not provided by the host execution port.</p>
  }
  const decide = (approved: boolean) =>
    runAction(() => execution.approve!({
      profileId,
      runId: approval.runId,
      approvalId: approval.approvalId,
      nodeId: approval.nodeId,
      instanceKey: approval.instanceKey,
      attempt: approval.attempt,
      approved
    }))
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
  runAction
}: {
  run: WorkflowRunView
  execution?: WorkflowExecutionClient
  profileId: string
  runAction: (action: () => Promise<WorkflowRunView>) => void
}) {
  const [text, setText] = useState('')
  useEffect(() => setText(''), [run.pendingInput?.instanceKey, run.runId])
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
          runAction(() => execution.answer!({
            profileId,
            runId: run.runId,
            nodeId: run.pendingInput!.nodeId,
            instanceKey: run.pendingInput!.instanceKey,
            data: text
          }))
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
  runAction
}: {
  run: WorkflowRunView
  execution?: WorkflowExecutionClient
  profileId: string
  runAction: (action: () => Promise<WorkflowRunView>) => void
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
          runAction(() => execution.reconcile!({
            profileId,
            runId: run.runId,
            nodeId: run.unknownEffect!.nodeId,
            instanceKey: run.unknownEffect!.instanceKey,
            attempt: run.unknownEffect!.attempt,
            decision: 'fail'
          }))
        }
      >
        Mark failed
      </button>
    </div>
  )
}
