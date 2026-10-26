/**
 * PR 2 app-tool bridge: the registry the Mousse MCP server and the pi loop share sends the same
 * definitions and runs the same handlers the pi loop always had (`LlmClient` on master): same tool
 * list and order per turn, same timeline rows, same result and error texts.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message, Tool, ToolResultMessage } from '@earendil-works/pi-ai'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevGuiTools } from '../../src/mms/devgui/DevGuiTools'
import { getBrowserToolDefinitions } from '../../src/mms/orchestrator/browser'
import { LlmClient, type DelegationToolHost, type LlmChatOptions, type StreamingLlmToolEvent } from '../../src/mms/orchestrator/LlmClient'
import { userMessage } from '../../src/mms/orchestrator/nativeContext'
import { PlanModeTools } from '../../src/mms/orchestrator/PlanModeTools'
import { QuickActionTools } from '../../src/mms/orchestrator/QuickActionTools'
import { WebTools } from '../../src/mms/orchestrator/WebTools'
import {
  createAppToolRegistry,
  delegationToolDefinitions,
  DELEGATION_TOOL_NAMES,
  LISTED_DELEGATION_TOOL_NAMES,
  type AppToolTurn,
  type MousseTool
} from '../../src/mms/run/mcp/appTools'
import { PUBLISH_APPLET_TOOL } from '../../src/mms/run/mcp/appTools/applets'
import { SKILL_TOOLS } from '../../src/mms/run/mcp/appTools/skills'
import { TaskControlTools } from '../../src/mms/tasks/TaskControlTools'
import { TaskQueue } from '../../src/mms/tasks/TaskQueue'
import type { BrowserRuntimePort } from '../../src/shared/browser/runtime'
import { getDefaultSettings } from '../../src/shared/settings'
import { appTurn, fakeAppToolHost } from './appToolsFixture'

const emptyCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

function response(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return {
    role: 'assistant',
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'anthropic-model',
    content,
    stopReason,
    timestamp: Date.now(),
    usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: emptyCost }
  } as AssistantMessage
}

const toolUse = (...calls: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>): AssistantMessage =>
  response(calls.map((call, index) => ({ type: 'toolCall', id: call.id ?? `call-${index + 1}`, name: call.name, arguments: call.arguments ?? {} })), 'toolUse')
const done = (): AssistantMessage => response([{ type: 'text', text: 'done' }], 'stop')

/** One enabled, managed skill the fake registry discovers. */
const SKILL = {
  id: 'demo-skill',
  installationId: 'demo-skill',
  name: 'demo',
  description: 'A demo skill.',
  scope: 'user',
  source: 'mousse',
  paths: [],
  managed: true
}

function fakeSkills() {
  return {
    discover: vi.fn(async () => ({ skills: [SKILL] })),
    readSkill: vi.fn(async () => ({ skill: SKILL, content: '# demo skill' }))
  }
}

interface HarnessInput {
  outputs?: AssistantMessage[]
  tasks?: TaskQueue
  skills?: boolean
  enabledTools?: string[]
  questions?: { requestAnswers: (...args: unknown[]) => Promise<Record<string, string | string[]>>; dismissAllForThread: (threadId: string) => void }
  onPresentPlan?: (payload: { title: string; markdown: string }, threadId?: string) => void
  browserRuntime?: BrowserRuntimePort
}

/** A real `LlmClient` over a fake provider that records the tools every request sends. */
function harness(input: HarnessInput = {}) {
  const settings = getDefaultSettings()
  settings.provider = { llmProvider: 'anthropic', model: 'claude-test' }
  if (input.skills) settings.integrations.skills.enabledSkills = [SKILL.id]
  if (input.enabledTools) settings.integrations.tools.enabledTools = input.enabledTools
  const outputs = [...(input.outputs ?? [done()])]
  const requests: Tool[][] = []
  const models = {
    getModel: (provider: string, id: string) => ({
      id,
      name: id,
      api: 'anthropic-messages',
      provider,
      baseUrl: '',
      reasoning: false,
      input: ['text'],
      cost: emptyCost,
      contextWindow: 128_000,
      maxTokens: 8_000
    }),
    getAuth: async () => ({ apiKey: 'test' }),
    streamSimple: (_model: unknown, context: { tools?: Tool[] }) => {
      requests.push([...(context.tools ?? [])])
      const message = outputs.shift() ?? done()
      return { async *[Symbol.asyncIterator]() {}, result: async () => message }
    }
  }
  const client = new LlmClient(
    { get: () => settings } as never,
    { has: () => true, credentials: { listProviderIds: () => ['anthropic'] }, models } as never,
    { getEnabledTools: async () => [] } as never,
    (input.skills ? fakeSkills() : undefined) as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    input.tasks,
    undefined,
    input.onPresentPlan,
    { ...(input.questions ? { questions: input.questions as never } : {}), ...(input.browserRuntime ? { browserRuntime: input.browserRuntime } : {}) }
  )
  const events: StreamingLlmToolEvent[] = []
  const chat = (options: LlmChatOptions = {}, text = 'go') =>
    client.chat([userMessage(text)], (event) => events.push(event), { threadId: 'thread-1', ...options })
  const names = (index = 0): string[] => (requests[index] ?? []).map((tool) => tool.name)
  return { client, chat, requests, names, events, settings }
}

