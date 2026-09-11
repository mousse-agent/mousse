import type { PathOwnershipRule, SettingsClassificationEntry, SettingsScope } from './types'

/**
 * Frozen C1 classification of current mousse.conf keys and well-known home files.
 * Provider catalog/credentials and MMS infrastructure stay installation-scoped.
 * Personal selections, catalogs of user work, and control/channel/scheduled stores
 * are profile-scoped after migration.
 */
export const MOUSSE_CONF_INSTALLATION_KEYS = ['version', 'mms', 'features'] as const
export const MOUSSE_CONF_PROFILE_KEYS = [
  'settings',
  'providers',
  'agents',
  'scheduled',
  'channels'
] as const

export const SETTINGS_CLASSIFICATION: readonly SettingsClassificationEntry[] = [
  { path: 'version', scope: 'installation', notes: 'Config schema version for the installation file.' },
  { path: 'mms.autostart', scope: 'installation', notes: 'Daemon OS autostart is installation infrastructure.' },
  { path: 'mms.logLevel', scope: 'installation', notes: 'Daemon log verbosity is installation infrastructure.' },
  {
    path: 'features',
    scope: 'installation',
    notes: 'Operational rollout flags stay installation-wide; they are not per-profile experiments.'
  },
  {
    path: 'settings.profile.username',
    scope: 'profile',
    notes: 'Display username is personal presentation state.'
  },
  { path: 'settings.appearance', scope: 'profile', notes: 'Theme, accent, and acrylic follow the selected profile.' },
  { path: 'settings.notifications', scope: 'profile', notes: 'Notification preferences are personal.' },
  { path: 'settings.integrations', scope: 'profile', notes: 'Skill/MCP enablement is profile-owned.' },
  { path: 'settings.title', scope: 'profile', notes: 'Title-model selection points at the shared catalog.' },
  {
    path: 'providers.llmProvider',
    scope: 'profile',
    notes: 'Default provider selection is personal; credentials remain shared.'
  },
  {
    path: 'providers.model',
    scope: 'profile',
    notes: 'Default model selection is personal; the catalog remains shared.'
  },
  { path: 'agents', scope: 'profile', notes: 'Engine enablement and per-agent model prefs are personal.' },
  { path: 'scheduled', scope: 'profile', notes: 'Job definitions bind their owner at creation.' },
  { path: 'channels', scope: 'profile', notes: 'Channel routing and pairing maps are profile-owned.' }
]

export const PATH_OWNERSHIP_RULES: readonly PathOwnershipRule[] = [
  {
    logicalName: 'auth.json',
    scope: 'installation',
    relativePath: 'auth.json',
    preservedDuringMigration: true,
    notes: 'Shared provider credentials. Never copied into a profile root.'
  },
  {
    logicalName: 'mms.owner.json',
    scope: 'installation',
    relativePath: 'mms.owner.json',
    preservedDuringMigration: true,
    notes: 'Installation owner lease. Endpoint relocation is out of scope.'
  },
  {
    logicalName: 'mms.runtime.json',
    scope: 'installation',
    relativePath: 'mms.runtime.json',
    preservedDuringMigration: true,
    notes: 'Daemon discovery record. Must remain at the installation root.'
  },
  {
    logicalName: 'mms.sock',
    scope: 'installation',
    relativePath: 'mms.sock',
    preservedDuringMigration: true,
    notes: 'Unix endpoint under the canonical installation home.'
  },
  {
    logicalName: 'windows-named-pipe',
    scope: 'installation',
    relativePath: '',
    preservedDuringMigration: true,
    notes: 'Derived from SHA-256 of the canonical installation home; not a filesystem move.'
  },
  {
    logicalName: 'mousse.conf',
    scope: 'installation',
    relativePath: 'mousse.conf',
    preservedDuringMigration: true,
    notes: 'After split: installation keys remain here; personal keys move to the profile conf.'
  },
  {
    logicalName: 'providers/',
    scope: 'installation',
    relativePath: 'providers',
    preservedDuringMigration: true,
    notes: 'Shared provider catalog/cache.'
  },
  {
    logicalName: 'repositories/',
    scope: 'installation',
    relativePath: 'repositories',
    preservedDuringMigration: true,
    notes: 'Shared repository identity and mutation leases. Git worktrees are not ordinary directories.'
  },
  {
    logicalName: 'browser-binaries/',
    scope: 'installation',
    relativePath: 'browser-binaries',
    preservedDuringMigration: true,
    notes: 'Verified browser distributions are installation-wide.'
  },
  {
    logicalName: 'projects.json',
    scope: 'profile',
    relativePath: 'projects.json',
    preservedDuringMigration: false,
    notes: 'Personal project registry. Same filesystem repo may be registered independently per profile.'
  },
  {
    logicalName: 'threads-index.json',
    scope: 'profile',
    relativePath: 'threads-index.json',
    preservedDuringMigration: false,
    notes: 'Thread metadata index is profile-owned.'
  },
  {
    logicalName: 'active-thread.json',
    scope: 'profile',
    relativePath: 'active-thread.json',
    preservedDuringMigration: false,
    notes: 'Last active thread is presentation/personal state.'
  },
  {
    logicalName: 'thread-data/standalone',
    scope: 'profile',
    relativePath: 'thread-data/standalone',
    preservedDuringMigration: false,
    notes: 'Current durable standalone thread layout; keep internal generation structure.'
  },
  {
    logicalName: 'thread-data/repositories',
    scope: 'profile',
    relativePath: 'thread-data/repositories',
    preservedDuringMigration: false,
    notes: 'Current durable repository-backed thread layout.'
  },
  {
    logicalName: '.data',
    scope: 'profile',
    relativePath: '.data',
    preservedDuringMigration: false,
    notes: 'Legacy standalone thread data. Merge into thread-data/standalone or fail on hash mismatch.'
  },
  {
    logicalName: 'scheduled/',
    scope: 'profile',
    relativePath: 'scheduled',
    preservedDuringMigration: false,
    notes: 'Scheduler runtime, locks, and history are profile-owned.'
  },
  {
    logicalName: 'channels/',
    scope: 'profile',
    relativePath: 'channels',
    preservedDuringMigration: false,
    notes: 'Sessions, directory, and pairing state are profile-owned.'
  },
  {
    logicalName: 'control/',
    scope: 'profile',
    relativePath: 'control',
    preservedDuringMigration: false,
    notes: 'Plus credentials must be decrypted at the old control dir and re-encrypted at the destination.'
  },
  {
    logicalName: 'mcp-oauth/',
    scope: 'profile',
    relativePath: 'secrets/mcp-oauth',
    preservedDuringMigration: false,
    notes: 'Integration OAuth sessions are profile-owned.'
  },
  {
    logicalName: 'agent-configs/',
    scope: 'profile',
    relativePath: 'agent-configs',
    preservedDuringMigration: false,
    notes: 'Generated agent configs are personal ephemeral material.'
  },
  {
    logicalName: 'line-edits.json',
    scope: 'profile',
    relativePath: 'line-edits.json',
    preservedDuringMigration: false,
    notes: 'Usage attribution is personal.'
  }
]

export function classifyMousseConfKey(key: string): SettingsScope | 'unknown' {
  if ((MOUSSE_CONF_INSTALLATION_KEYS as readonly string[]).includes(key)) return 'installation'
  if ((MOUSSE_CONF_PROFILE_KEYS as readonly string[]).includes(key)) return 'profile'
  return 'unknown'
}
