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
  const [inputValid, setInputValid] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const operation = useRef(0)
  const pendingStart = useRef<{ signature: string; requestId: string } | null>(null)
  const profileRef = useRef(profileId)
  const definitionRef = useRef(definitionId)
  const executionRef = useRef(execution)
  const generationRef = useRef(0)
  profileRef.current = profileId
  definitionRef.current = definitionId
  executionRef.current = execution
  useEffect(() => () => { operation.current += 1 }, [])
  useEffect(() => {
    generationRef.current += 1
    return () => {
      generationRef.current += 1
    }
  }, [definitionId, execution, profileId, run?.runId])
  useEffect(() => {
    setInput({})
    setError(null)
    setConnectionError(null)
    setBusy(false); busyRef.current = false; operation.current += 1
    pendingStart.current = null
  }, [definitionId, profileId])
  useEffect(() => {
    if (!execution || !run?.runId) return
    let closed = false
    setConnectionError(null)
    const handle = execution.subscribe({ profileId, runId: run.runId }, (snapshot) => {
      if (closed || snapshot.profileId !== profileRef.current || snapshot.definitionId !== definitionRef.current) return
      setConnectionError(null)
      onRunChange(snapshot)
    }, (cause) => {
      if (!closed) setConnectionError(cause instanceof Error ? cause.message : String(cause))
    })
    return () => { closed = true; handle.unsubscribe() }
  }, [definitionId, execution, onRunChange, profileId, run?.runId])
  const missing = useMemo(() => missingRequiredInputs(manifest.inputSchema, input), [input, manifest.inputSchema])
  const disabledReason =
    readOnlyReason ??
    (draft && !semanticHash ? 'Save the draft before running it.' : null) ??
    (!execution ? 'Execution is not connected.' : missing.length ? `Required inputs: ${missing.join(', ')}` : null)
    ?? (!inputValid ? 'Correct the input JSON before running.' : null)

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

  const runAction = (action: () => Promise<WorkflowRunView>, onSuccess?: () => void) => {
    if (!execution || busyRef.current) return
    busyRef.current = true; setBusy(true)
    const ticket = ++operation.current
    const started = { generation: generationRef.current, profileId, definitionId, execution }
    setError(null)
    void action()
      .then((next) => {
        if (isCurrent(started)) { onSuccess?.(); onRunChange(next) }
      })
      .catch((caught: unknown) => {
        if (isCurrent(started)) setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => { if (operation.current === ticket) { busyRef.current = false; setBusy(false) } })
  }

  const voidAction = (action: () => Promise<void>, onApplied?: () => void) => {
    if (!execution || busyRef.current) return
    busyRef.current = true; setBusy(true)
    const ticket = ++operation.current
    const started = { generation: generationRef.current, profileId, definitionId, execution }
    setError(null)
    void action()
      .then(() => {
        if (isCurrent(started)) onApplied?.()
      })
      .catch((caught: unknown) => {
        if (isCurrent(started)) setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => { if (operation.current === ticket) { busyRef.current = false; setBusy(false) } })
  }

  const start = () => {
    if (!execution || disabledReason) return
    const request: WorkflowStartRequest = draft
      ? { profileId, definitionId, draft: true, expectedDraftSemanticHash: semanticHash!, input }
      : { profileId, definitionId, draft: false, revisionId, input }
    const signature = JSON.stringify(request)
    if (pendingStart.current?.signature !== signature) pendingStart.current = { signature, requestId: crypto.randomUUID() }
    const requestId = pendingStart.current.requestId
    runAction(() => execution.start({ ...request, requestId }), () => {
      if (pendingStart.current?.requestId === requestId) pendingStart.current = null
    })
  }

  return (
    <section className="wf-run" data-run-panel="" aria-label="Run and debug" aria-busy={busy}>
      <h2>{draft ? 'Run draft' : 'Run'}</h2>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <SchemaInputForm schema={manifest.inputSchema} value={input} onChange={setInput} onValidityChange={setInputValid} disabled={Boolean(readOnlyReason)} />
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
      {connectionError ? <p className="wf-field-error" role="alert">Run updates are unavailable: {connectionError}</p> : null}
      {run ? <RunTrace run={run} execution={execution} profileId={profileId} runAction={runAction} /> : null}
      </fieldset>
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
  const cancellable = !['succeeded', 'failed', 'cancelled', 'cancelling'].includes(run.state)
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
        disabled={!cancellable}
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
      {run.truncated?.events ? <p className="wf-status">Showing the latest {run.events.length} of {run.counts?.events} events.</p> : null}
      <ol data-run-events="">
        {run.events.map((event) => (
          <li key={event.seq}>
            {event.at} {event.kind}
            {event.nodeId ? ` · ${event.nodeId}` : ''} — {event.message}
          </li>
        ))}
      </ol>
      <h3>Node attempts</h3>
      {run.truncated?.attempts ? <p className="wf-status">Showing the latest {run.attempts.length} of {run.counts?.attempts} node instances.</p> : null}
      <ul data-run-attempts="">
        {run.attempts.map((attempt) => (
          <li key={attempt.instanceKey}>
            {attempt.nodeId} #{attempt.attempt} {attempt.outcome}
            {attempt.error ? ` — ${attempt.error}` : ''}
          </li>
        ))}
      </ul>
      <h3>Output</h3>
      {run.truncated?.result ? <p className="wf-status">This is a shortened output preview. The complete result is preserved with the run.</p> : null}
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
  const [answer, setAnswer] = useState<unknown>('')
  const [valid, setValid] = useState(true)
  const schema = run.pendingInput?.schema
  const textAnswer = !schema || schema.type === 'string'
  useEffect(() => { setAnswer(textAnswer ? '' : {}); setValid(true) }, [run.pendingInput?.instanceKey, run.runId, textAnswer])
  if (!run.pendingInput) return null
  if (!execution?.answer) return <p>Ask-user answers are not provided by the host execution port.</p>
  return (
    <div className="wf-banner" data-ask-user="">
      <p>{run.pendingInput.prompt}</p>
      {textAnswer ? <textarea aria-label="Answer" value={typeof answer === 'string' ? answer : ''} onChange={(event) => setAnswer(event.target.value)} /> :
        <SchemaInputForm key={run.pendingInput.instanceKey} idPrefix="answer" schema={schema!} value={answer} onChange={setAnswer} onValidityChange={setValid} />}
      <button
        type="button"
        className="btn btn-primary"
        data-action="answer-run"
        disabled={!valid || Boolean(schema && missingRequiredInputs(schema, answer).length)}
        onClick={() =>
          runAction(() => execution.answer!({
            profileId,
            runId: run.runId,
            nodeId: run.pendingInput!.nodeId,
            instanceKey: run.pendingInput!.instanceKey,
            data: answer
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
