import {
  DEFAULT_PROFILE_DISPLAY_NAME,
  DEFAULT_PROFILE_SLUG,
  PROFILE_ID_PATTERN
} from './ids'
import { classifyMousseConfKey, MOUSSE_CONF_INSTALLATION_KEYS, MOUSSE_CONF_PROFILE_KEYS } from './settingsClassification'
import type { ProfileId } from './ids'
import {
  INSTALLATION_SCHEMA_VERSION,
  PROFILE_CONTRACT_ID,
  PROFILE_CONTRACT_VERSION,
  type ControlCredentialsPlaintext,
  type InstallationManifest,
  type ProfileRecord
} from './types'

/** Frozen C1 fixture vectors. Consumers and tests must treat these as the contract examples. */

export const FIXTURE_PROFILE_A_ID = '7f1d3a2c-4b90-4e11-a8c3-0d5e6f7a8b9c' as ProfileId
export const FIXTURE_PROFILE_B_ID = 'e9c8b7a6-5544-4f33-b221-100998877665' as ProfileId
export const FIXTURE_DEFAULT_PROFILE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as ProfileId

export const INVALID_PROFILE_IDS = [
  '',
  'default',
  'not-a-uuid',
  '7f1d3a2c4b904e11a8c30d5e6f7a8b9c',
  '../7f1d3a2c-4b90-4e11-a8c3-0d5e6f7a8b9c',
  '7f1d3a2c-4b90-4e11-a8c3-0d5e6f7a8b9c/../../etc',
  '00000000-0000-0000-0000-000000000000',
  '7f1d3a2c-4b90-1e11-a8c3-0d5e6f7a8b9c',
  '7f1d3a2c-4b90-4e11-c8c3-0d5e6f7a8b9c'
] as const

export const CANONICALIZABLE_PROFILE_ID = '7F1D3A2C-4B90-4E11-A8C3-0D5E6F7A8B9C'

export const INVALID_PROFILE_SLUGS = [
  '',
  'has space',
  '-leading',
  'bad_slug',
  '../escape',
  FIXTURE_PROFILE_A_ID,
  'a'.repeat(65)
] as const

export const FIXTURE_PROFILE_A: ProfileRecord = {
  id: FIXTURE_PROFILE_A_ID,
  slug: 'alice',
  displayName: 'Alice',
  color: '#4f46e5',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
  status: 'active'
}

export const FIXTURE_PROFILE_B: ProfileRecord = {
  id: FIXTURE_PROFILE_B_ID,
  slug: 'bob',
  displayName: 'Bob',
  color: '#059669',
  createdAt: '2026-01-01T00:00:01.000Z',
  updatedAt: '2026-01-01T00:00:01.000Z',
  revision: 1,
  status: 'active'
}

export const FIXTURE_DEFAULT_PROFILE: ProfileRecord = {
  id: FIXTURE_DEFAULT_PROFILE_ID,
  slug: DEFAULT_PROFILE_SLUG,
  displayName: DEFAULT_PROFILE_DISPLAY_NAME,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  revision: 1,
  status: 'active'
}

export const FIXTURE_INSTALLATION_MANIFEST: InstallationManifest = {
  schemaVersion: INSTALLATION_SCHEMA_VERSION,
  contractId: PROFILE_CONTRACT_ID,
  contractVersion: PROFILE_CONTRACT_VERSION,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  defaultProfileId: FIXTURE_DEFAULT_PROFILE_ID,
  compatibility: { singleProfileLegacyClients: true },
  profiles: [
    {
      id: FIXTURE_DEFAULT_PROFILE_ID,
      slug: DEFAULT_PROFILE_SLUG,
      status: 'active',
      rootRelativePath: `profiles/${FIXTURE_DEFAULT_PROFILE_ID}`
    },
    {
      id: FIXTURE_PROFILE_A_ID,
      slug: 'alice',
      status: 'active',
      rootRelativePath: `profiles/${FIXTURE_PROFILE_A_ID}`
    }
  ],
  migration: {
    status: 'committed',
    journalRelativePath: 'migration/journal.json',
    lastCompletedStep: 'commit-manifest',
    committedAt: '2026-01-01T00:00:02.000Z',
    defaultProfileId: FIXTURE_DEFAULT_PROFILE_ID
  }
}

export const FIXTURE_LEGACY_MOUSSE_CONF = {
  version: 1,
  mms: { autostart: false, logLevel: 'info' },
  features: { subagentLifecycleV2: false },
  settings: {
    profile: { username: 'legacy-user' },
    appearance: { theme: 'dark', accentColor: '#3b82f6', acrylic: false, acrylicIntensity: 50 },
    notifications: { threadCompletionSound: true }
  },
  providers: { llmProvider: 'openrouter', model: 'openai/gpt-4.1' },
  agents: { enabled: { mousse: true } },
  scheduled: { enabled: true, jobs: [{ id: 'job-1', name: 'Morning', prompt: 'status' }] },
  channels: { platforms: { webhook: { enabled: false } } },
  experimentalUnknown: { keep: true }
} as const

export const FIXTURE_CONTROL_CREDENTIALS: ControlCredentialsPlaintext = {
  accountId: 'usr-fixture-1',
  accountEmail: 'fixture@example.test',
  accessToken: 'access-fixture',
  refreshToken: 'refresh-fixture',
  updatedAt: '2026-01-01T00:00:00.000Z'
}

export const FIXTURE_REVISION_CONFLICT = {
  profileId: FIXTURE_PROFILE_A_ID,
  expectedRevision: 1,
  actualRevision: 2
} as const

export function assertFrozenContractInvariants(): void {
  if (!PROFILE_ID_PATTERN.test(FIXTURE_PROFILE_A_ID)) {
    throw new Error('Fixture profile A id is not a canonical UUID v4')
  }
  if (classifyMousseConfKey('mms') !== 'installation') {
    throw new Error('mms must remain installation-scoped')
  }
  if (classifyMousseConfKey('providers') !== 'profile') {
    throw new Error('providers.llmProvider/model selection is profile-scoped')
  }
  if (classifyMousseConfKey('experimentalUnknown') !== 'unknown') {
    throw new Error('unknown conf keys must be reported, not silently classified')
  }
  if (MOUSSE_CONF_INSTALLATION_KEYS.includes('auth' as never)) {
    throw new Error('auth.json is a path, not a mousse.conf key')
  }
  if (!MOUSSE_CONF_PROFILE_KEYS.includes('channels')) {
    throw new Error('channels must be profile-scoped')
  }
}