function toolResults(messages: Message[]): ToolResultMessage[] {
  return messages.filter((message): message is ToolResultMessage => message.role === 'toolResult')
}

const resultText = (message: ToolResultMessage): string =>
  message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')

function hasSymbols(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Object.getOwnPropertySymbols(value).length > 0) return true
  return Object.values(value as Record<string, unknown>).some(hasSymbols)
}

const PI_ALL = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']
const PI_READONLY = ['read', 'grep', 'find', 'ls']
const PLAN = ['ask_user', 'present_plan']
const TASKS = ['list_tasks', 'create_task', 'update_task']
const DEV_GUI = ['mousse_gui_screenshot', 'mousse_gui_console', 'mousse_gui_reload', 'mousse_gui_devtools', 'mousse_gui_evaluate', 'mousse_gui_status']
const WEB = ['web_search', 'web_fetch']
// The legacy order: `delegationToolDefinitions()` keeps definition order, not LISTED_DELEGATION_TOOL_NAMES order.
const DELEGATION = ['delegate_task', 'continue_subagent', 'answer_subagent', 'task_status', 'task_cancel', 'integrate_delegation', 'list_subagents']

const savedDevGui = process.env.MOUSSE_DEV_GUI_TOOLS
beforeEach(() => {
  process.env.MOUSSE_DEV_GUI_TOOLS = '0'
})
afterEach(() => {
  if (savedDevGui === undefined) delete process.env.MOUSSE_DEV_GUI_TOOLS
  else process.env.MOUSSE_DEV_GUI_TOOLS = savedDevGui
})

describe('registry schemas', () => {
  const turn = { ...appTurn({ threadId: 't1', runId: 'r1' }), turnToken: 'tok' } as AppToolTurn
  const { registry } = createAppToolRegistry({ host: fakeAppToolHost().host })
  const extras: Record<string, string[]> = {
    delegate_task: ['modeCeiling', 'clientRequestId'],
    continue_subagent: ['clientRequestId'],
    answer_subagent: ['clientRequestId'],
    integrate_delegation: ['clientRequestId']
  }

  it('registers a definition for every tool but the hidden show_document', () => {
    const missing = registry.list().filter((tool) => !tool.definition).map((tool) => tool.name)
    expect(missing).toEqual(['show_document'])
  })

  it.each(createAppToolRegistry({ host: fakeAppToolHost().host }).registry.list().filter((tool) => tool.definition).map((tool) => [tool.name]))(
    '%s: inputSchema is the plain JSON of its definition, plus only the documented MCP extras',
    (name) => {
      const tool = registry.get(name) as MousseTool
      const expected = JSON.parse(JSON.stringify(tool.definition!(turn).parameters)) as { properties?: Record<string, unknown> }
      const schema = structuredClone(tool.inputSchema) as { properties?: Record<string, unknown> }
      const extra = extras[name] ?? []
      for (const key of extra) {
        expect(schema.properties).toHaveProperty(key)
        expect(expected.properties ?? {}).not.toHaveProperty(key)
        delete schema.properties![key]
      }
      expect(schema).toEqual(expected)
      expect(Object.getOwnPropertySymbols(tool.inputSchema)).toEqual([])
      expect(hasSymbols(tool.inputSchema)).toBe(false)
    }
  )

  it('adds the documented MCP extras with their shapes', () => {
    const props = (name: string) => (registry.get(name)!.inputSchema as { properties: Record<string, Record<string, unknown>> }).properties
    expect(props('delegate_task').modeCeiling).toMatchObject({ type: 'string', enum: ['plan', 'default'] })
    for (const name of Object.keys(extras)) expect(props(name).clientRequestId).toMatchObject({ type: 'string' })
  })
})

