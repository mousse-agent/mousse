import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInstallationPaths } from '../mms/profiles/paths'
import { isProfileId } from '../shared/profiles/ids'
import { normalizeAppearance, type AppearanceSettings } from '../shared/settings'

/** Read presentation preferences without starting, binding to, or writing through MMS. */
export function readStartupAppearance(homeDir: string, fallback: AppearanceSettings): AppearanceSettings {
  try {
    const paths = createInstallationPaths(homeDir)
    const manifest = JSON.parse(readFileSync(paths.installationManifest, 'utf8'))
    const id = manifest.defaultProfileId
    if (!isProfileId(id) || !Array.isArray(manifest.profiles) ||
      !manifest.profiles.some((profile: { id?: string; status?: string }) => profile?.id === id && profile.status === 'active')) {
      return normalizeAppearance(fallback)
    }
    const config = JSON.parse(readFileSync(join(paths.profileRoot(id), 'mousse.conf'), 'utf8'))
    return normalizeAppearance(config.settings?.appearance ?? fallback)
  } catch {
    return normalizeAppearance(fallback)
  }
}
