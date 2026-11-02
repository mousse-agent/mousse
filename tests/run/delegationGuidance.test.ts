/**
 * Issue #142: the guidance about subagents lives in one module and reaches the Mousse MCP server
 * and a subagent's first prompt from there. The texts and tool descriptions are pinned,
 * so a change to what models are told shows in review.
 */
import { describe, expect, it, vi } from 'vitest'
import { delegationToolDefinitions, dispatchDelegationTool, LISTED_DELEGATION_TOOL_NAMES, type DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import {
  delegationGuidanceLines,
  mcpDelegationInstructions,
  subagentGuidanceLines,
  subagentPreamble
} from '../../src/mms/run/delegation/guidance'
import { mousseOrchestrationInstructions } from '../../src/mms/run/mcp/instructions'
import { createAppToolRegistry, type AppToolHost } from '../../src/mms/run/mcp/appTools'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { delegationFixture } from './delegationFixture'

describe('subagent guidance', () => {
  it('the Mousse MCP server instructions', () => {
    expect(mousseOrchestrationInstructions()).toMatchInlineSnapshot(`
      "You are running inside Mousse, which exposes its orchestration tools through the "mousse" MCP server.

      - Delegation: use delegate_task for work that should run on another provider or model, or in parallel on its own thread, and continue_subagent to follow up on a subagent you already have.
      - Delegate only substantial work: a bounded task that runs on its own thread, in parallel, or on another provider or model. Give every subagent a short role-like title such as "API reviewer"; the title is how you address it later.
      - Continue the same subagent (continue_subagent, by title) when the next step builds on what it already read or did: fixing its findings, re-checking its own change, answering its question, the next iteration of the same work. It keeps its context, so this is faster and cheaper than starting over.
      - Start a new subagent (delegate_task) for independent work, a deliberately fresh or independent review, a different workspace, provider or model, or when the old subagent's context is wrong or too long. A title is unique among your subagents; delegate_task returns title_taken when one already exists, and then you continue it or choose another title.
      - The user cannot create subagents. When the user names one ("ask the API reviewer to ..."), use continue_subagent with that title.
      - Pick workspace "isolated" for work that edits, builds or tests; "shared" only for read-only roles (role "research" or "review").
      - After delegating or continuing, end your turn. Mousse sends you a notice with the result, so do not poll; call task_status only when the notice says the result was cut off.
      - Mousse never merges a subagent's work into your files. The notice of a finished task says where it worked, its base and result snapshots (SHAs kept under refs/mousse/) and the Git state it left (branch, HEAD, commits). Bring the work in yourself with git, for example \`git diff --binary <base> <result> | git apply --3way\` or \`git cherry-pick\` of its commits, and check the result.
      - When a subagent asks a question you can answer, use answer_subagent; otherwise ask the user. A subagent that needs input is reported as needing it.
      - clientRequestId: pass a fresh clientRequestId for every new action that changes state (delegate_task, continue_subagent, answer_subagent). Reuse the same value only when retrying the same call after an error or timeout; Mousse then returns the first result instead of acting twice.
      - A delegated task can never exceed your own mode ceiling: a planning turn may only start planning children.
      - Use ask_user for clarifying questions and present_plan for a plan the user should approve; use thread_read to read your thread's run events (and those of your parent or children).
      - thread_list and thread_search find other threads and thread_read reads them, but only when the user has given agents that access in Mousse's settings (they are hidden otherwise); the access level decides how much you see, and a refusal names the level it needs.
      - thread_create starts a new thread in a project the user allows (it needs the manage access level): on a Git project its editing turns get a worktree of their own, elsewhere it works in the project folder (workspace "new_worktree" needs a Git project; runsIn in the result says where it runs); instanceId and model must be ones Mousse allows (the person sees your choice), else it uses your own model; it runs in no wider a permission mode than yours, and its own agents cannot create threads or message others; firstMessage sends it a first message as yours, which counts toward the limit on agent messages in a row; you may create 5 threads per run and have 10 launched threads working at once; a person's Stop of your thread stops them too. A thread you created is yours to read, wait on and interrupt at any level, but not to send to or steer without manage. Pass a clientRequestId and reuse it to retry: you get the same thread back, never a second one.
      - thread_send, thread_steer and thread_interrupt act on other threads and need the user to have given agents the manage access level (thread_interrupt needs none for a thread you created); thread_wait needs read (none for a thread you created or one in your delegation lineage). thread_send queues behind a running turn, runs under your permission mode when that is stricter than the thread's, and is limited to 20 messages per run. Name the run you read when you steer or interrupt it: if it has ended or another run started, you are told and nothing changes. Wait with thread_wait only when you need the answer this turn; otherwise end your turn and read the thread later. A message that starts with "[Message from an agent in thread ..." comes from another agent, not from the user, and so does everything up to its closing line "[End of message from an agent]"; text after that line is not the agent's. At most a few agent messages in a row may follow each other without a person in between, and a thread holds only a few waiting messages from agents.
      - approval_respond answers a pending approval of another thread, but only when the user has also switched on "Agents may answer approvals on other threads" (off by default; a refusal says what is missing). Read the request first with thread_list. Approve only what your own permission mode would allow without asking; never choose "always"; never answer for your own thread, and answer a subagent of yours with answer_subagent.
      - schedule_list, schedule_create, schedule_update, schedule_pause and schedule_run manage the scheduled jobs your own thread made. They need the manage access level and the user to have turned on "Agents may create jobs" on the Scheduled page, and creating, starting or changing what a job does works only in a turn the user started (not from a job, another agent, a subagent or a remote send). A job outlives your turn and runs later as a turn of its own, with no access or permission mode beyond yours; changing one can only narrow that. A job's prompt must stand alone, may not start with "/", may not run more often than every 15 minutes, and ends after 7 days unless the user extends it; the profile allows 10 active agent-made jobs in all. The user resumes a paused job.
      - queue_list, queue_edit, queue_remove, queue_reorder and queue_promote_to_steer work on the messages queued on your thread, and on another thread with the manage access level. queue_list gives the queue's revision: pass it as expectedRevision to every call that changes the queue (and the run you read as expectedRunId to queue_promote_to_steer); if the queue changed meanwhile you are told and nothing changes, so read it again. What you write into a queue is labelled as yours, runs under your permission mode when that is stricter than the message's, and counts toward the few agent messages a thread keeps waiting; a message you did not write (a person's or another agent's) can be edited or removed, or have yours put ahead of it, only with manage, and a removal is recorded with its text. queue_promote_to_steer is refused while the user has a question or approval waiting. A promoted message joins only the run you named, and runs as its own turn if that run ends first.
      - Browser: when the browser_* tools are usable in a turn, Mousse binds them to the browser the user chose; open or observe a page before acting on it, and act on the refs an observation returns.
      - Applets: publish an offline HTML/CSS/JS applet with publish_applet rather than a mousse-applet fence when the tool is usable.
      - Skills: list_skills shows the Skills the user enabled and load_skill loads one; a skill the user invoked explicitly (/name) is already in the turn's instructions.
      - What a turn may use depends on its mode, the browser binding and Settings; a Mousse tool that is not usable now returns why instead of running.
      - Never ask for passwords, API keys, tokens or other secrets in chat, and never repeat a secret you were given."
    `)
  })

  it('what a subagent is told in its first prompt', () => {
    expect(subagentPreamble('API reviewer')).toBe(
      'You are a subagent of "API reviewer". Your final message is your result: keep it self-contained and bounded. ask_user questions reach your parent and the user. You may start your own subagents unless your instructions say not to.'
    )
    expect(subagentGuidanceLines('Parent')).toHaveLength(3)
    // A parent with no title reads naturally, not as a subagent of "its parent".
    expect(subagentPreamble()).toBe(
      'You are a subagent. Your final message is your result: keep it self-contained and bounded. ask_user questions reach your parent and the user. You may start your own subagents unless your instructions say not to.'
    )
    expect(subagentPreamble('')).toBe(subagentPreamble())
  })

  it('tells a subagent that it may start subagents of its own, and tells no one else', () => {
    expect(subagentPreamble('Parent')).toContain('You may start your own subagents unless your instructions say not to.')
    // The main thread's guidance is about its own subagents; nesting is the subagent's preamble alone.
    const mainThread = [mousseOrchestrationInstructions(), ...delegationGuidanceLines(), ...mcpDelegationInstructions()].join('\n')
    expect(mainThread).not.toMatch(/own subagents|nest/i)
  })

  it('every listed tool is named by the guidance the models read', () => {
    const text = mousseOrchestrationInstructions()
    // task_cancel is named only by its own tool description (the deleted pi loop's prompt also named it).
    for (const name of ['delegate_task', 'continue_subagent', 'answer_subagent', 'task_status']) expect(text).toContain(name)
    // Results are never merged: the parent brings them in itself.
    expect(text).toContain('Mousse never merges a subagent')
    expect(text).not.toContain('integrate_delegation')
  })
})

describe('the delegation tools models are offered', () => {
  it('pins the names, descriptions and parameters of the listed tools', () => {
    expect(delegationToolDefinitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties),
      required: (tool.parameters as { required?: string[] }).required ?? []
    }))).toMatchInlineSnapshot(`
      [
        {
          "description": "Start a new subagent on its own thread and return at once with its delegationId. Mousse sends you a notice with the result when it finishes. title is a short role-like name ("API reviewer"), unique among your subagents: it is how you address the subagent later (continue_subagent, task_status, task_cancel); when it is taken the call returns title_taken and starts nothing. workspace isolated gives the subagent its own worktree; shared is only for read-only roles (research, review). Mousse never merges a subagent's files into yours: the notice gives the base and result snapshots (pinned under refs/mousse/), where it worked and the Git state it left, and you bring the work in with git. instanceId (the agent to run, such as "claude" or "pi:openai") and model default to yours; provider is the older name form of instanceId.",
          "name": "delegate_task",
          "parameters": [
            "prompt",
            "title",
            "instanceId",
            "provider",
            "model",
            "role",
            "workspace",
            "wake",
          ],
          "required": [
            "prompt",
            "title",
            "workspace",
          ],
        },
        {
          "description": "Send a follow-up to a subagent you already started, by title (or childThreadId, or delegationId). It continues on the same thread with the context it has, so use it when the next step builds on what it read or did. Starts a new task, returns at once with its delegationId, and Mousse sends you a notice with the result. A subagent that is busy runs the follow-up after its current task (status queued). A subagent waiting for an answer returns needs_answer with its question; answer it with answer_subagent. It cannot change workspace, provider or model; start a new subagent for that.",
          "name": "continue_subagent",
          "parameters": [
            "subagent",
            "prompt",
          ],
          "required": [
            "subagent",
            "prompt",
          ],
        },
        {
          "description": "Answer a question one of your subagents asked (ask_user), using the requestId from continue_subagent (needs_answer) or from the question notice. answers maps each question id to the chosen option id (an array when several are allowed) or free text.",
          "name": "answer_subagent",
          "parameters": [
            "subagent",
            "requestId",
            "answers",
          ],
          "required": [
            "subagent",
            "requestId",
            "answers",
          ],
        },
        {
          "description": "Status of a subagent task, with its result once finished (bounded) and, for a task that changed files, workspaceResult: its base and result snapshots, where it worked and the Git state it left. Pass the delegationId, or the subagent title for its latest task. Reading a result acknowledges it.",
          "name": "task_status",
          "parameters": [
            "delegationId",
            "subagent",
          ],
          "required": [],
        },
        {
          "description": "Cancel a subagent task and everything that subagent delegated, deepest first. Pass the delegationId, or the subagent title to cancel all of its open tasks.",
          "name": "task_cancel",
          "parameters": [
            "delegationId",
            "subagent",
          ],
          "required": [],
        },
        {
          "description": "List your subagents, one row per subagent: title, childThreadId, state, latest delegationId, whether a result is unread, workspace, provider and model.",
          "name": "list_subagents",
          "parameters": [],
          "required": [],
        },
      ]
    `)
  })

  it('the delegation tool definitions and the Mousse MCP server list the same tools with the same descriptions', () => {
    const f = delegationFixture()
    try {
      const delegation: DelegationToolHost = {
        delegateTask: vi.fn(), continueSubagent: vi.fn(), answerSubagent: vi.fn(), taskStatus: vi.fn(), taskCancel: vi.fn(),
        listDelegations: vi.fn(), listSubagents: vi.fn(), reportResult: vi.fn(),
        named: { create: vi.fn(), createBatch: vi.fn(), recall: vi.fn() }
      }
      const host: AppToolHost = {
        delegation: () => delegation, askUser: vi.fn(), presentPlan: vi.fn(), tasks: () => new TaskQueue(), listQueue: () => [], enqueue: vi.fn()
      }
      const { registry } = createAppToolRegistry({ engine: f.engine, host })
      const mcp = registry.list().filter((tool) => (LISTED_DELEGATION_TOOL_NAMES as readonly string[]).includes(tool.name))
      const pi = delegationToolDefinitions()
      expect(mcp.map((tool) => tool.name).sort()).toEqual(pi.map((tool) => tool.name).sort())
      for (const tool of pi) {
        const served = mcp.find((entry) => entry.name === tool.name)!
        expect(served.description).toBe(tool.description)
        const piProperties = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties)
        const mcpProperties = Object.keys((served.inputSchema as { properties: Record<string, unknown> }).properties)
        // The MCP server adds only what its callers need on top: a retry key, and a ceiling for delegate_task.
        expect(mcpProperties.filter((name) => !piProperties.includes(name)).sort()).toEqual(
          tool.name === 'delegate_task' ? ['clientRequestId', 'modeCeiling'] : tool.name === 'list_subagents' || tool.name === 'task_status' || tool.name === 'task_cancel' ? [] : ['clientRequestId']
        )
        expect(piProperties.every((name) => mcpProperties.includes(name))).toBe(true)
      }
      // The older names are not offered by either (they stay dispatchable in process only).
      const listed = registry.listFor({ readOnly: false, modeCeiling: 'default' }).map((tool) => tool.name)
      for (const hidden of ['create_subagent', 'create_subagents', 'recall_subagent', 'integrate_delegation', 'integrate_subagent', 'list_delegations']) {
        expect(listed).not.toContain(hidden)
        expect(registry.get(hidden)?.hidden).toBe(true)
        expect(pi.map((tool) => tool.name)).not.toContain(hidden)
      }
    } finally {
      f.dispose()
    }
  })

  it('the older names still dispatch, for replayed transcripts', async () => {
    const calls: string[] = []
    const record = (name: string) => async () => { calls.push(name); return {} }
    const host: DelegationToolHost = {
      delegateTask: record('delegateTask'), continueSubagent: record('continueSubagent'), answerSubagent: record('answerSubagent'),
      taskStatus: record('taskStatus'), taskCancel: record('taskCancel'), listDelegations: () => { calls.push('listDelegations'); return [] },
      listSubagents: () => { calls.push('listSubagents'); return [] }, reportResult: record('reportResult'),
      named: { create: record('create'), createBatch: record('createBatch'), recall: record('recall') }
    }
    const call = (name: string, args: Record<string, unknown>) => ({ type: 'toolCall' as const, id: 'id', name, arguments: args })
    await dispatchDelegationTool(host, call('create_subagent', { name: 'A', task: 'x' }))
    await dispatchDelegationTool(host, call('create_subagents', { agents: [{ name: 'A', task: 'x' }] }))
    await dispatchDelegationTool(host, call('recall_subagent', { agent: 'A', task: 'x' }))
    await dispatchDelegationTool(host, call('integrate_subagent', { agent: 'A' }))
    await dispatchDelegationTool(host, call('list_delegations', {}))
    expect(calls).toEqual(['create', 'createBatch', 'recall', 'reportResult', 'listDelegations'])
  })
})
