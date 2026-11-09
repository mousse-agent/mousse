import { useRef, useState, type MouseEvent } from 'react'
import { FloatingPortal } from '../../lib/floatingLayer'
import { AlertTriangle, ArrowDown, ArrowUp, ChevronDown, GitPullRequest, Loader2, Play } from '../../lib/icons'
import type { GitInProgress, GitPullStrategy } from '../../../shared/types'
import { PULL_STRATEGY_LABELS, type AbortableKind, type NextStep } from './gitSectionLogic'
import { useSideCardMenu } from './useSideCardMenu'

/** What the button does once pressed; the section runs it under its one-action lock. */
export type NextStepChoice =
  | { kind: 'open-changes' }
  | { kind: 'open-pull-request' }
  | { kind: 'pull'; strategy: GitPullStrategy }
  | { kind: 'push' }
  | { kind: 'abort'; what: AbortableKind }
  | { kind: 'continue'; what: GitInProgress }

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
  continue: Play,
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
  const abort: MenuItem[] = (step.kind === 'resolve' || step.kind === 'continue') && step.abort
    ? [{ label: `Abort ${step.abort}`, choice: { kind: 'abort', what: step.abort } }]
    : []
  // Continue carries on at once; the menu also offers the files, to look before carrying on.
  return step.kind === 'continue' ? [...abort, { label: 'Open Changes', choice: { kind: 'open-changes' } }] : abort
}

/** What pressing the step itself does. Diverged branches have no default: the press opens the menu. */
function mainChoice(step: NextStep): NextStepChoice | null {
  switch (step.kind) {
    case 'resolve':
      return { kind: 'open-changes' }
    case 'continue':
      return { kind: 'continue', what: step.what }
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
  // The button that opened the menu gets focus back when it closes: the step itself, or ▾.
  const invokerRef = useRef<HTMLButtonElement | null>(null)
  const items = menuItems(step)
  const main = mainChoice(step)
  const Icon = ICONS[step.kind]
  const tone = step.kind === 'resolve' ? 'warn' : 'accent'
  const blocked = blockedReason !== null
  const open = menuOpen && items.length > 0 && !busy
  const { menuRef, menuId, menuStyle, closeAndFocus, menuKeyDown, triggerKeyDown } = useSideCardMenu({
    open,
    setOpen: setMenuOpen,
    anchorRef: groupRef,
    focusRef: invokerRef,
    sizeKey: items.length
  })
  const toggleFrom = (event: MouseEvent<HTMLButtonElement>) => {
    invokerRef.current = event.currentTarget
    setMenuOpen((value) => !value)
  }

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
    closeAndFocus()
    onChoose(choice)
  }
  const menuTriggerKeys = (event: Parameters<typeof triggerKeyDown>[0]) => {
    if (blocked) return
    invokerRef.current = event.currentTarget as HTMLButtonElement
    triggerKeyDown(event)
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
          aria-expanded={main ? undefined : open}
          aria-controls={!main && open ? menuId : undefined}
          onClick={(event) => {
            if (blocked) return
            if (main) onChoose(main)
            else toggleFrom(event)
          }}
          onKeyDown={main ? undefined : menuTriggerKeys}
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
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            aria-disabled={blocked || undefined}
            onClick={(event) => { if (!blocked) toggleFrom(event) }}
            onKeyDown={menuTriggerKeys}
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        )}
      </div>
      {open && (
        <FloatingPortal>
          <div ref={menuRef} id={menuId} className="side-card-device-menu" role="menu" aria-label={step.label} style={menuStyle} onKeyDown={menuKeyDown}>
            {items.map((item) => (
              <button key={item.label} type="button" role="menuitem" tabIndex={-1} className="side-card-device-item" onClick={() => choose(item.choice)}>
                <span className="side-card-device-item-label">{item.label}</span>
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
