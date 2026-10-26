import { ProviderIcon } from '../lib/providerIcons'
import { useAppStore } from '../stores/appStore'
import { threadProviderId, type SubagentBadgeTone } from './subagentStatus'
import './subagentAvatar.css'

interface SubagentAvatarProps {
  /** Provider instance id or driver (`claude`, `codex`, `pi:openai`); empty draws the generic mark. */
  providerId: string
  /** Status dot on the icon's corner; none for a plain icon, as in a stack of icons. */
  tone?: SubagentBadgeTone
  size?: number
  /** Draw the icon in a round chip, for rows and stacks in the chat. */
  chip?: boolean
}

/** A subagent's provider logo with a small status dot on its lower-right corner. */
export function SubagentAvatar({ providerId, tone, size = 16, chip = false }: SubagentAvatarProps) {
  return (
    <span className={`subagent-avatar${chip ? ' is-chip' : ''}`} aria-hidden="true">
      <ProviderIcon providerId={providerId} size={size} />
      {tone && <span className="subagent-avatar-badge" data-tone={tone} />}
    </span>
  )
}

/** The provider a thread runs on, so subagents that inherited it show its logo. */
export function useThreadProviderId(threadId: string | null | undefined): string | null {
  return useAppStore((s) =>
    threadId ? threadProviderId(s.threads.find((thread) => thread.id === threadId)?.modelOverride?.llmProvider, s.appInfo?.llmProvider) : null
  )
}
