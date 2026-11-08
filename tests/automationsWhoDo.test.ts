/**
 * Who and Do (Path step 2): what the pickers offer and send, a workflow as Do (its inputs and the `/slug --input`
 * text the scheduler runs), a bot's schedule, and the saved agent a run records.
 */
import { describe, expect, it } from 'vitest'
import { botWhen, libraryFrom, matchWorkflows, parseWhoKey, whoKey, whoOptions } from '../src/renderer/components/automations/whoDo'
import { parseWorkflowCommand, workflowCommandText, workflowInputFields, workflowInputsReady } from '../src/shared/workflows/workflowCommand'
import { tokenizeWorkflowCommand } from '../src/shared/workflows/commandTokenizer'
import { ranAgent } from '../src/mms/scheduled/ScheduledJobService'
import { savedAgentRefusal } from '../src/mms/automations/scheduledAgent'
import { asCreateScheduledJobInput, asScheduledJobPatch } from '../src/mms/protocol/validators'
import { jobRecordRun } from '../src/shared/automations'
import type { AgentDefinitionSummary } from '../src/shared/agents/types'

describe('Who', () => {
  const library = libraryFrom({
    agents: [
      { id: 'a', name: 'PR reviewer', publishedRevision: 'r1', enabled: true, archived: false },
      { id: 'b', name: 'Unpublished', enabled: true, archived: false },
      { id: 'c', name: 'Off', publishedRevision: 'r1', enabled: false, archived: false }
    ] as unknown as AgentDefinitionSummary[],
    workflows: [
      { id: 'w', slug: 'release-notes', name: 'Release notes', enabled: true, headRevisionId: 'h' },
      { id: 'x', slug: 'draft-only', name: 'Draft only', enabled: true, headRevisionId: null }
    ],
    bots: [{ id: 'bot_1', name: 'Pip', look: { colour: 'teal', accessory: 'none' } }]
  })

  it('offers only what can run now: published, turned-on saved agents and workflows', () => {
    expect(library.agents.map((agent) => agent.name)).toEqual(['PR reviewer'])
    expect(library.workflows.map((workflow) => workflow.slug)).toEqual(['release-notes'])
  })

  it('lists the default agent first, then models, saved agents and (on the create row) bots', () => {
    const models = [{ label: 'Claude', choices: [{ key: 'claude\u0000sonnet', label: 'Sonnet', selection: { instanceId: 'claude', llmProvider: 'anthropic', model: 'sonnet' } }] }]
    const options = whoOptions({ defaultName: 'Claude', models, library, withBots: true })
    expect(options.map((option) => [option.value, option.group ?? ''])).toEqual([
      ['default', ''], ['model:claude\u0000sonnet', 'Claude'], ['agent:a', 'Saved agents'], ['bot:bot_1', 'Bots']
    ])
    expect(whoOptions({ defaultName: 'Claude', models, library, withBots: false }).some((option) => option.value.startsWith('bot:'))).toBe(false)
    // A chosen agent that is gone stays listed, so the choice is never silently lost.
    expect(whoOptions({ defaultName: 'Claude', models: [], library, withBots: false, current: { key: 'agent:gone', label: 'Old agent' } }).at(-1)).toEqual({ value: 'agent:gone', label: 'Old agent' })
  })

  it('writes a choice as one value and reads it back', () => {
    for (const who of [{ kind: 'default' }, { kind: 'model', key: 'claude\u0000sonnet:1' }, { kind: 'agent', id: 'a' }, { kind: 'bot', id: 'bot_1' }] as const) {
      expect(parseWhoKey(whoKey(who))).toEqual(who)
    }
  })

  it('gives a bot only a repeating schedule, at most every 5 minutes', () => {
    expect(botWhen({ kind: 'cron', expr: '0 8 * * *' })).toEqual({ ok: true, when: { kind: 'cron', expr: '0 8 * * *' } })
    expect(botWhen({ kind: 'interval', minutes: 30 })).toEqual({ ok: true, when: { kind: 'interval', minutes: 30 } })
    expect(botWhen({ kind: 'interval', minutes: 2 })).toMatchObject({ ok: false })
    expect(botWhen({ kind: 'manual' })).toMatchObject({ ok: false, reason: expect.stringMatching(/A bot repeats/) })
    expect(botWhen({ kind: 'once', runAt: '2026-12-01T09:00:00.000Z' })).toMatchObject({ ok: false })
  })
})

