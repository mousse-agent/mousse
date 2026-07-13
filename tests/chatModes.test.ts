import { describe, expect, it } from 'vitest'
import {
  allowsOrchestrationActions,
  filterActionsForMode,
  getChatModeLabel,
  getSkillIdFromMode,
  normalizeChatMode
} from '../src/shared/chatMode'
import {
  getDefaultSettings,
  resolveModelForMode,
  resolveSkillModelSettings
} from '../src/shared/settings'
import { parseActions, stripActionBlocks, filterActionsForChatMode } from '../src/mms/orchestrator/LlmClient'
import { buildOrchestratorSystemPrompt } from '../src/mms/orchestrator/systemPrompt'
import { BuildModeTools } from '../src/mms/orchestrator/BuildModeTools'
import { FileService } from '../src/mms/files/FileService'
import { GitService } from '../src/mms/git/GitService'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

describe('chat mode helpers', () => {
  it('normalizes missing mode to agent', () => {
    expect(normalizeChatMode()).toBe('agent')
    expect(normalizeChatMode('plan')).toBe('plan')
    expect(normalizeChatMode({ type: 'skill', skillId: 'reviewer' })).toEqual({
      type: 'skill',
      skillId: 'reviewer'
    })
  })

  it('labels built-in and skill modes', () => {
    expect(getChatModeLabel('build')).toBe('Build')
    expect(getChatModeLabel({ type: 'skill', skillId: 'x' }, 'Reviewer')).toBe('Reviewer')
  })

  it('allows orchestration only for agent and skill modes', () => {
    expect(allowsOrchestrationActions('agent')).toBe(true)
    expect(allowsOrchestrationActions('build')).toBe(false)
    expect(allowsOrchestrationActions({ type: 'skill', skillId: 'x' })).toBe(true)
  })

  it('filters orchestration actions outside agent/skill modes', () => {
    const actions = [
      { type: 'spawn_agents', agents: [] },
      { type: 'complete_task' },
      { type: 'message', content: 'ok' }
    ] as const

    expect(filterActionsForMode([...actions], 'build')).toEqual([
      { type: 'message', content: 'ok' }
    ])
    expect(filterActionsForChatMode([...actions], 'agent')).toHaveLength(3)
  })
})

describe('skill model settings', () => {
  it('deep merges default skill model map', () => {
    const defaults = getDefaultSettings()
    expect(defaults.integrations.skills.model).toEqual({})
  })

  it('resolves per-skill model when provider is connected', () => {
    const settings = getDefaultSettings()
    settings.integrations.skills.model.reviewer = {
      llmProvider: 'openai',
      model: 'gpt-4.1'
    }
    settings.provider = { llmProvider: 'anthropic', model: 'claude-sonnet-4' }

    expect(resolveSkillModelSettings(settings, 'reviewer')).toEqual({
      llmProvider: 'openai',
      model: 'gpt-4.1'
    })
    expect(resolveModelForMode(settings, { type: 'skill', skillId: 'reviewer' }, ['openai'])).toEqual({
      llmProvider: 'openai',
      model: 'gpt-4.1'
    })
  })

  it('falls back to global orchestrator model when skill provider is disconnected', () => {
    const settings = getDefaultSettings()
    settings.integrations.skills.model.reviewer = {
      llmProvider: 'openai',
      model: 'gpt-4.1'
    }
    settings.provider = { llmProvider: 'anthropic', model: 'claude-sonnet-4' }

    expect(resolveModelForMode(settings, { type: 'skill', skillId: 'reviewer' }, ['anthropic'])).toEqual({
      llmProvider: 'anthropic',
      model: 'claude-sonnet-4'
    })
  })
})

