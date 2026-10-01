import { getMousseHomeDir } from '../data/paths'
import {
  createProcessEnvSecretAdapter,
  type IntegrationSecretAdapter
} from './secrets'

export interface IntegrationArtifactAdapter {
  store(input: {
    bytes: Uint8Array
    mimeType: string
    name?: string
  }): Promise<{ artifactId: string; uri: string }>
}

export interface IntegrationRuntimeContext {
  profileId: string
  profileRoot: string
  projectPath?: string
  secrets: IntegrationSecretAdapter
  artifacts?: IntegrationArtifactAdapter
}

/**
 * Compatibility adapter used until root wires ProfileRuntime.
 * Paths are injected; this is not a selected-profile global.
 */
export function createLegacySingleProfileContext(
  overrides: Partial<IntegrationRuntimeContext> = {}
): IntegrationRuntimeContext {
  return {
    profileId: overrides.profileId ?? 'default',
    profileRoot: overrides.profileRoot ?? getMousseHomeDir(),
    projectPath: overrides.projectPath,
    secrets: overrides.secrets ?? createProcessEnvSecretAdapter(),
    artifacts: overrides.artifacts
  }
}

export function isLegacyDefaultProfile(context: IntegrationRuntimeContext): boolean {
  return context.profileId === 'default' && context.profileRoot === getMousseHomeDir()
}
