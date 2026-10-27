import { useState } from 'react'
import { STORAGE_POLICY_DEFAULTS, type StoragePolicy } from '../../../shared/storage'
import { Sparkles } from '../../lib/icons'
import { RECOMMENDED_COPY } from '../../lib/storageCopy'
import { Modal } from '../ui/Modal'
import { RuleDescription } from './StoragePolicyRows'

/** The recommended rules for a profile that already has its own: the new ones on, the person's deleted-threads choice kept. */
export function recommendedPolicy(current: StoragePolicy): StoragePolicy {
  return {
    schemaVersion: 1,
    worktrees: { ...STORAGE_POLICY_DEFAULTS.worktrees, removeWithDeletedThreads: current.worktrees.removeWithDeletedThreads },
    browser: { ...STORAGE_POLICY_DEFAULTS.browser }
  }
}

/**
 * A one-time notice for a profile that was already in use: new cleanup rules exist, none of them is on,
 * and turning them on is the person's decision. Reviewing shows what each would delete and never delete.
 */
export function RecommendedRulesNotice({ busy, onTurnOn, onDismiss, initialOpen = false }: {
  busy: boolean
  onTurnOn: () => void
  onDismiss: () => void
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  return <section className="storage-review-notice" aria-label="Recommended cleanup rules" data-testid="storage-review-notice">
    <Sparkles size={15} aria-hidden="true" />
    <div className="storage-review-text">
      <p><strong>{RECOMMENDED_COPY.title}</strong></p>
      <p className="settings-muted">{RECOMMENDED_COPY.body}</p>
    </div>
    <div className="storage-review-actions">
      <button type="button" className="settings-btn" data-testid="storage-review-open" onClick={() => setOpen(true)}>Review recommended cleanup rules</button>
      <button type="button" className="settings-btn" data-testid="storage-review-dismiss" disabled={busy} onClick={onDismiss}>Dismiss</button>
    </div>
    <Modal
      open={open}
      title="Recommended cleanup rules"
      onClose={() => setOpen(false)}
      footer={<>
        <button type="button" className="settings-btn" onClick={() => setOpen(false)}>Not now</button>
        <button type="button" className="settings-btn" data-testid="storage-review-turn-on" disabled={busy} onClick={() => { setOpen(false); onTurnOn() }}>Turn on recommended rules</button>
      </>}
    >
      <div className="storage-review-rules" data-testid="storage-review-rules">
        <p className="settings-muted">{RECOMMENDED_COPY.modalIntro}</p>
        {(['inactive', 'merged', 'captures'] as const).map((rule) => <div key={rule} className="storage-review-rule">
          <p><strong>{RECOMMENDED_COPY.rules[rule]}</strong></p>
          <p className="settings-muted"><RuleDescription rule={rule} /></p>
        </div>)}
      </div>
    </Modal>
  </section>
}
