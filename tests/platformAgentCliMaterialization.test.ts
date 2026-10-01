import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { AgentConfigManager } from '../src/mms/integrations/agents/AgentConfigManager'
import { AgentExecutionMaterializer } from '../src/mms/integrations/agents/AgentExecutionMaterializer'
import { McpRegistry } from '../src/mms/integrations/mcp/McpRegistry'
import { SkillsRegistry } from '../src/mms/integrations/skills/SkillsRegistry'
import { buildQualifiedCliInvocation, CliCapabilityError, createCliProcessRuntime, inspectCliCapabilities } from '../src/mms/agentDefinitions/cliRuntime'
import { AgentExecutionService } from '../src/mms/agentDefinitions/AgentExecutionService'
import type { AgentRuntimeInput } from '../src/shared/agents/execution'
import type { EffectiveAgentGrants } from '../src/shared/agents/types'
import { defaultAgentSettings } from '../src/shared/agents/defaults'
import type { McpRegistrySnapshot, SkillDescriptor, SkillsRegistrySnapshot } from '../src/shared/integrations'

function grants(overrides: Partial<EffectiveAgentGrants> = {}): EffectiveAgentGrants {
  return {
    skills: [],
    mcpTools: [],
    builtinTools: [],
    denied: [],
    ...overrides
  }
}

function input(runtimeKind: AgentRuntimeInput['runtimeKind'], grantSet = grants()): AgentRuntimeInput {
  return {
    runId: 'run-1', profileId: 'profile-1', threadId: 'thread-1', projectPath: process.cwd(), runtimeKind,
    model: {
      primary: { ref: { providerId: 'fixture', modelId: 'model' }, available: true, efforts: [], speeds: [], contexts: [], capabilities: [], unavailableReasons: [] },
      fallbacks: [], capabilityOverrides: {}
    },
    systemPrompt: 'Pinned system instructions.', userMessage: 'Local fixture input.', grants: grantSet,
    budget: { maxTurns: 2, maxToolCalls: 4, maxElapsedMs: 10_000 }, signal: new AbortController().signal
  }
}