describe('in-process definitions are the source classes\' own', () => {
  const turn = { ...appTurn({ threadId: 't1', runId: 'r1' }), turnToken: 'tok' } as AppToolTurn
  const { registry, families } = createAppToolRegistry({ host: fakeAppToolHost().host })
  const definitions = (names: string[]): Tool[] => names.map((name) => registry.get(name)!.definition!(turn))
  const shape = (tools: Tool[]) => tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))

  it('plans: PlanModeTools.getToolDefinitions()', () => {
    const source = new PlanModeTools(async () => ({}), () => {}).getToolDefinitions()
    expect(families.plans.filter((name) => !registry.get(name)!.hidden)).toEqual(source.map((tool) => tool.name))
    expect(shape(definitions(PLAN))).toEqual(shape(source))
  })

  it('tasks: TaskControlTools.getToolDefinitions()', () => {
    const source = new TaskControlTools(new TaskQueue()).getToolDefinitions()
    expect(families.tasks).toEqual(source.map((tool) => tool.name))
    expect(shape(definitions(families.tasks))).toEqual(shape(source))
  })

  it('quick actions: QuickActionTools.getToolDefinitions()', () => {
    const source = new QuickActionTools(async () => false, () => {}).getToolDefinitions()
    expect(families.quickActions).toEqual(source.map((tool) => tool.name))
    expect(shape(definitions(families.quickActions))).toEqual(shape(source))
  })

  it('web: WebTools.getToolDefinitions() (names, parameters; the year in web_search)', () => {
    const source = new WebTools({ read: async () => undefined } as never).getToolDefinitions()
    const ours = definitions(families.web)
    expect(ours.map((tool) => tool.name)).toEqual(source.map((tool) => tool.name))
    expect(ours.map((tool) => tool.parameters)).toEqual(source.map((tool) => tool.parameters))
    expect(ours.find((tool) => tool.name === 'web_search')!.description).toContain(String(new Date().getFullYear()))
    expect(ours.find((tool) => tool.name === 'web_fetch')!.description).toBe(source.find((tool) => tool.name === 'web_fetch')!.description)
  })

  it('dev GUI: DevGuiTools.getToolDefinitions()', () => {
    const source = new DevGuiTools().getToolDefinitions()
    expect(families.devGui).toEqual(source.map((tool) => tool.name))
    expect(shape(definitions(families.devGui))).toEqual(shape(source))
  })

  it('skills: SKILL_TOOLS, the very objects', () => {
    expect(families.skills).toEqual(SKILL_TOOLS.map((tool) => tool.name))
    definitions(families.skills).forEach((tool, index) => expect(tool).toBe(SKILL_TOOLS[index]))
  })

  it('applets: PUBLISH_APPLET_TOOL, the very object', () => {
    expect(families.applets).toEqual(['publish_applet'])
    expect(registry.get('publish_applet')!.definition!(turn)).toBe(PUBLISH_APPLET_TOOL)
  })

  it('delegation: delegationToolDefinitions(), listed and hidden', () => {
    const listed = delegationToolDefinitions()
    expect(listed.map((tool) => tool.name)).toEqual(DELEGATION)
    expect([...listed.map((tool) => tool.name)].sort()).toEqual([...LISTED_DELEGATION_TOOL_NAMES].sort())
    expect(shape(definitions(listed.map((tool) => tool.name)))).toEqual(shape(listed))
    const all = delegationToolDefinitions([...DELEGATION_TOOL_NAMES])
    expect(families.delegation).toEqual(all.map((tool) => tool.name))
    expect(shape(definitions(families.delegation))).toEqual(shape(all))
    for (const name of families.delegation)
      expect(registry.get(name)!.hidden === true).toBe(!(LISTED_DELEGATION_TOOL_NAMES as readonly string[]).includes(name))
  })

  describe('browser: getBrowserToolDefinitions for the turn\'s binding', () => {
    const port = (backend: 'managed-chromium' | 'electron-attached', screenshots: boolean): BrowserRuntimePort => ({
      resolveTarget: () => ({ backend }) as never,
      capabilities: () => ({ screenshots }) as never,
      dispatch: vi.fn(async () => ({ text: 'ok' }) as never)
    })
    const binding = (vision: boolean, allowedTools: string[]) => ({
      mode: 'structured',
      vision,
      execution: { source: 'gui', threadId: 't1' },
      policy: { allowedTools }
    }) as never

    it.each([
      { vision: true, backend: 'managed-chromium' as const, screenshots: true },
      { vision: false, backend: 'electron-attached' as const, screenshots: false }
    ])('vision $vision, $backend', ({ vision, backend, screenshots }) => {
      const runtime = port(backend, screenshots)
      const { registry, families } = createAppToolRegistry({ host: fakeAppToolHost({ browserRuntime: () => runtime }).host })
      const all = [...families.browser]
      const browserTurn = { ...turn, browser: binding(vision, all) } as AppToolTurn
      const expected = getBrowserToolDefinitions({ vision, backend, screenshots })
      const offered = registry.offeredFor(browserTurn).filter((tool) => families.browser.includes(tool.name))
      expect(offered.map((tool) => tool.name)).toEqual(expected.map((tool) => tool.name))
      expect(shape(offered.map((tool) => tool.definition!(browserTurn)))).toEqual(shape(expected))
      // The policy's allowed tools narrow what is offered.
      const narrowTurn = { ...turn, browser: binding(vision, ['browser_open']) } as AppToolTurn
      expect(registry.offeredFor(narrowTurn).filter((tool) => families.browser.includes(tool.name)).map((tool) => tool.name)).toEqual(['browser_open'])
    })
  })
})

