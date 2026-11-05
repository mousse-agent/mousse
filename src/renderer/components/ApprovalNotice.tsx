import { formatBinding, type CommandId } from '../../shared/commands'
import { COMPOSER_SELECTOR } from '../commands/commandContext'
import { useCommand, useCommandBindings } from '../commands/commandRegistry'
import { permissionIcon, permissionSummary } from '../chat/components/agent-elements/tools/permission-request'
import type { CurrentPermissionRequest } from '../hooks/usePermissionRequests'
import { scrollToMessage } from '../stores/chatNavigationStore'
import { useAppStore } from '../stores/appStore'
import { RefreshCw } from '../lib/icons'
import { useComposerNotice, type ComposerNoticeProps } from './ComposerNotice'

/** Why Deny and Approve wait while the connection is lost. */
export const APPROVAL_OFFLINE_REASON = 'Connection lost: the answer cannot reach the agent'

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
 * notice share the request's chosen answer, so it is sent once. While the connection is lost the line
 * says so and Deny and Approve wait, since it hides the "Connection lost" notice.
 */
export function ApprovalNotice({
  request,
  composerHasText,
  placed,
  isShown,
  connectionLost = null
}: {
  request: CurrentPermissionRequest | null
  composerHasText: boolean
  /** The request's row is in the transcript, so the jump can reach it. */
  placed: boolean
  /** False while this chat is kept mounted but not in view: its commands must not answer. */
  isShown: () => boolean
  /** Set while the connection is lost: the line says so and offers Retry instead of answering. */
  connectionLost?: { onRetry: () => void } | null
}) {
  const bindings = useCommandBindings()
  const platform = useAppStore((state) => state.appInfo?.platform) ?? ''
  const controls = request?.controls ?? null
  const chosen = controls?.chosen ?? null
  const answerable = () => Boolean(controls && !chosen && !connectionLost && isShown())

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
    const offline = connectionLost !== null
    notice = {
      tone: 'warning',
      blocking: true,
      icon: <Icon size={14} strokeWidth={1.8} aria-hidden="true" />,
      title: composerHasText ? 'Sending denies this' : 'Approval',
      detail: `${summary.verb} ${summary.target}`,
      ...(offline ? { note: 'Connection lost' } : {}),
      tooltip: request.prompt,
      label: 'Waiting approval',
      actions: [
        {
          label: 'Deny',
          title: offline ? APPROVAL_OFFLINE_REASON : withKey('Deny', 'approval.deny'),
          blocked: chosen !== null || offline,
          busy: chosen === controls.options.deny,
          onClick: answer(controls.options.deny)
        },
        {
          label: 'Approve',
          title: offline ? APPROVAL_OFFLINE_REASON : withKey('Approve', 'approval.allow'),
          blocked: chosen !== null || offline,
          busy: chosen === controls.options.allow,
          onClick: answer(controls.options.allow)
        },
        ...(connectionLost ? [{ label: 'Retry connection', icon: <RefreshCw size={14} strokeWidth={1.8} />, onClick: connectionLost.onRetry }] : [])
      ],
      ...(placed ? { onJump: () => scrollToMessage(`permission:${request.requestId}`), jumpLabel: 'Show request' } : {})
    }
  }
  useComposerNotice(notice)
  return null
}
