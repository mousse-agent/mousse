// Small pieces the inbox mock-up shares: the run's icon (its state, else its trigger), the PR chip and the computer chip.
import type { ReactNode } from 'react'
import {
  Bot, Check, CircleAlert, CircleCheck, CircleDotDashed, CircleX, Clock, Eye, GitMerge, GitPullRequest, Info, Laptop,
  Loader2, MessageQuestion, Monitor, Pause, Play, Webhook, X
} from '../../../lib/icons'
import { MOCK_COMPUTERS, type MockAutomation, type MockPullRequest, type MockRun, type RunLevel, type TriggerKind } from './data'

export function TriggerIcon({ kind, size = 14 }: { kind: TriggerKind; size?: number }) {
  const Icon = kind === 'event' ? GitPullRequest : kind === 'request' ? Webhook : kind === 'manual' ? Play : Clock
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />
}

/** A run's leading icon: its state while it is not simply done, else its automation's trigger. */
export function RunIcon({ run, automation, resolved }: { run: MockRun; automation?: MockAutomation; resolved?: boolean }) {
  const [icon, title, tone]: [ReactNode, string, string] =
    resolved ? [<CircleCheck key="i" size={15} strokeWidth={1.8} />, 'Resolved', 'done']
      : run.state === 'running' ? [<Loader2 key="i" size={15} strokeWidth={1.8} className="inbox-spin" />, 'Running', 'running']
        : run.state === 'waiting_computer' ? [<Monitor key="i" size={15} strokeWidth={1.8} />, `Waiting for ${run.computer}`, 'waiting']
          : run.state === 'paused_usage' ? [<Pause key="i" size={15} strokeWidth={1.8} />, 'Paused for usage', 'paused']
            : run.state === 'failed' ? [<CircleX key="i" size={15} strokeWidth={1.8} />, 'Failed', 'failed']
              : run.level === 'none' ? [<MessageQuestion key="i" size={15} strokeWidth={1.8} />, 'No report', 'none']
                : [<TriggerIcon key="i" kind={automation?.trigger.kind ?? 'schedule'} size={15} />, automation?.trigger.text ?? '', 'trigger']
  return <span className="inbox-run-icon" data-tone={tone} title={title} role="img" aria-label={title}>{icon}</span>
}

const CHECKS: Record<MockPullRequest['checks'], { title: string; icon: ReactNode }> = {
  pass: { title: 'checks pass', icon: <Check size={11} strokeWidth={2.4} /> },
  fail: { title: 'checks fail', icon: <X size={11} strokeWidth={2.4} /> },
  pending: { title: 'checks running', icon: <CircleDotDashed size={11} strokeWidth={2} /> },
  merged: { title: 'merged', icon: <GitMerge size={11} strokeWidth={2} /> }
}

export function PrChip({ pr }: { pr: MockPullRequest }) {
  const checks = CHECKS[pr.checks]
  return (
    <span className="inbox-chip inbox-pr-chip" data-checks={pr.checks} title={`PR #${pr.number} · ${checks.title}`}>
      <GitPullRequest size={11} strokeWidth={2} aria-hidden="true" />
      {pr.number}
      <span className="inbox-pr-checks" aria-hidden="true">{checks.icon}</span>
    </span>
  )
}

/** Only when the person has more than one computer. */
export function ComputerChip({ name, iconOnly }: { name: string; iconOnly?: boolean }) {
  if (MOCK_COMPUTERS.length < 2) return null
  const Icon = name === 'Laptop' ? Laptop : Monitor
  return <span className="inbox-chip inbox-computer-chip" title={`On ${name}`} aria-label={`On ${name}`}><Icon size={12} strokeWidth={1.8} aria-hidden="true" />{iconOnly ? null : name}</span>
}

export function AssigneeChip({ name }: { name: string }) {
  return <span className="inbox-chip inbox-assignee-chip" title={`${name} resolves this`}><Bot size={11} strokeWidth={2} aria-hidden="true" />{name}</span>
}

export const LEVEL_VIEW: Record<RunLevel, { label: string; icon: ReactNode }> = {
  needs_you: { label: 'Needs you', icon: <CircleAlert size={13} strokeWidth={2} aria-hidden="true" /> },
  look: { label: 'Worth a look', icon: <Eye size={13} strokeWidth={2} aria-hidden="true" /> },
  fyi: { label: 'FYI', icon: <Info size={13} strokeWidth={2} aria-hidden="true" /> },
  quiet: { label: 'Quiet', icon: <Info size={13} strokeWidth={2} aria-hidden="true" /> },
  none: { label: 'No report', icon: <MessageQuestion size={13} strokeWidth={2} aria-hidden="true" /> }
}
