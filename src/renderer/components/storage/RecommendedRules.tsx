import { useState } from 'react'
import { STORAGE_POLICY_DEFAULTS, type StoragePolicy } from '../../../shared/storage'
import { X } from '../../lib/icons'
import { RECOMMENDED_COPY } from '../../lib/storageCopy'
import { SettingsRow } from '../settings/SettingsRow'
import { Modal } from '../ui/Modal'
import { RuleLine } from './StoragePolicyRows'

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
 * and turning them on is the person's decision. Reviewing lists them; each rule's tooltip says what it deletes and never deletes.
 */
export function RecommendedRulesNotice({ busy, onTurnOn, onDismiss, initialOpen = false }: {
  busy: boolean
  onTurnOn: () => void
  onDismiss: () => void
  initialOpen?: boolean
}) {
  const [open, setOpen] = useState(initialOpen)
  return <section className="settings-group storage-review-notice" aria-label="Recommended cleanup rules" data-testid="storage-review-notice">
    <div className="settings-group-rows">
      <SettingsRow
        title={RECOMMENDED_COPY.title}
        description={RECOMMENDED_COPY.body}
        control={<div className="storage-review-actions">
          <button type="button" className="settings-btn" data-testid="storage-review-open" onClick={() => setOpen(true)}>Review</button>
          <button type="button" className="settings-icon-btn" data-testid="storage-review-dismiss" title="Dismiss" aria-label="Dismiss" disabled={busy} onClick={onDismiss}><X size={14} /></button>
        </div>}
      />
    </div>
    <Modal
      open={open}
      title="Recommended cleanup rules"
      onClose={() => setOpen(false)}
      footer={<button type="button" className="settings-btn" data-testid="storage-review-turn-on" disabled={busy} onClick={() => { setOpen(false); onTurnOn() }}>Turn on</button>}
    >
      <div className="settings-group-rows" data-testid="storage-review-rules">
        {(['inactive', 'merged', 'captures'] as const).map((rule) => <SettingsRow key={rule} title={RECOMMENDED_COPY.rules[rule]} description={<RuleLine rule={rule} />} />)}
      </div>
    </Modal>
  </section>
}