describe('LlmClient selection parity', () => {
  let project: string
  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'mousse-app-tools-'))
  })
  afterEach(() => rmSync(project, { recursive: true, force: true }))
  afterAll(() => vi.restoreAllMocks())

  it('(a) agent mode, main thread, with a task queue and one enabled skill: legacy order', async () => {
    process.env.MOUSSE_DEV_GUI_TOOLS = '1'
    const h = harness({ tasks: new TaskQueue(), skills: true })
    await h.chat({ mode: 'agent', projectPath: project })
    expect(h.names()).toEqual([
      'list_skills', 'load_skill',
      ...PI_ALL,
      ...PLAN,
      ...TASKS,
      'create_quick_action',
      ...DEV_GUI,
      ...WEB
    ])
  })

  it('(a1) agent mode without a project, task queue or skills: plan, quick-action and web tools', async () => {
    const h = harness()
    await h.chat({ mode: 'agent' })
    expect(h.names()).toEqual([...PLAN, 'create_quick_action', ...WEB])
  })

  it('(a2) a structured browser binding adds the binding browser tools last, in the legacy order', async () => {
    const browserRuntime: BrowserRuntimePort = {
      resolveTarget: () => ({ backend: 'electron-attached' }) as never,
      capabilities: () => ({ screenshots: false }) as never,
      dispatch: vi.fn(async () => ({ text: 'ok' }) as never)
    }
    const h = harness({ browserRuntime })
    const allowedTools = ['browser_open', 'browser_observe', 'browser_screenshot', 'browser_act', 'browser_extract']
    await h.chat({ mode: 'agent', browser: { mode: 'structured', execution: { source: 'gui', threadId: 'thread-1' }, policy: { allowedTools } } as never })
    // A text-only model: no vision, and this backend reports no screenshots.
    const expected = getBrowserToolDefinitions({ vision: false, backend: 'electron-attached', screenshots: false })
      .filter((tool) => allowedTools.includes(tool.name))
    expect(h.names()).toEqual([...PLAN, 'create_quick_action', ...WEB, 'browser_open', 'browser_observe', 'browser_act', 'browser_extract'])
    expect(h.requests[0]!.slice(-4)).toEqual(expected)
  })

  it('(b) plan mode: read-only coding tools, no skill tools, plan and task tools', async () => {
    const h = harness({ tasks: new TaskQueue(), skills: true })
    await h.chat({ mode: 'plan', projectPath: project })
    expect(h.names()).toEqual([...PI_READONLY, ...PLAN, ...TASKS, 'create_quick_action', ...WEB])
  })

  it('(c) a subagent (build) has no plan, task, quick-action or dev GUI tools', async () => {
    process.env.MOUSSE_DEV_GUI_TOOLS = '1'
    const h = harness({ tasks: new TaskQueue(), skills: true })
    await h.chat({ mode: 'agent', subagent: true, projectPath: project })
    expect(h.names()).toEqual([...PI_ALL, 'git_status', 'git_diff', ...WEB])
  })

  it('(d) Settings without ask_user drops it, and a call to it returns the disabled text', async () => {
    const h = harness({
      enabledTools: getDefaultSettings().integrations.tools.enabledTools.filter((id) => id !== 'ask_user'),
      outputs: [toolUse({ name: 'ask_user', arguments: { questions: [{ id: 'q1', prompt: 'Which?', options: [{ id: 'a', label: 'A' }] }] } }), done()]
    })
    const result = await h.chat({ mode: 'agent' })
    expect(h.names()).toEqual(['present_plan', 'create_quick_action', ...WEB])
    const [toolResult] = toolResults(result.nativeMessages)
    expect(toolResult!.isError).toBe(true)
    expect(resultText(toolResult!)).toBe('Tool "ask_user" is disabled in Settings → Skills & MCP.')
    expect(h.events).toEqual([])
  })

  it('(e) onPublishApplet adds publish_applet after the app tools and before the delegation tools', async () => {
    const h = harness({ tasks: new TaskQueue() })
    await h.chat({ mode: 'agent', onPublishApplet: () => ({ ok: true }), delegation: {} as DelegationToolHost })
    expect(h.names()).toEqual([...PLAN, ...TASKS, 'create_quick_action', ...WEB, 'publish_applet', ...DELEGATION])
    expect(h.requests[0]!.find((tool) => tool.name === 'publish_applet')).toBe(PUBLISH_APPLET_TOOL)
  })

  it('(e2) a subagent never gets publish_applet', async () => {
    const h = harness()
    await h.chat({ mode: 'agent', subagent: true, onPublishApplet: () => ({ ok: true }) })
    expect(h.names()).toEqual([...WEB])
  })

  it('(f) delegation adds the seven listed delegation tools at the end', async () => {
    const h = harness()
    await h.chat({ mode: 'agent', delegation: {} as DelegationToolHost })
    expect(h.names()).toEqual([...PLAN, 'create_quick_action', ...WEB, ...DELEGATION])
    expect(h.requests[0]!.slice(-7)).toEqual(delegationToolDefinitions())
  })
})

