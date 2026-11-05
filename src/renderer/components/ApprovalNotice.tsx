import { formatBinding, type CommandId } from '../../shared/commands'
import { COMPOSER_SELECTOR } from '../commands/commandContext'
import { useCommand, useCommandBindings } from '../commands/commandRegistry'
import { permissionIcon, permissionSummary } from '../chat/components/agent-elements/tools/permission-request'
import type { CurrentPermissionRequest } from '../hooks/usePermissionRequests'
import { scrollToMessage } from '../stores/chatNavigationStore'
import { useAppStore } from '../stores/appStore'
import { useComposerNotice, type ComposerNoticeProps } from './ComposerNotice'

/** What sending does while an approval waits, for the send button's tooltip and accessible name. */
export const DENY_AND_SEND_LABEL = 'Deny and send'

function composerFocused(): boolean {
  const active = typeof document === 'undefined' ? null : document.activeElement
  return Boolean(active?.closest(COMPOSER_SELECTOR))
}

/**
 * The thread's waiting permission request at the composer. While its inline row is out of view (or
 * the composer holds text, which would deny it), the notice slot names the request with Deny and
 * Approve and a jump to the row. `approval.allow` (Ctrl/Cmd+Enter while the composer is empty) and
 * `approval.deny` (palette only by default) answer it from anywhere in the thread. The row and this
 * notice share the request's chosen answer, so it is sent once.
 */
export function ApprovalNotice({
  request,
  composerHasText,
  placed,
  isShown
}: {
  request: CurrentPermissionRequest | null
  composerHasText: boolean
  /** The request's row is in the transcript, so the jump can reach it. */
  placed: boolean
  /** False while this chat is kept mounted but not in view: its commands must not answer. */
  isShown: () => boolean
}) {
  const bindings = useCommandBindings()
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  const controls = request?.controls ?? null
  const chosen = controls?.chosen ?? null
  const answerable = () => Boolean(controls && !chosen && isShown())

  useCommand('approval.allow', () => controls?.onAnswer(controls.options.allow), () =>
    // From the composer with text in it the same key sends, which denies the request.
    answerable() && !(composerHasText && composerFocused())
  )
  useCommand('approval.deny', () => controls?.onAnswer(controls.options.deny), answerable)

  const withKey = (label: string, id: CommandId) => {
    const binding = bindings[id]
    return binding ? `${label} (${formatBinding(binding, platform)})` : label
  }

  let notice: ComposerNoticeProps | null = null
  if (request && controls && (!request.inView || composerHasText)) {
    const summary = permissionSummary(request.prompt, request.action)
    const Icon = permissionIcon(summary.verb)
    const answer = (optionId: string) => () => controls.onAnswer(optionId)
    notice = {
      tone: 'warning',
      blocking: true,
      icon: <Icon size={14} strokeWidth={1.8} aria-hidden="true" />,
      title: composerHasText ? 'Sending denies this' : 'Approval',
      detail: `${summary.verb} ${summary.target}`,
      tooltip: request.prompt,
      label: 'Waiting approval',
      actions: [
        {
          label: 'Deny',
          title: withKey('Deny', 'approval.deny'),
          blocked: chosen !== null,
          busy: chosen === controls.options.deny,
          onClick: answer(controls.options.deny)
        },
        {
          label: 'Approve',
          title: withKey('Approve', 'approval.allow'),
          blocked: chosen !== null,
          busy: chosen === controls.options.allow,
          onClick: answer(controls.options.allow)
        }
      ],
      ...(placed ? { onJump: () => scrollToMessage(`permission:${request.requestId}`), jumpLabel: 'Show request' } : {})
    }
  }
  useComposerNotice(notice)
  return null
}
