import { existsSync, readFileSync } from 'node:fs'
import {
  classifyMousseConfKey,
  MOUSSE_CONF_INSTALLATION_KEYS,
  MOUSSE_CONF_PROFILE_KEYS
} from '../../../shared/profiles/settingsClassification'
import type { ConfigSplitResult } from './types'

const EMPTY_INSTALLATION: Record<string, unknown> = {
  version: 1,
  mms: { autostart: false, logLevel: 'info' },
  features: {}
}

const EMPTY_PROFILE: Record<string, unknown> = {
  version: 1,
  settings: {},
  providers: {},
  agents: {},
  scheduled: { enabled: true, jobs: [] },
  channels: {}
}

export function splitMousseConf(raw: Record<string, unknown>): ConfigSplitResult {
  const installationConf: Record<string, unknown> = { ...EMPTY_INSTALLATION }
  const profileConf: Record<string, unknown> = { ...EMPTY_PROFILE }
  const unknownKeys: string[] = []

  for (const [key, value] of Object.entries(raw)) {
    const scope = classifyMousseConfKey(key)
    if (scope === 'installation') installationConf[key] = value
    else if (scope === 'profile') profileConf[key] = value
    else {
      unknownKeys.push(key)
      installationConf[key] = value
    }
  }

  if (typeof raw.version === 'number') {
    installationConf.version = raw.version
    profileConf.version = raw.version
  }

  return { installationConf, profileConf, unknownKeys }
}

export function readRawMousseConf(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`mousse.conf is not an object: ${path}`)
  }
  return parsed as Record<string, unknown>
}

export function emptySplit(): ConfigSplitResult {
  return {
    installationConf: { ...EMPTY_INSTALLATION },
    profileConf: { ...EMPTY_PROFILE },
    unknownKeys: []
  }
}

/** Convert the pre-profile settings.json shape into profile-owned config sections. */
export function mergeLegacySettings(
  profileConf: Record<string, unknown>,
  legacy: Record<string, unknown>
): Record<string, unknown> {
  const source = legacy.settings && typeof legacy.settings === 'object' && !Array.isArray(legacy.settings)
    ? { ...legacy, ...(legacy.settings as Record<string, unknown>) }
    : legacy
  const settings = profileConf.settings && typeof profileConf.settings === 'object'
    ? { ...(profileConf.settings as Record<string, unknown>) }
    : {}
  for (const key of ['profile', 'appearance', 'notifications', 'integrations', 'title']) {
    if (source[key] !== undefined) settings[key] = source[key]
  }
  profileConf.settings = settings
  for (const key of ['provider', 'providers', 'agents']) {
    const sourceValue = source[key]
    if (!sourceValue || typeof sourceValue !== 'object' || Array.isArray(sourceValue)) continue
    const targetKey = key === 'provider' ? 'providers' : key
    profileConf[targetKey] = {
      ...(profileConf[targetKey] as Record<string, unknown>),
      ...(sourceValue as Record<string, unknown>)
    }
  }
  return profileConf
}

export const CONFIG_SPLIT_KEY_TABLE = {
  installation: MOUSSE_CONF_INSTALLATION_KEYS,
  profile: MOUSSE_CONF_PROFILE_KEYS
} as const