describe('Do: a workflow', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      tag: { type: 'string' as const, title: 'Tag' },
      count: { type: 'integer' as const },
      draft: { type: 'boolean' as const },
      channel: { $ref: '#/$defs/channel' }
    },
    required: ['tag'],
    $defs: { channel: { type: 'string' as const, enum: ['eng', 'all'] } }
  }

  it('reads its input fields from its schema', () => {
    expect(workflowInputFields(schema)).toEqual([
      { key: 'tag', label: 'Tag', type: 'string', required: true },
      { key: 'count', label: 'count', type: 'integer', required: false },
      { key: 'draft', label: 'draft', type: 'boolean', required: false },
      { key: 'channel', label: 'channel', type: 'string', required: false, options: ['eng', 'all'] }
    ])
  })

  it('writes /slug --input value that the daemon tokenizes back to the same values', () => {
    const fields = workflowInputFields(schema)
    const text = workflowCommandText('release-notes', { tag: 'v1.2 "beta"', count: '3', draft: 'true', channel: '' }, fields)
    expect(text).toBe('/release-notes --tag "v1.2 \\"beta\\"" --count 3 --draft')
    expect(tokenizeWorkflowCommand(text).map((token) => token.value)).toEqual(['/release-notes', '--tag', 'v1.2 "beta"', '--count', '3', '--draft'])
    expect(parseWorkflowCommand(text)).toEqual({ slug: 'release-notes', values: { tag: 'v1.2 "beta"', count: '3', draft: 'true' } })
    expect(parseWorkflowCommand('review open PRs')).toBeNull()
  })

  it('is ready once every required input has a value', () => {
    const fields = workflowInputFields(schema)
    expect(workflowInputsReady(fields, {})).toBe(false)
    expect(workflowInputsReady(fields, { tag: 'v1' })).toBe(true)
  })

  it('is offered when the line starts with /', () => {
    const workflows = [{ id: 'w', slug: 'release-notes', name: 'Release notes', revisionId: 'h' }, { id: 'v', slug: 'deploy', name: 'Deploy', revisionId: 'h' }]
    expect(matchWorkflows('/', workflows)).toHaveLength(2)
    expect(matchWorkflows('/rel', workflows).map((workflow) => workflow.slug)).toEqual(['release-notes'])
    expect(matchWorkflows('every day /rel', workflows)).toEqual([])
  })
})

describe('a job whose Who is a saved agent', () => {
  it('is saved and patched with a reference to the agent, and nothing else', () => {
    expect(asCreateScheduledJobInput({ name: 'a', prompt: 'b', schedule: { kind: 'manual' }, agent: { definitionId: 'agent-1' } }).agent).toEqual({ definitionId: 'agent-1' })
    expect(() => asCreateScheduledJobInput({ name: 'a', prompt: 'b', schedule: { kind: 'manual' }, agent: { definitionId: 'agent-1', revision: 'r' } })).toThrow(/agent.revision is not allowed/)
    expect(asScheduledJobPatch({ agent: null }).agent).toBeNull()
  })

  it('marks a run "agent changed" when the agent was published again since its last run', () => {
    const agent = { definitionId: 'agent-1', name: 'PR reviewer', revision: 'r2' }
    expect(ranAgent({ runHistory: [] }, agent)).toEqual(agent)
    expect(ranAgent({ runHistory: [{ runAt: '', status: 'ok', agent: { ...agent, revision: 'r1' } }] }, agent)).toEqual({ ...agent, changed: true })
    expect(ranAgent({ runHistory: [{ runAt: '', status: 'ok', agent }, { runAt: '', status: 'ok' }] }, agent)).toEqual(agent)
    // Each run says who actually ran it.
    expect(jobRecordRun({ runAt: '2026-11-08T09:00:00.000Z', status: 'ok', agent: { ...agent, changed: true } })).toMatchObject({ state: 'done', ranBy: 'PR reviewer', agentChanged: true })
    expect(jobRecordRun({ runAt: '2026-11-08T09:00:00.000Z', status: 'ok', selection: { llmProvider: 'anthropic', model: 'sonnet' } })).toMatchObject({ ranBy: 'sonnet' })
  })

  it('says why a saved agent cannot run', () => {
    expect(savedAgentRefusal({ flags: { enabled: true, archived: false }, published: { revision: 'r' } }, 'PR reviewer')).toBeUndefined()
    expect(savedAgentRefusal({ flags: { enabled: true, archived: false } }, 'PR reviewer')).toBe('Publish PR reviewer before an automation runs it.')
    expect(savedAgentRefusal({ flags: { enabled: false, archived: false }, published: { revision: 'r' } }, 'PR reviewer')).toMatch(/turned off/)
    expect(savedAgentRefusal({ flags: { enabled: true, archived: true }, published: { revision: 'r' } }, 'PR reviewer')).toMatch(/archived/)
  })
})
