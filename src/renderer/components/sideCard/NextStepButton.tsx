import { useRef, useState } from 'react'
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, GitPullRequest, Loader2, Play } from '../../lib/icons'
import type { GitPullStrategy } from '../../../shared/types'
import { CardPopover } from './CardPopover'
import { PULL_STRATEGY_LABELS, type AbortableKind, type NextStep } from './gitSectionLogic'

/** What the button does once pressed; the section runs it under its one-action lock. */
export type NextStepChoice =
  | { kind: 'open-changes' }
  | { kind: 'open-pull-request' }
  | { kind: 'pull'; strategy: GitPullStrategy }
  | { kind: 'push' }
  | { kind: 'abort'; what: AbortableKind }

interface NextStepButtonProps {
  step: NextStep
  /** The step's own action is running: "Pulling…", with Cancel while it can still be stopped. */
  busy: { label: string; onCancel: (() => void) | null } | null
  /** Another Git action runs, so this one waits; the reason is the tooltip. */
  blockedReason: string | null
  onChoose: (choice: NextStepChoice) => void
}

const ICONS = {
  resolve: AlertTriangle,
  finish: Play,
  pull: ArrowDown,
  push: ArrowUp,
  'pull-request': GitPullRequest
} as const

interface MenuItem {
  label: string
  choice: NextStepChoice
}

/** The other ways the step can go, behind ▾: how to join diverged branches, or giving up a stopped merge or rebase. */
function menuItems(step: NextStep): MenuItem[] {
  if (step.kind === 'pull' && step.strategies.length > 1) {
    return step.strategies.map((strategy) => ({ label: PULL_STRATEGY_LABELS[strategy], choice: { kind: 'pull', strategy } }))
  }
  if ((step.kind === 'resolve' || step.kind === 'finish') && step.abort) {
    return [{ label: `Abort ${step.abort}`, choice: { kind: 'abort', what: step.abort } }]
  }
  return []
}

/** What pressing the step itself does. Diverged branches have no default: the press opens the menu. */
function mainChoice(step: NextStep): NextStepChoice | null {
  switch (step.kind) {
    case 'resolve':
    case 'finish':
      return { kind: 'open-changes' }
    case 'pull':
      return step.strategies.length === 1 ? { kind: 'pull', strategy: step.strategies[0] } : null
    case 'push':
      return { kind: 'push' }
    case 'pull-request':
      return { kind: 'open-pull-request' }
  }
}

/**
 * The one thing to do next, as the card's only tinted control: Pull when the remote has new commits, Push, Open
 * pull request, or a warning-toned Resolve or Finish while Git is stopped part way. The ▾ beside it holds the
 * other ways the step can go. While its action runs it shows progress, and Cancel while that can still stop it.
 */
export function NextStepButton({ step, busy, blockedReason, onChoose }: NextStepButtonProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const groupRef = useRef<HTMLDivElement>(null)
  const items = menuItems(step)
  const main = mainChoice(step)
  const Icon = ICONS[step.kind]
  const tone = step.kind === 'resolve' || step.kind === 'finish' ? 'warn' : 'accent'
  const blocked = blockedReason !== null

  if (busy) {
    return (
      <div className="side-card-git-next" data-tone="busy">
        <span className="side-card-git-next-main" role="status">
          <Loader2 className="side-card-git-next-spin" size={13} aria-hidden="true" />
          <span className="side-card-git-next-label">{busy.label}</span>
        </span>
        {busy.onCancel && (
          <button type="button" className="side-card-git-next-side" onClick={busy.onCancel}>
            Cancel
          </button>
        )}
      </div>
    )
  }

  const choose = (choice: NextStepChoice) => {
    setMenuOpen(false)
    onChoose(choice)
  }

  return (
    <>
      <div ref={groupRef} className="side-card-git-next" data-tone={tone}>
        <button
          type="button"
          className="side-card-git-next-main"
          title={blockedReason ?? step.title}
          aria-disabled={blocked || undefined}
          aria-haspopup={main ? undefined : 'menu'}
          aria-expanded={main ? undefined : menuOpen}
          onClick={() => {
            if (blocked) return
            if (main) onChoose(main)
            else setMenuOpen((open) => !open)
          }}
        >
          <Icon size={13} strokeWidth={2} aria-hidden="true" />
          <span className="side-card-git-next-label">{step.label}</span>
        </button>
        {items.length > 0 && (
          <button
            type="button"
            className="side-card-git-next-split"
            title={blockedReason ?? 'More ways'}
            aria-label={`More ways to ${step.label.toLowerCase()}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-disabled={blocked || undefined}
            onClick={() => { if (!blocked) setMenuOpen((open) => !open) }}
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      <CardPopover open={menuOpen && items.length > 0} anchorRef={groupRef} placement="below-start" label={step.label} onClose={() => setMenuOpen(false)}>
        <div className="side-card-git-next-menu" role="menu" aria-label={step.label}>
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className="side-card-git-next-item" onClick={() => choose(item.choice)}>
              {item.label}
            </button>
          ))}
        </div>
      </CardPopover>
    </>
  )
}