describe('mode-aware prompts and plan output', () => {
  it('builds distinct system prompts per mode', () => {
    const agentPrompt = buildOrchestratorSystemPrompt({ mode: 'agent' })
    const cursorAgentPrompt = buildOrchestratorSystemPrompt({ mode: 'agent', providerId: 'cursor' })
    const planPrompt = buildOrchestratorSystemPrompt({ mode: 'plan' })
    const buildPrompt = buildOrchestratorSystemPrompt({ mode: 'build' })

    expect(agentPrompt).toContain('"type": "spawn_agents"')
    expect(cursorAgentPrompt).not.toContain('"type": "spawn_agents"')
    expect(cursorAgentPrompt).toContain('official Mousse session configuration')
    expect(planPrompt).toContain('ask_user')
    expect(planPrompt).toContain('show_document')
    expect(planPrompt).toContain('markdown only')
    expect(buildPrompt).toContain('read')
    expect(buildPrompt).toContain('edit')
    expect(buildPrompt).toContain('grep')
    expect(buildPrompt).toContain('Do not spawn CLI agents')
  })

  it('parses and strips orchestration action blocks', () => {
    const response = `Here is the plan.

\`\`\`json
{ "actions": [ { "type": "spawn_agents", "agents": [] } ] }
\`\`\``

    expect(parseActions(response)).toHaveLength(1)
    expect(stripActionBlocks(response)).toBe('Here is the plan.')
  })

  it('extracts skill id from skill chat mode', () => {
    expect(getSkillIdFromMode({ type: 'skill', skillId: 'canvas' })).toBe('canvas')
    expect(getSkillIdFromMode('agent')).toBeUndefined()
  })
})

describe('BuildModeTools', () => {
  it('runs commands in the project root and blocks dangerous commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mousse-build-'))
    const tools = new BuildModeTools(new FileService(), new GitService())

    try {
      await writeFile(join(root, 'marker.txt'), 'hello', 'utf-8')

      const readResult = await tools.execute('read_file', { path: 'marker.txt' }, root)
      expect(readResult.isError).toBe(false)
      expect(readResult.text).toBe('hello')

      const blocked = await tools.runCommand(root, 'rm', ['-rf', '/'])
      expect(blocked.isError).toBe(true)
      expect(blocked.text).toContain('Blocked command')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('PiCodingTools', () => {
  it('exposes the full Pi SDK tool set and executes read/edit/grep/find/ls', async () => {
    const { PiCodingTools } = await import('../src/mms/orchestrator/PiCodingTools')
    const root = await mkdtemp(join(tmpdir(), 'mousse-pi-tools-'))
    const tools = new PiCodingTools()

    try {
      await writeFile(join(root, 'marker.txt'), 'hello world\nsecond line\n', 'utf-8')

      const defs = await tools.getToolDefinitions(root, 'all')
      expect(defs.map((t) => t.name).sort()).toEqual(
        ['bash', 'edit', 'find', 'grep', 'ls', 'read', 'write'].sort()
      )

      const readResult = await tools.execute('read', { path: 'marker.txt' }, root)
      expect(readResult.isError).toBe(false)
      expect(readResult.text).toContain('hello world')

      const editResult = await tools.execute(
        'edit',
        { path: 'marker.txt', edits: [{ oldText: 'hello', newText: 'hi' }] },
        root
      )
      expect(editResult.isError).toBe(false)

      const grepResult = await tools.execute('grep', { pattern: 'hi world', path: '.' }, root)
      expect(grepResult.isError).toBe(false)
      expect(grepResult.text).toContain('marker.txt')

      const findResult = await tools.execute('find', { pattern: 'marker.txt' }, root)
      expect(findResult.isError).toBe(false)
      expect(findResult.text).toContain('marker.txt')

      const lsResult = await tools.execute('ls', { path: '.' }, root)
      expect(lsResult.isError).toBe(false)
      expect(lsResult.text).toContain('marker.txt')

      // Legacy aliases still work
      const legacy = await tools.execute('read_file', { path: 'marker.txt' }, root)
      expect(legacy.isError).toBe(false)
      expect(legacy.text).toContain('hi world')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
