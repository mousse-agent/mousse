// A run in the ordinary thread view: the same chat shell Chats uses, fed the run's static messages, under a slim
// strip with the run's level, its PR and the calibration buttons. Mock: nothing is sent anywhere.
import { useMemo } from 'react'
import { MousseAgentChatShell } from '../../../chat/components/MousseAgentChatShell'
import { mousseToUIMessages } from '../../../chat/adapters/mousseToUI'
import { ArrowUp, Bell, Check, ExternalLink, GitMerge, Undo2, VolumeHigh } from '../../../lib/icons'
import { mockRunMessages, type MockRun } from './data'
import { automationOf, groupOf } from './inboxModel'
import { AssigneeChip, LEVEL_VIEW, PrChip, RunIcon } from './RunParts'
import { calibrate, resolveRun, undoResolve, useInboxMock } from './store'

const noop = () => undefined

export function RunThread({ run }: { run: MockRun }) {
  const resolved = useInboxMock((s) => s.resolved)
  const calibrated = useInboxMock((s) => s.calibrated)
  const automation = automationOf(run.automationId)
  const messages = useMemo(() => mousseToUIMessages(mockRunMessages(run)), [run])
  const isResolved = resolved.includes(run.id)
  const queue = groupOf(run, resolved) === 'needs_you' || isResolved
  const level = run.state === 'done' ? LEVEL_VIEW[run.level] : undefined
  const noisy = calibrated.includes(`${run.id}:noisy`)
  const missed = calibrated.includes(`${run.id}:missed`)
  const live = run.state === 'running'
  return (
    <div className="inbox-thread" data-testid="inbox-thread" data-run-id={run.id}>
      <div className="inbox-strip" data-testid="inbox-strip">
        {run.state !== 'done' && <span className="inbox-strip-state"><RunIcon run={run} automation={automation} /></span>}
        {level && <span className="inbox-level" data-level={isResolved ? 'resolved' : run.level} title={isResolved ? 'Resolved' : level.label}>{isResolved ? <Check size={13} strokeWidth={2} aria-hidden="true" /> : level.icon}<span>{isResolved ? 'Resolved' : level.label}</span></span>}
        {run.assignee && <AssigneeChip name={run.assignee} />}
        {run.pr && (
          <span className="inbox-strip-pr">
            <PrChip pr={run.pr} />
            <button type="button" className="inbox-icon-btn small" title={`Open PR #${run.pr.number}`} aria-label={`Open PR #${run.pr.number}`} onClick={noop}><ExternalLink size={13} strokeWidth={1.8} /></button>
            {run.pr.checks !== 'merged' && (
              <button type="button" className="inbox-icon-btn small" title={run.pr.checks === 'pass' ? `Merge #${run.pr.number}` : `Merge #${run.pr.number} · checks must pass first`} aria-label={`Merge PR #${run.pr.number}`} disabled={run.pr.checks !== 'pass'} onClick={noop}><GitMerge size={13} strokeWidth={1.8} /></button>
            )}
          </span>
        )}
        <span className="inbox-strip-spacer" />
        {automation && !live && (
          <>
            <button type="button" className="inbox-icon-btn small" data-testid="inbox-too-noisy" aria-pressed={noisy} title={noisy ? 'Noted in Tuning · click to take back' : 'Too noisy'} aria-label="Too noisy" onClick={() => calibrate(run.id, automation.id, run.number, 'noisy')}><VolumeHigh size={14} strokeWidth={1.8} /></button>
            <button type="button" className="inbox-icon-btn small" data-testid="inbox-should-tell" aria-pressed={missed} title={missed ? 'Noted in Tuning · click to take back' : 'Should have told me'} aria-label="Should have told me" onClick={() => calibrate(run.id, automation.id, run.number, 'missed')}><Bell size={14} strokeWidth={1.8} /></button>
          </>
        )}
        {queue && !run.assignee && (isResolved
          ? <button type="button" className="inbox-icon-btn small" title="Undo resolve · u" aria-label="Undo resolve" onClick={undoResolve}><Undo2 size={14} strokeWidth={1.8} /></button>
          : <button type="button" className="inbox-resolve-btn" data-testid="inbox-resolve" title="Resolve · e" aria-label="Resolve" onClick={() => resolveRun(run.id)}><Check size={14} strokeWidth={2} /></button>)}
      </div>
      <div className="chat inbox-chat">
        <MousseAgentChatShell
          threadId={null}
          busy={live}
          messages={messages}
          status={live ? 'streaming' : 'ready'}
          onSend={noop}
          onStop={noop}
          composer={<MockComposer />}
        />
      </div>
    </div>
  )
}

/** The thread's composer, inert in the mock. A reply would continue the run in its automation's history. */
function MockComposer() {
  return (
    <div className="chat-input-area">
      <div className="composer">
        <div className="composer-input-wrap">
          <textarea className="composer-input" rows={1} placeholder="Reply" aria-label="Reply to this run" />
        </div>
        <div className="composer-footer">
          <div className="composer-footer-left" />
          <div className="composer-footer-right">
            <button type="button" className="composer-action-btn" title="Send" aria-label="Send message" disabled><ArrowUp size={16} strokeWidth={2} /></button>
          </div>
        </div>
      </div>
    </div>
  )
}