describe('I04 qualified CLI materialization', () => {
  it('materializes only immutable grants and owns its generated runtime files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-i04-execution-materializer-'))
    try {
      const profileRoot = join(root, 'profile'), projectPath = join(root, 'project'), worktreePath = join(root, 'worktree'), skillRoot = join(root, 'source-skill')
      mkdirSync(profileRoot, { recursive: true }); mkdirSync(projectPath, { recursive: true }); mkdirSync(worktreePath, { recursive: true }); mkdirSync(skillRoot, { recursive: true })
      writeFileSync(join(skillRoot, 'SKILL.md'), '---\nname: selected\ndescription: selected\n---\nSelected bytes.\n')
      const skill: SkillDescriptor = {
        id: 'skill-selected', installationId: 'skill-selected', name: 'selected', description: 'selected', rootPath: skillRoot, skillPath: join(skillRoot, 'SKILL.md'),
        scope: 'global', source: 'mousse-profile', managed: true, enabled: true, isActive: true, revision: 'skill-r1', contentHash: 'skill-h1'
      }
      const server = {
        id: 'server-1', installationId: 'server-1', name: 'fixture', source: 'mousse' as const, scope: 'global' as const, transport: 'stdio' as const,
        status: 'configured' as const, command: process.execPath, args: ['fixture-mcp.js'], enabled: true, managed: true, configRevision: 'mcp-r1'
      }
      const skillsSnapshot: SkillsRegistrySnapshot = { skills: [skill], sources: [], diagnostics: [] }
      const mcpSnapshot: McpRegistrySnapshot = { servers: [server], sources: [], diagnostics: [] }
      const settings = new SettingsStore(MousseConfigStore.load(profileRoot))
      const manager = new AgentConfigManager(
        { discover: async () => mcpSnapshot } as unknown as McpRegistry,
        { discover: async () => skillsSnapshot } as unknown as SkillsRegistry,
        settings
      )
      const materializer = new AgentExecutionMaterializer(manager)
      const prepared = await materializer.prepare({
        agentId: 'run-1', runtimeKind: 'opencode', worktreePath, projectPath, systemPrompt: 'Pinned system instructions.',
        model: { providerId: 'fixture', modelId: 'model' },
        grants: grants({
          skills: [{ id: 'skill-selected', source: 'explicit', revision: 'skill-r1', hash: 'skill-h1' }],
          mcpTools: [{ id: 'server-1/ping', serverId: 'server-1', toolName: 'ping', source: 'explicit', revision: 'mcp-r1', hash: 'mcp-r1' }]
        })
      })
      expect(prepared.result.unsupportedCapabilities.filter((item) => item.level === 'error')).toHaveLength(0)
      expect(prepared.openCodeConfigPath).toBeTruthy()
      expect(readFileSync(prepared.openCodeConfigPath!, 'utf8')).toContain('Pinned system instructions.')
      expect(readFileSync(join(worktreePath, 'opencode.json'), 'utf8')).toContain('fixture')
      expect(existsSync(join(worktreePath, '.opencode', 'skills', 'selected', 'SKILL.md'))).toBe(true)

      writeFileSync(prepared.openCodeConfigPath!, 'changed by caller\n')
      const logs = await prepared.cleanup()
      expect(logs.some((entry) => entry.includes('Preserved changed runtime file'))).toBe(true)
      expect(existsSync(join(worktreePath, '.opencode', 'skills', 'selected', 'SKILL.md'))).toBe(false)
      expect(readFileSync(prepared.openCodeConfigPath!, 'utf8')).toBe('changed by caller\n')

      const claudeWorktree = join(root, 'claude-worktree')
      mkdirSync(claudeWorktree)
      const claudeGrants = grants({ mcpTools: [{ id: 'server-1/ping', serverId: 'server-1', toolName: 'ping', source: 'explicit', revision: 'mcp-r1', hash: 'mcp-r1' }] })
      const claudePrepared = await materializer.prepare({
        agentId: 'run-claude', runtimeKind: 'claude-code', worktreePath: claudeWorktree, projectPath,
        systemPrompt: 'Pinned system instructions.', model: { providerId: 'fixture', modelId: 'model' },
        grants: claudeGrants
      })
      expect(claudePrepared.claudeMcpToolNames).toEqual({ 'server-1/ping': 'mcp__fixture__ping' })
      expect(inspectCliCapabilities(input('claude-code', claudeGrants), claudePrepared).supported).toBe(true)
      await claudePrepared.cleanup()

      const linked = join(skillRoot, 'linked')
      const linkedTarget = join(root, 'linked-target')
      mkdirSync(linkedTarget)
      symlinkSync(linkedTarget, linked, process.platform === 'win32' ? 'junction' : 'dir')
      const unsafeWorktree = join(root, 'unsafe-worktree')
      mkdirSync(unsafeWorktree)
      const unsafe = await materializer.prepare({
        agentId: 'run-unsafe', runtimeKind: 'claude-code', worktreePath: unsafeWorktree, projectPath,
        systemPrompt: 'Pinned.', model: { providerId: 'fixture', modelId: 'model' },
        grants: grants({ skills: [{ id: 'skill-selected', source: 'explicit', revision: 'skill-r1', hash: 'skill-h1' }] })
      })
      expect(unsafe.result.unsupportedCapabilities).toEqual(expect.arrayContaining([expect.objectContaining({ level: 'error', message: expect.stringMatching(/symlink/) })]))
      expect(unsafe.result.generatedFiles).toEqual([])
      unlinkSync(linked)

      const collisionWorktree = join(root, 'collision-worktree')
      const collisionPath = join(collisionWorktree, '.mousse', 'agent-runtime', 'opencode.json')
      mkdirSync(join(collisionWorktree, '.mousse', 'agent-runtime'), { recursive: true })
      writeFileSync(collisionPath, '{"agent":{"mousse":{"prompt":"user-owned"}}}\n')
      const collision = await materializer.prepare({
        agentId: 'run-collision', runtimeKind: 'opencode', worktreePath: collisionWorktree, projectPath,
        systemPrompt: 'Replacement.', model: { providerId: 'fixture', modelId: 'model' }, grants: grants()
      })
      expect(collision.openCodeConfigPath).toBeUndefined()
      expect(collision.materializationErrors).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringMatching(/Refused to overwrite/) })]))
      expect(readFileSync(collisionPath, 'utf8')).toContain('user-owned')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports exact permission gaps and consumes qualified runtime config paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mousse-i04-cli-capability-'))
    try {
      const mcpPath = join(root, 'mcp.json'), rulesPath = join(root, 'mousse-agent.mdc'), openCodePath = join(root, 'opencode.json')
      for (const path of [mcpPath, rulesPath, openCodePath]) writeFileSync(path, '{}')
      const claudeInput = input('claude-code', grants({
        builtinTools: [{ id: 'read', source: 'explicit' }],
        mcpTools: [{ id: 'server-1/ping', serverId: 'server-1', toolName: 'ping', source: 'explicit' }]
      }))
      const claudeOptions = { mcpConfigPath: mcpPath, claudeMcpToolNames: { 'server-1/ping': 'mcp__fixture__ping' } }
      expect(inspectCliCapabilities(claudeInput, claudeOptions)).toMatchObject({ supported: true, consumedGrantIds: expect.arrayContaining(['read', 'server-1/ping']) })
      const invocation = buildQualifiedCliInvocation(claudeInput, claudeOptions)
      expect(invocation.args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--mcp-config', mcpPath, '--tools', 'Read', 'mcp__fixture__ping']))
      const capture = join(root, 'capture.mjs')
      writeFileSync(capture, "import { readFileSync } from 'node:fs'; let stdin=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => stdin += c); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin, config: readFileSync(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8') })))")
      const fixtureRuntime = createCliProcessRuntime({
        resolveInvocation: (runtimeInput) => buildQualifiedCliInvocation(runtimeInput, {
          ...claudeOptions,
          commands: { 'claude-code': { command: process.execPath, args: [capture] } }
        })
      })
      const fixtureResult = await fixtureRuntime.run(claudeInput)
      expect(JSON.parse(fixtureResult.text)).toMatchObject({ argv: expect.arrayContaining(['--mcp-config', mcpPath]), stdin: 'Local fixture input.', config: '{}' })
      expect(JSON.parse(fixtureResult.text).argv).not.toContain('Local fixture input.')

      const unsupportedCodex = inspectCliCapabilities(input('codex', grants({ builtinTools: [{ id: 'write', source: 'explicit' }] })))
      expect(unsupportedCodex.supported).toBe(false)
      expect(unsupportedCodex.issues[0]?.code).toBe('unsupported_permission')
      const unsupportedCursor = inspectCliCapabilities(input('cursor-agents-cli', grants({ mcpTools: [{ id: 's/t', serverId: 's', toolName: 't', source: 'explicit' }] })), { cursorRulesPath: rulesPath })
      expect(unsupportedCursor.supported).toBe(false)
      expect(unsupportedCursor.issues.some((issue) => issue.code === 'unsupported_permission')).toBe(true)
      expect(inspectCliCapabilities(input('opencode'), { openCodeConfigPath: openCodePath }).supported).toBe(false)
      const skillReport = inspectCliCapabilities(input('claude-code', grants({ skills: [{ id: 'skill-selected', source: 'explicit' }] })))
      expect(skillReport).toMatchObject({ supported: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'unsupported_permission', grantIds: ['skill-selected'] })]) })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runs owned cleanup after a real CLI process crash', async () => {
    const cleanup = vi.fn(async () => undefined)
    const runtime = createCliProcessRuntime({
      resolveInvocation: () => ({ command: process.execPath, args: ['-e', 'process.exit(17)'], cleanup })
    })
    const resolved = {
      profileId: 'profile-1', definitionId: 'definition-1', revision: 'revision-1', runtimeKind: 'codex' as const,
      settings: { ...defaultAgentSettings({ name: 'CLI fixture', slug: 'cli-fixture' }), limits: { maxTurns: 1, maxToolCalls: 1, maxElapsedMs: 10_000, maxInputTokens: undefined, maxOutputTokens: undefined, maxCostUsd: undefined } },
      instructions: { applicationRules: '', profileProjectContext: '', definitionInstructions: '', workflowNodeInstructions: '', task: 'task', compiled: '' },
      model: { primary: { ref: { providerId: 'fixture', modelId: 'model' }, available: true, efforts: [], speeds: [], contexts: [], capabilities: [], unavailableReasons: [] }, fallbacks: [], capabilityOverrides: {} },
      grants: grants(), dependencyHashes: {}, visual: {}, visualRevision: 'visual', issues: []
    }
    const result = await new AgentExecutionService({ cli: { codex: runtime } }).run({ profileId: 'profile-1', resolved, threadId: 'thread-crash', input: 'run' })
    expect(result.status).toBe('failed')
    expect(cleanup).toHaveBeenCalledTimes(1)

    const report = inspectCliCapabilities(input('codex', grants({ builtinTools: [{ id: 'write', source: 'explicit' }] })))
    const unsupported = await new AgentExecutionService({
      cli: { codex: { run: async () => { throw new CliCapabilityError(report) } } }
    }).run({ profileId: 'profile-1', resolved, threadId: 'thread-capability', input: 'run' })
    expect(unsupported.error).toEqual({
      code: 'CLI_CAPABILITY_UNSUPPORTED',
      message: report.issues.map((issue) => issue.message).join(' '),
      retryable: false,
      details: { report }
    })
  })
})