describe('LlmClient dispatch parity', () => {
  const askArgs = { questions: [{ id: 'q1', prompt: 'Which one?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }] }

  it('ask_user emits the legacy Plan tool rows and returns the same text', async () => {
    const questions = { requestAnswers: vi.fn(async () => ({ q1: 'a' })), dismissAllForThread: vi.fn() }
    const h = harness({ questions, outputs: [toolUse({ name: 'ask_user', arguments: askArgs }), done()] })
    const result = await h.chat({ mode: 'agent' })
    const legacy = await new PlanModeTools(async () => ({ q1: 'a' }), () => {}).execute('ask_user', askArgs, 'thread-1')
    const [toolResult] = toolResults(result.nativeMessages)
    expect(resultText(toolResult!)).toBe(legacy.text)
    expect(toolResult!.isError).toBe(false)
    expect(questions.requestAnswers).toHaveBeenCalledTimes(1)
    expect((questions.requestAnswers.mock.calls[0] as unknown[])[1]).toBe('thread-1')
    expect(h.events).toEqual([
      {
        kind: 'build_tool_call',
        title: 'Plan tool ask_user',
        summary: 'The assistant called a plan tool.',
        details: ['Tool: ask_user'],
        response: JSON.stringify(askArgs, null, 2),
        phase: 'start',
        callId: 'call-1'
      },
      {
        kind: 'build_tool_result',
        title: 'Plan tool ask_user',
        summary: 'The plan tool returned successfully.',
        details: ['Tool: ask_user'],
        response: legacy.text,
        phase: 'complete',
        callId: 'call-1'
      }
    ])
    expect(result.toolEvents.map((event) => event.title)).toEqual(['Plan tool ask_user', 'Plan tool ask_user'])
  })

  it('present_plan calls onPresentPlan with the thread and returns the legacy text', async () => {
    const onPresentPlan = vi.fn()
    const args = { title: 'Ship it', markdown: '1. Do it' }
    const h = harness({ onPresentPlan, outputs: [toolUse({ name: 'present_plan', arguments: args }), done()] })
    const result = await h.chat({ mode: 'plan' })
    expect(onPresentPlan).toHaveBeenCalledWith({ title: 'Ship it', markdown: '1. Do it' }, 'thread-1')
    const [toolResult] = toolResults(result.nativeMessages)
    expect(resultText(toolResult!)).toBe('Presented plan "Ship it" as an approval card.')
    expect(h.events.map((event) => [event.phase, event.kind, event.title, event.summary])).toEqual([
      ['start', 'build_tool_call', 'Plan tool present_plan', 'The assistant called a plan tool.'],
      ['complete', 'build_tool_result', 'Plan tool present_plan', 'The plan tool returned successfully.']
    ])
  })

  it('create_task emits the legacy Task tool rows and changes the queue', async () => {
    const tasks = new TaskQueue()
    const h = harness({ tasks, outputs: [toolUse({ name: 'create_task', arguments: { description: 'Write tests' } }), done()] })
    const result = await h.chat({ mode: 'agent' })
    expect(tasks.list().map((task) => task.description)).toEqual(['Write tests'])
    const [toolResult] = toolResults(result.nativeMessages)
    expect(toolResult!.isError).toBe(false)
    expect(JSON.parse(resultText(toolResult!))).toMatchObject({ description: 'Write tests' })
    expect(h.events.map((event) => [event.phase, event.kind, event.title, event.summary, event.details])).toEqual([
      ['start', 'build_tool_call', 'Task tool create_task', 'The orchestrator updated the thread task queue.', ['Tool: create_task']],
      ['complete', 'build_tool_result', 'Task tool create_task', 'The task tool returned successfully.', ['Tool: create_task']]
    ])
  })

  it('an unknown tool returns Unknown tool: <name>', async () => {
    const h = harness({ outputs: [toolUse({ name: 'nope_tool' }), done()] })
    const result = await h.chat({ mode: 'agent' })
    const [toolResult] = toolResults(result.nativeMessages)
    expect(toolResult!.isError).toBe(true)
    expect(resultText(toolResult!)).toBe('Unknown tool: nope_tool')
  })

  it('a task tool without a task queue is an unknown tool, as before', async () => {
    const h = harness({ outputs: [toolUse({ name: 'create_task', arguments: { description: 'x' } }), done()] })
    const result = await h.chat({ mode: 'agent' })
    expect(resultText(toolResults(result.nativeMessages)[0]!)).toBe('Unknown tool: create_task')
  })

  it('a delegation call emits Called mousse.delegate_task with the bounded record and no prompt text', async () => {
    const delegateTask = vi.fn(async () => ({ delegationId: 'd1', childThreadId: 'child-1', childRunId: 'run-9', title: 'API reviewer', note: 'Started. LONG NOTE' }))
    const delegation = { delegateTask } as unknown as DelegationToolHost
    const args = { prompt: 'SECRET PROMPT', title: 'API reviewer', workspace: 'shared' }
    const h = harness({ outputs: [toolUse({ name: 'delegate_task', arguments: args }), done()] })
    const result = await h.chat({ mode: 'agent', delegation })
    expect(delegateTask).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'SECRET PROMPT', title: 'API reviewer', workspace: 'shared' }), { toolCallId: 'call-1' })
    expect(h.events.map((event) => [event.phase, event.kind, event.title, event.details, event.callId])).toEqual([
      ['start', 'mcp_tool_call', 'Called mousse.delegate_task', ['Server: mousse', 'Tool: delegate_task'], 'call-1'],
      ['complete', 'mcp_tool_result', 'Called mousse.delegate_task', ['Server: mousse', 'Tool: delegate_task'], 'call-1']
    ])
    expect(h.events[0]!.input).toEqual({ recordVersion: 1, title: 'API reviewer' })
    expect(JSON.parse(h.events[1]!.response!)).toEqual({ delegationId: 'd1', childThreadId: 'child-1', title: 'API reviewer' })
    expect(JSON.stringify(h.events)).not.toMatch(/SECRET PROMPT|LONG NOTE|run-9/)
    expect(JSON.stringify(result.toolEvents)).not.toContain('SECRET PROMPT')
    const [toolResult] = toolResults(result.nativeMessages)
    expect(toolResult!.isError).toBe(false)
    expect(JSON.parse(resultText(toolResult!))).toMatchObject({ delegationId: 'd1' })
  })

  it('a delegation tool without options.delegation is an unknown tool', async () => {
    const h = harness({ outputs: [toolUse({ name: 'delegate_task', arguments: { prompt: 'x', title: 'A', workspace: 'shared' } }), done()] })
    const result = await h.chat({ mode: 'agent' })
    expect(resultText(toolResults(result.nativeMessages)[0]!)).toBe('Unknown tool: delegate_task')
  })
})
