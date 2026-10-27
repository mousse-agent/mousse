import { useCallback, useEffect, useState } from 'react'
import { describePermissionMode } from '../../../shared/permissionMode'
import type { ApprovalRuleInfo } from '../../../shared/types'
import { useAppStore } from '../../stores/appStore'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import './permissionSection.css'

/**
 * The thread's permission mode in one line (it is changed from the composer), and the "Always for this
 * thread" rules the user made: each is one exact request, listed so it can be revoked, or all at once.
 */
export function PermissionSection({ threadId }: SideCardSectionContext) {
  const mode = useAppStore((s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.permissionMode)
  const text = mode ? describePermissionMode(mode) : 'Profile default'
  const [rules, setRules] = useState<ApprovalRuleInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!threadId) {
      setRules([])
      return
    }
    window.mousse.threads
      .approvalRules(threadId)
      .then((next) => { setRules(next); setError(null) })
      .catch(() => setRules([]))
  }, [threadId])

  // A rule is made by answering a request, so the list is read again when a request is settled and when the mode changes.
  useEffect(() => {
    refresh()
    const off = window.mousse.orchestrator.onQuestionsCleared((payload) => {
      if (!payload.threadId || payload.threadId === threadId) refresh()
    })
    return off
  }, [refresh, threadId, mode])

  const revoke = (ruleId?: string): void => {
    if (!threadId) return
    window.mousse.threads
      .clearApprovalRules(threadId, ruleId)
      .then((next) => { setRules(next); setError(null) })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
  }

  return (
    <SideCardSection title="Permissions" threadId={threadId}>
      <p className="side-card-device-name" title={text}>{text}</p>
      {rules.length > 0 && (
        <div className="side-card-rules" role="list" aria-label="Always for this thread">
          {rules.map((rule) => (
            <div key={rule.id} className="side-card-rule" role="listitem">
              <p className="side-card-rule-summary" title={rule.summary}>{rule.summary}</p>
              <p className="side-card-rule-note">
                {rule.active
                  ? `Granted under ${describePermissionMode(rule.grantedUnder)}. A stricter mode takes effect on the next turn; the rule pauses as soon as you switch.`
                  : `Paused: this thread asks about more than ${describePermissionMode(rule.grantedUnder)}. It applies again if you loosen the mode.`}
                {` Id ${rule.id.slice(0, 8)}.`}
              </p>
              <button type="button" className="side-card-rule-revoke" onClick={() => revoke(rule.id)}>Revoke</button>
            </div>
          ))}
          <button type="button" className="side-card-rule-revoke" onClick={() => revoke()}>Reset approvals</button>
        </div>
      )}
      {error && <p className="side-card-rule-note" role="alert">{error}</p>}
    </SideCardSection>
  )
}
