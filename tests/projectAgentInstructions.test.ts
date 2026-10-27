import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendProjectAgentInstructions } from '../src/mms/orchestrator/projectInstructions'
import { AgentExecutionService } from '../src/mms/agentDefinitions/AgentExecutionService'
import {
  providerResponse, resolvedDefinition
} from './fixtures/agent-platform/agent-runtime-policy/helpers'
import { disposeDefinitionRuns, runDefinition } from './fixtures/agent-platform/definitionRun'

const roots: string[] = []
function project(instructions?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'mousse-project-agents-'))
  roots.push(root)
  if (instructions !== undefined) writeFileSync(join(root, 'AGENTS.md'), instructions)
  return root
}

afterEach(async () => {
  disposeDefinitionRuns()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('project AGENTS.md system instructions', () => {
  it('rereads updates and isolates project, worktree and projectless turns', () => {
    const root = project('PROJECT A')
    const worktree = project('WORKTREE B')
    expect(appendProjectAgentInstructions('base', root)).toContain('PROJECT A')
    writeFileSync(join(root, 'AGENTS.md'), 'UPDATED A')
    expect(appendProjectAgentInstructions('base', root)).toContain('UPDATED A')
    expect(appendProjectAgentInstructions('base', worktree)).not.toContain('UPDATED A')
    expect(appendProjectAgentInstructions('base', worktree)).toContain('WORKTREE B')
    expect(appendProjectAgentInstructions('base')).toBe('base')
  })

  it('tolerates missing, blank and unreadable instruction files', () => {
    const missing = project()
    const blank = project(' \n\t')
    const unreadable = project()
    mkdirSync(join(unreadable, 'AGENTS.md'))
    for (const root of [missing, blank, unreadable]) {
      expect(appendProjectAgentInstructions('base', root)).toBe('base')
    }
  })

  it('sends instructions through the agent-definition system prompt without duplicating them', async () => {
    const root = project('NAMED AGENT PROJECT INSTRUCTIONS')
    const { captured, pending } = runDefinition(resolvedDefinition(), [providerResponse([{ type: 'text', text: 'done' }], 'stop')], {
      projectPath: root, host: { workspaceRoots: [root] }, input: 'inspect'
    })
    const result = await pending
    expect(result.status).toBe('completed')
    expect(captured[0]?.systemPrompt).toContain('You are a reviewer.')
    expect(captured[0]?.systemPrompt?.split('NAMED AGENT PROJECT INSTRUCTIONS')).toHaveLength(2)
    expect(captured[0]?.messages).toEqual([expect.objectContaining({ role: 'user', content: 'inspect' })])
  })

  it('uses the validated workspace root when the host omits projectPath', async () => {
    const root = project('WORKSPACE ROOT INSTRUCTIONS')
    let actualPrompt = ''
    const service = new AgentExecutionService({ runtime: { run: async (input) => {
      actualPrompt = input.systemPrompt
      return { text: 'done' }
    } } })
    const result = await service.run({
      profileId: 'profile-1', resolved: resolvedDefinition(), threadId: 'host-thread', input: 'inspect',
      host: { workspaceRoots: [root] }
    })
    expect(result.status).toBe('completed')
    expect(actualPrompt).toContain('WORKSPACE ROOT INSTRUCTIONS')
  })

  it('honors the agent definition setting that excludes project instructions', async () => {
    const root = project('EXCLUDED PROJECT INSTRUCTIONS')
    const resolved = resolvedDefinition()
    resolved.settings.context.includeProjectInstructions = false
    let actualPrompt = ''
    await new AgentExecutionService({ runtime: { run: async (input) => {
      actualPrompt = input.systemPrompt
      return { text: 'done' }
    } } }).run({
      profileId: 'profile-1', resolved, threadId: 'excluded-thread', projectPath: root, input: 'inspect'
    })
    expect(actualPrompt).not.toContain('EXCLUDED PROJECT INSTRUCTIONS')
  })
})
