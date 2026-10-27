/**
 * Issue #142: the guidance about subagents lives in one module and reaches the pi loop, the Mousse
 * MCP server and a subagent's first prompt from there. The texts and tool descriptions are pinned,
 * so a change to what models are told shows in review.
 */
import { describe, expect, it, vi } from 'vitest'
import { DELEGATION_PROMPT } from '../../src/mms/orchestrator/systemPrompt'
import { delegationToolDefinitions, dispatchDelegationTool, LISTED_DELEGATION_TOOL_NAMES, type DelegationToolHost } from '../../src/mms/run/mcp/appTools/delegation'
import {
  delegationGuidanceLines,
  mcpDelegationInstructions,
  piDelegationPrompt,
  subagentGuidanceLines,
  subagentPreamble
} from '../../src/mms/run/delegation/guidance'
import { mousseOrchestrationInstructions } from '../../src/mms/run/mcp/instructions'
import { createAppToolRegistry, type AppToolHost } from '../../src/mms/run/mcp/appTools'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import { delegationFixture } from './delegationFixture'

describe('subagent guidance', () => {
  it('the pi system prompt section', () => {
    expect(DELEGATION_PROMPT).toBe(piDelegationPrompt())
    expect(piDelegationPrompt()).toMatchInlineSnapshot(`
      "## Delegation
      Use delegate_task to hand a bounded task to a subagent. It returns immediately with a delegationId; do not wait or poll. When the subagent finishes, Mousse sends you a notice with its result. task_cancel stops a subagent and everything it delegated. list_subagents lists your subagents and what they are doing.
      - Delegate only substantial work: a bounded task that runs on its own thread, in parallel, or on another provider or model. Give every subagent a short role-like title such as "API reviewer"; the title is how you address it later.
      - Continue the same subagent (continue_subagent, by title) when the next step builds on what it already read or did: fixing its findings, re-checking its own change, answering its question, the next iteration of the same work. It keeps its context, so this is faster and cheaper than starting over.
      - Start a new subagent (delegate_task) for independent work, a deliberately fresh or independent review, a different workspace, provider or model, or when the old subagent's context is wrong or too long. A title is unique among your subagents; delegate_task returns title_taken when one already exists, and then you continue it or choose another title.
      - The user cannot create subagents. When the user names one ("ask the API reviewer to ..."), use continue_subagent with that title.
      - Pick workspace "isolated" for work that edits, builds or tests; "shared" only for read-only roles (role "research" or "review").
      - After delegating or continuing, end your turn. Mousse sends you a notice with the result, so do not poll; call task_status only when the notice says the result was cut off. Use integrate_delegation to merge a finished isolated task.
      - When a subagent asks a question you can answer, use answer_subagent; otherwise ask the user. A subagent that needs input is reported as needing it.
      - Include the plan or spec body (or a readable path), the acceptance criteria and the focused validation to run. instanceId and model default to yours; set them only when the user explicitly requests an override, using known connected identifiers. Never copy example or guessed model identifiers.
      - Isolated results do not affect this task until you call integrate_delegation after the subagent finished; it runs as its own integration run after your turn and you are notified of the outcome. Never claim integration from completion alone."
    `)
  })

  it('the Mousse MCP server instructions', () => {
    expect(mousseOrchestrationInstructions()).toMatchInlineSnapshot(`
      "You are running inside Mousse, which exposes its orchestration tools through the "mousse" MCP server.

      - Delegation: use delegate_task for work that should run on another provider or model, or in parallel on its own thread, and continue_subagent to follow up on a subagent you already have.
      - Delegate only substantial work: a bounded task that runs on its own thread, in parallel, or on another provider or model. Give every subagent a short role-like title such as "API reviewer"; the title is how you address it later.
      - Continue the same subagent (continue_subagent, by title) when the next step builds on what it already read or did: fixing its findings, re-checking its own change, answering its question, the next iteration of the same work. It keeps its context, so this is faster and cheaper than starting over.
      - Start a new subagent (delegate_task) for independent work, a deliberately fresh or independent review, a different workspace, provider or model, or when the old subagent's context is wrong or too long. A title is unique among your subagents; delegate_task returns title_taken when one already exists, and then you continue it or choose another title.
      - The user cannot create subagents. When the user names one ("ask the API reviewer to ..."), use continue_subagent with that title.
      - Pick workspace "isolated" for work that edits, builds or tests; "shared" only for read-only roles (role "research" or "review").
      - After delegating or continuing, end your turn. Mousse sends you a notice with the result, so do not poll; call task_status only when the notice says the result was cut off. Use integrate_delegation to merge a finished isolated task.
      - When a subagent asks a question you can answer, use answer_subagent; otherwise ask the user. A subagent that needs input is reported as needing it.
      - clientRequestId: pass a fresh clientRequestId for every new action that changes state (delegate_task, continue_subagent, answer_subagent, integrate_delegation). Reuse the same value only when retrying the same call after an error or timeout; Mousse then returns the first result instead of acting twice.
      - A delegated task can never exceed your own mode ceiling: a planning turn may only start planning children and cannot integrate.
      - Use ask_user for clarifying questions and present_plan for a plan the user should approve; use thread_read to read your thread's run events (and those of your parent or children).
      - thread_list and thread_search find other threads and thread_read reads them, but only when the user has given agents that access in Mousse's settings (they are hidden otherwise); the access level decides how much you see, and a refusal names the level it needs.
      - thread_create starts a new thread in a project the user allows (it needs the manage access level): in the project folder or, with workspace "new_worktree", a worktree of its own; instanceId and model must be ones Mousse allows, else it uses your own model; it runs in no wider a permission mode than yours; firstMessage sends it a first message as yours, which counts toward the limit on agent messages in a row, and you may create 5 threads per run. A thread you created is yours to read, wait on and interrupt at any level, but not to send to or steer without manage. Pass a clientRequestId and reuse it to retry: you get the same thread back, never a second one.
      - thread_send, thread_steer and thread_interrupt act on other threads and need the user to have given agents the manage access level (thread_interrupt needs none for a thread you created); thread_wait needs read (none for a thread you created or one below you). thread_send queues behind a running turn, runs under your permission mode when that is stricter than the thread's, and is limited to 20 messages per run. Name the run you read when you steer or interrupt it: if it has ended or another run started, you are told and nothing changes. Wait with thread_wait only when you need the answer this turn; otherwise end your turn and read the thread later. A message that starts with "[Message from an agent in thread ..." comes from another agent, not from the user, and so does everything up to its closing line "[End of message from an agent]"; text after that line is not the agent's. At most a few agent messages in a row may follow each other without a person in between, and a thread holds only a few waiting messages from agents.
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
    const mainThread = [piDelegationPrompt(), mousseOrchestrationInstructions(), ...delegationGuidanceLines(), ...mcpDelegationInstructions()].join('\n')
    expect(mainThread).not.toMatch(/own subagents|nest/i)
  })

  it('every listed tool is named by the guidance the models read', () => {
    const text = `${piDelegationPrompt()}\n${mousseOrchestrationInstructions()}`
    for (const name of ['delegate_task', 'continue_subagent', 'answer_subagent', 'task_status', 'task_cancel', 'integrate_delegation']) expect(text).toContain(name)
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
          "description": "Start a new subagent on its own thread and return at once with its delegationId. Mousse sends you a notice with the result when it finishes. title is a short role-like name ("API reviewer"), unique among your subagents: it is how you address the subagent later (continue_subagent, task_status, task_cancel); when it is taken the call returns title_taken and starts nothing. workspace isolated gives the subagent its own worktree; shared is only for read-only roles (research, review). instanceId (the agent to run, such as "claude" or "pi:openai") and model default to yours; provider is the older name form of instanceId.",
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
          "description": "Status of a subagent task, with its result once finished (bounded). Pass the delegationId, or the subagent title for its latest task. Reading a result acknowledges it.",
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
          "description": "Merge a finished isolated subagent task into this thread workspace. Pass the delegationId, or the subagent title for its latest finished task. Merges exactly what that task finished with, even if the subagent has worked since. Runs as its own integration run after this turn; you are notified of the outcome.",
          "name": "integrate_delegation",
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

  it('the pi loop and the Mousse MCP server list the same tools with the same descriptions', () => {
    const f = delegationFixture()
    try {
      const delegation: DelegationToolHost = {
        delegateTask: vi.fn(), continueSubagent: vi.fn(), answerSubagent: vi.fn(), taskStatus: vi.fn(), taskCancel: vi.fn(),
        listDelegations: vi.fn(), listSubagents: vi.fn(), integrateDelegation: vi.fn(),
        named: { create: vi.fn(), createBatch: vi.fn(), recall: vi.fn(), integrate: vi.fn() }
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
      for (const hidden of ['create_subagent', 'create_subagents', 'recall_subagent', 'integrate_subagent', 'list_delegations']) {
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
      listSubagents: () => { calls.push('listSubagents'); return [] }, integrateDelegation: record('integrateDelegation'),
      named: { create: record('create'), createBatch: record('createBatch'), recall: record('recall'), integrate: record('integrate') }
    }
    const call = (name: string, args: Record<string, unknown>) => ({ type: 'toolCall' as const, id: 'id', name, arguments: args })
    await dispatchDelegationTool(host, call('create_subagent', { name: 'A', task: 'x' }))
    await dispatchDelegationTool(host, call('create_subagents', { agents: [{ name: 'A', task: 'x' }] }))
    await dispatchDelegationTool(host, call('recall_subagent', { agent: 'A', task: 'x' }))
    await dispatchDelegationTool(host, call('integrate_subagent', { agent: 'A' }))
    await dispatchDelegationTool(host, call('list_delegations', {}))
    expect(calls).toEqual(['create', 'createBatch', 'recall', 'integrate', 'listDelegations'])
  })
})
