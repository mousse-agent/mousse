import { useEffect, useState } from 'react'
import { normalizeBranchPrefix, withBranchPrefix, type BranchNamingMode } from '../../../shared/mousseBranches'
import { BRANCH_NAMING_INSTRUCTIONS_MAX, normalizeBranchNamingSettings, type BranchNamingSettings } from '../../../shared/settings'
import { GitBranch } from '../../lib/icons'
import { SettingsGroup, SettingsRow } from '../settings/SettingsRow'
import { Select, type SelectOption } from '../ui/Select'

const MODE_OPTIONS: SelectOption<BranchNamingMode>[] = [
  { value: 'static', label: 'Static prefix' },
  { value: 'semantic', label: 'Semantic prefix' },
  { value: 'custom', label: 'Custom instructions' }
]

const NAMING_TOOLTIP = 'A worktree starts at once on a temporary name. The title model renames its branch moments later; without a title model, or for a private thread, the temporary name stays.'

function modeLine(settings: BranchNamingSettings): string {
  if (settings.mode === 'semantic') return 'The model picks feat/, fix/, refactor/…'
  if (settings.mode === 'custom') return 'The model names the whole branch.'
  return withBranchPrefix(settings.prefix, 'fix-login-button')
}

/**
 * Settings → Storage → Branches: how a thread's worktree branch is named. One line per row; the details are in the
 * tooltips. Every change saves at once (text fields when they lose focus or on Enter).
 */
export function BranchNamingGroup({ value, onChange }: { value: BranchNamingSettings | undefined; onChange: (next: BranchNamingSettings) => void | Promise<void> }) {
  const settings = normalizeBranchNamingSettings(value)
  const [prefix, setPrefix] = useState(settings.prefix)
  const [instructions, setInstructions] = useState(settings.instructions)
  useEffect(() => setPrefix(settings.prefix), [settings.prefix])
  useEffect(() => setInstructions(settings.instructions), [settings.instructions])
  const save = (change: Partial<BranchNamingSettings>) => void onChange({ ...settings, ...change })
  const commitPrefix = () => {
    const next = normalizeBranchPrefix(prefix)
    setPrefix(next)
    if (next !== settings.prefix) save({ prefix: next })
  }
  const commitInstructions = () => { if (instructions !== settings.instructions) save({ instructions }) }

  return <SettingsGroup title="Branches" icon={GitBranch} id="storage-branches">
    <SettingsRow
      data-testid="branch-naming-mode"
      title="Worktree branch naming"
      anchor="storage-branch-naming"
      description={<span title={NAMING_TOOLTIP}>{settings.mode === 'static'
        ? <code className="storage-folder-path">{modeLine(settings)}</code>
        : modeLine(settings)}</span>}
      control={<Select ariaLabel="Worktree branch naming" value={settings.mode} options={MODE_OPTIONS} onChange={(mode) => save({ mode })} />}
    />
    {settings.mode === 'static' && <SettingsRow
      indent
      title="Branch prefix"
      anchor="storage-branch-prefix"
      htmlFor="storage-branch-prefix-input"
      description={<span title="A trailing slash is optional. Characters a branch can't hold become hyphens.">Empty for no prefix.</span>}
      control={<input
        id="storage-branch-prefix-input"
        data-testid="branch-prefix-input"
        className="settings-input"
        spellCheck={false}
        value={prefix}
        placeholder="none"
        onChange={(event) => setPrefix(event.target.value)}
        onBlur={commitPrefix}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitPrefix() } }}
      />}
    />}
    {settings.mode === 'custom' && <SettingsRow
      indent
      title="Naming instructions"
      anchor="storage-branch-instructions"
      htmlFor="storage-branch-instructions-input"
      description={<span title="Added to the request the title model gets. It sees the thread's first message.">Added to the naming request.</span>}
    >
      <textarea
        id="storage-branch-instructions-input"
        data-testid="branch-instructions-input"
        className="settings-input branch-naming-instructions"
        rows={3}
        maxLength={BRANCH_NAMING_INSTRUCTIONS_MAX}
        value={instructions}
        placeholder="e.g. Start with the ticket number, like abc-123/short-name."
        onChange={(event) => setInstructions(event.target.value)}
        onBlur={commitInstructions}
      />
    </SettingsRow>}
  </SettingsGroup>
}
