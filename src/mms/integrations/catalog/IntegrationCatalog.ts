import type { McpRegistrySnapshot, SkillsRegistrySnapshot } from '../../../shared/integrations'
import type { IntegrationActor } from '../../../shared/integrations/actor'
import { McpManager } from '../mcp/McpManager'
import { McpRegistry } from '../mcp/McpRegistry'
import { SkillsRegistry } from '../skills/SkillsRegistry'
import { SkillLifecycleService } from '../skills/SkillLifecycleService'
import { McpLifecycleService } from '../mcp/McpLifecycleService'
import { resolveEffectiveMcpServers, resolveEffectiveSkills } from './EffectiveIntegrationResolver'
import type { SettingsStore } from '../../settings/SettingsStore'

export class IntegrationCatalog {
  constructor(
    private readonly skillsRegistry: SkillsRegistry,
    private readonly mcpRegistry: McpRegistry,
    private readonly mcpManager: McpManager,
    private readonly settingsStore: SettingsStore,
    readonly skills: SkillLifecycleService,
    readonly mcp: McpLifecycleService
  ) {}

  async skillsSnapshot(projectPath?: string, refresh = false): Promise<SkillsRegistrySnapshot> {
    return refresh
      ? this.skillsRegistry.refresh({ projectPath })
      : this.skillsRegistry.discover({ projectPath })
  }

  async mcpSnapshot(projectPath?: string, refresh = false): Promise<McpRegistrySnapshot> {
    if (refresh) this.mcpManager.invalidateDiscoveryCache()
    return this.mcpRegistry.discover({ projectPath, redactSecrets: true })
  }

  async effectiveForActor(actor: IntegrationActor, projectPath?: string) {
    const [skills, mcp] = await Promise.all([
      this.skillsSnapshot(projectPath),
      this.mcpRegistry.discover({ projectPath, redactSecrets: true })
    ])
    const settings = this.settingsStore.get().integrations
    return {
      skills: resolveEffectiveSkills({ snapshot: skills, settings: settings.skills, actor }),
      servers: resolveEffectiveMcpServers({ servers: mcp.servers, settings: settings.mcp, actor })
    }
  }
}
