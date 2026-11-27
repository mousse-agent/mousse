/**
 * `thread_update access` (tool-api plan §2.4 points 4 and 5): a subagent's direct parent lifts the read-only narrowing it
 * imposed, at the child's next turn or now (its running turn stops and it continues on the same thread). The child's
 * tool list follows (§1.3 "Listing"): its capability revision changes, so its next turn gets a new credential and lists
 * again.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ACCESS_LIFTED_CONTINUE } from '../../src/mms/run/mcp/appTools/thread'
import { refusalOf } from './appToolsFixture'
import { callTool, listTools, VendorAdapter, vendorDaemon, type Mcp, type ToolCallResult, type VendorDaemon, type VendorTurn } from './appToolVendorFixture'
import { waitFor } from './phase6Fixture'

interface ChildTurn { prompt: string; mcp: Mcp; tools: string[] }

describe('thread_update access: a parent lifts its subagent\'s read-only access', () => {
  let d: VendorDaemon | undefined
  afterEach(async () => {
    await d?.dispose()
    d = undefined
  })

  /**
   * A parent thread whose turns run `parentCalls[prompt]` (the delegation on "Delegate it"), and its read-only subagent
   * on the same vendor runtime. The child's first turn runs until it is stopped when `hold` is set.
   */
  const family = async (hold = false) => {
    const childTurns: ChildTurn[] = []
    const results: Record<string, ToolCallResult> = {}
    const calls: Record<string, Record<string, unknown>> = {}
    let childId: string | undefined
    const parents = new Set<string>()
    let held = hold
    const failures: string[] = []
    const vendor = new VendorAdapter(async (turn) => script(turn).catch((error: Error) => {
      failures.push(error.stack ?? error.message)
      throw error
    }))
    const script = async ({ input, mcp }: VendorTurn): Promise<string> => {
      // The child's turn may start before delegate_task returns: it is the thread no parent's turn runs on.
      if (!parents.has(input.threadId)) {
        if (!mcp) throw new Error(`the child's turn has no Mousse server: ${input.prompt}`)
        childTurns.push({ prompt: input.prompt, mcp, tools: await listTools(mcp) })
        // Held: the runtime works until a Stop reaches the run, then ends its turn a moment later.
        if (held) {
          held = false
          await waitFor(() => d!.engine.listRuns(input.threadId).some((run) => run.outcome?.stopRequested === true), 'a Stop', 25_000)
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return 'Reviewed.'
      }
      if (input.prompt === 'Delegate it') {
        const started = await callTool(mcp!, 'delegate_task', {
          prompt: 'Review the change', title: 'Reviewer', provider: 'claude-subscription', model: 'vendor-model',
          workspace: 'shared', role: 'review', readOnly: true, clientRequestId: 'review-1'
        })
        if (started.isError || !started.text) throw new Error(`delegate_task failed: ${started.text ?? JSON.stringify(started.error)}`)
        const { delegationId } = JSON.parse(started.text) as { delegationId?: string }
        if (!delegationId) throw new Error(`delegate_task started nothing: ${started.text}`)
        const delegation = d!.engine.delegations.get(delegationId)!
        childId = delegation.childThreadId
        return 'Delegated.'
      }
      const args = calls[input.prompt]
      if (args) results[input.prompt] = await callTool(mcp!, 'thread_update', { threadId: childId, ...args })
      return 'Done.'
    }
    d = await vendorDaemon([vendor])
    // A read-only subagent needs a folder to be held read-only in: the parent is a project's thread.
    const projectDir = join(d.home, 'project')
    mkdirSync(projectDir)
    const parentId = d.store.createThread('Parent', d.projects.openProject(projectDir).id).id
    d.orch.setThreadModelOverride(parentId, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    parents.add(parentId)
    await d.send('Delegate it', 'agent', parentId)
    await waitFor(() => childTurns.length === 1 || failures.length > 0, 'the child\'s first turn')
    expect(failures).toEqual([])
    const ask = async (prompt: string, args: Record<string, unknown>, mode = 'agent', threadId = parentId) => {
      calls[prompt] = args
      parents.add(threadId)
      await d!.send(prompt, mode, threadId)
      return results[prompt]!
    }
    return { child: () => childId!, childTurns, ask }
  }

  const childRuns = (childId: string) => d!.engine.listRuns(childId)

  it('at its next turn: the child may write, and that turn gets a new credential that lists the tools it now holds', async () => {
    const { child, childTurns, ask } = await family()
    const childId = child()
    await waitFor(() => childRuns(childId).every((run) => run.status === 'completed'), 'the child\'s first turn to end')
    const registry = d!.orch.mcpToolRegistry()
    const before = registry.capabilityRevision(childId)
    expect(d!.orch.mcpToolHost().readOnlyThread!(childId)).toBe(true)
    expect(childTurns[0]!.tools).not.toContain('queue_enqueue')

    // A stale revision changes nothing.
    const stale = await ask('Lift it, stale', { access: { readOnly: false }, expectedRevision: 'not-it' })
    expect(refusalOf(stale)).toMatchObject({ code: 'mousse_conflict', details: { conflict: 'revision_changed', revision: before } })
    expect(d!.orch.mcpToolHost().readOnlyThread!(childId)).toBe(true)

    const lifted = await ask('Lift it', { access: { readOnly: false }, expectedRevision: before })
    expect(lifted.isError).toBeUndefined()
    const body = JSON.parse(lifted.text!)
    expect(body).toMatchObject({ threadId: childId, access: { readOnly: false }, changed: true, applied: 'next_turn' })
    expect(body.revision).toBe(registry.capabilityRevision(childId))
    expect(body.revision).not.toBe(before)
    expect(d!.orch.mcpToolHost().readOnlyThread!(childId)).toBe(false)
    expect(registry.listForThread(childId).map((tool) => tool.name)).toContain('queue_enqueue')

    // Again: nothing to lift.
    expect(JSON.parse((await ask('Lift it again', { access: { readOnly: false } })).text!)).toMatchObject({ changed: false, applied: 'unchanged' })

    // The child's next turn: a new credential (the revision is part of its generation), which lists what it holds now.
    await ask('Tell it', {})
    await d!.send('Go on', 'agent', childId)
    expect(childTurns).toHaveLength(2)
    expect(childTurns[1]!.mcp.token).not.toBe(childTurns[0]!.mcp.token)
    expect(childTurns[1]!.tools).toContain('queue_enqueue')
  }, 30_000)

  it('now: the running turn stops and the child continues on the same thread, told why', async () => {
    const { child, childTurns, ask } = await family(true)
    const childId = child()
    const first = childRuns(childId)[0]!
    expect(first.status).toBe('running')
    const lifted = await ask('Lift it now', { access: { readOnly: false }, apply: 'now' })
    expect(lifted.isError, lifted.text).toBeUndefined()
    const body = JSON.parse(lifted.text!)
    expect(body).toMatchObject({ threadId: childId, access: { readOnly: false }, changed: true, applied: 'now', stoppedRunId: first.runId })
    expect(body.runId).toBeTruthy()
    expect(body.runId).not.toBe(first.runId)
    expect(body.note).toContain('continues now')
    // The follow-up started a turn of its own, after the stopped one ended: it did not wait in the queue a Stop holds.
    await waitFor(() => childTurns.length === 2, 'the child\'s continued turn')
    expect(d!.orch.listQueue(childId)).toEqual([])
    expect(d!.engine.getRun(first.runId)!.status).toBe('interrupted')
    expect(childTurns[1]!.prompt).toContain(ACCESS_LIFTED_CONTINUE)
    expect(childTurns[1]!.tools).toContain('queue_enqueue')
    expect(childTurns[1]!.mcp.token).not.toBe(childTurns[0]!.mcp.token)
  }, 30_000)

  it('only the direct parent lifts it', async () => {
    const { child, ask } = await family()
    const childId = child()
    await waitFor(() => childRuns(childId).every((run) => run.status === 'completed'), 'the child\'s first turn to end')
    const other = d!.store.createThread('Other')
    d!.orch.setThreadModelOverride(other.id, { llmProvider: 'claude-subscription', model: 'vendor-model' })
    const stranger = await ask('Lift it from elsewhere', { access: { readOnly: false } }, 'agent', other.id)
    expect(refusalOf(stranger)).toMatchObject({ code: 'mousse_scope_denied' })
    expect(d!.orch.mcpToolHost().readOnlyThread!(childId)).toBe(true)
    // Making a child read-only later is not this tool's: it starts read-only or not.
    expect((await ask('Narrow it', { access: { readOnly: true } })).text).toMatch(/readOnly: true\} is not available/)
  }, 30_000)
})
