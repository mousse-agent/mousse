/**
 * Who and Do (Path step 2): a workflow as Do (its inputs and the `/slug --input`
 * text the scheduler runs), a bot's schedule, and the saved agent a run records.
 */
import { describe, expect, it } from 'vitest'
import { parseWorkflowCommand, workflowCommandText, workflowInputFields } from '../src/shared/workflows/workflowCommand'
import { tokenizeWorkflowCommand } from '../src/shared/workflows/commandTokenizer'
import { ranAgent } from '../src/mms/scheduled/ScheduledJobService'
import { savedAgentRefusal } from '../src/mms/automations/scheduledAgent'
import { asCreateScheduledJobInput, asScheduledJobPatch } from '../src/mms/protocol/validators'
import { jobRecordRun } from '../src/shared/automations'

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
