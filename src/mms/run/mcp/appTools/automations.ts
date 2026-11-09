import { AutomationDraftError, type AutomationDrafts, type DraftAuthor } from '../../../automations/AutomationDrafts'
import type { AppToolHost } from './host'
import { json, McpToolError, type MousseTool, type ToolCallContext, type ToolOutcome } from './types'

/** What the automation tools reach: the drafts service, and who the caller is. Read at every call. */
export interface AutomationToolHost {
  drafts: AutomationDrafts
  /** Whether the thread is a profile's hidden Automation manager thread. */
  isManagerThread(threadId: string): boolean
  /** The folder the manager's turns work in (`automationManagerWorkspace`). */
  managerWorkspace?(): string
  /** The bot whose thread this is, on a bot's turn. */
  botOf(threadId: string): string | undefined
}

/** The tools' names: a bot may be granted them (`BOT_APP_TOOLS`); its first use asks the owner. */
export const AUTOMATION_TOOL_NAMES = ['automation_draft_save', 'automation_ask', 'automation_list', 'automation_update', 'automation_pause'] as const

const TRIGGER_SCHEMA = {
  type: 'object',
  description:
    'What starts it. {kind:"time", schedule:{kind:"cron", expr:"0 5 * * 4"}} (five-field cron on this computer\'s clock), {kind:"time", schedule:{kind:"interval", minutes:60}}, {kind:"time", schedule:{kind:"once", runAt:"<ISO time>"}}; {kind:"cli", name?} (started by `mousse-cli automation run <name>`); {kind:"http"} (a signed request; the person sets up its URL after Turn on); {kind:"thread_event", threadId, events:["checks_failed"|"checks_passed"|"review"|"comment"]} (a thread\'s pull request).',
  properties: {
    kind: { type: 'string', enum: ['time', 'cli', 'http', 'thread_event'] },
    schedule: { type: 'object', properties: { kind: { type: 'string', enum: ['cron', 'interval', 'once'] }, expr: { type: 'string' }, minutes: { type: 'integer', minimum: 1 }, runAt: { type: 'string' } }, required: ['kind'] },
    name: { type: 'string' },
    threadId: { type: 'string' },
    events: { type: 'array', items: { type: 'string', enum: ['checks_failed', 'checks_passed', 'review', 'comment'] } }
  },
  required: ['kind']
}

const RESULT_SCHEMA = {
  type: 'object',
  description: 'Where the outcome goes: thread "new" (a new thread each run, the default) or "reuse" (one thread for every run); tellMe "every", "news" (the default: only when there is something new) or "problems".',
  properties: {
    thread: { type: 'string', enum: ['new', 'reuse'] },
    tellMe: { type: 'string', enum: ['every', 'news', 'problems'] },
    botChat: { type: 'string' }
  }
}

const FIELDS = {
  name: { type: 'string', description: 'A short name, a few words.' },
  trigger: TRIGGER_SCHEMA,
  prompt: { type: 'string', description: 'What the agent is asked to do on each run, written for an agent that has none of this conversation.' },
  project: { type: ['string', 'null'], description: 'The project it runs in, by id or name. Required before it can be turned on.' },
  result: RESULT_SCHEMA,
  permissionMode: { type: 'string', enum: ['ask', 'accept_edits', 'auto', 'full'], description: 'How much a run may do without asking. Held to what the person holds; leave it out for their default.' }
}

/**
 * The Automation manager's tools (v4): it turns a person's words into a draft that never runs until the person presses
 * Turn on, asks one question at a time under the draft, and lists, changes and pauses automations ("Change it…").
 * Only the profile's hidden manager thread and a bot that was granted them can use them; a bot asks its owner first.
 */
export function automationTools(host: AppToolHost): MousseTool[] {
  const reach = (threadId: string): AutomationToolHost | undefined => {
    const tools = host.automations?.()
    if (!tools) return undefined
    return tools.isManagerThread(threadId) || tools.botOf(threadId) ? tools : undefined
  }
  const author = (tools: AutomationToolHost, ctx: ToolCallContext): DraftAuthor => {
    const botId = tools.botOf(ctx.caller.threadId)
    return botId ? { botId } : { managerThreadId: ctx.caller.threadId }
  }
  const run = (ctx: ToolCallContext, act: (tools: AutomationToolHost) => unknown): ToolOutcome => {
    const tools = reach(ctx.caller.threadId)
    if (!tools) throw new McpToolError('mousse_scope_denied', 'Only the Automation manager or a bot can use the automation tools.')
    try {
      return json(act(tools))
    } catch (error) {
      // What the agent sent cannot be read or does not fit: it reads why and tries again.
      if (error instanceof AutomationDraftError || (error instanceof Error && !(error instanceof McpToolError))) return { text: error.message, isError: true }
      throw error
    }
  }
  const common = {
    access: 'actsAsCaller' as const,
    // The only thread a draft names is a thread event's pull request thread: the service reads it and binds nothing else.
    threadArgChecked: 'trigger.threadId of a thread event: AutomationDrafts checks the thread exists and has a pull request',
    available: (turn: { threadId: string }) => (reach(turn.threadId) ? true as const : 'Only the Automation manager or a bot can use this.'),
    // Listed only to the manager's thread and to bots; every other agent never sees them.
    listed: (listing: { threadId?: string }) => Boolean(listing.threadId && reach(listing.threadId))
  }
  return [
    {
      ...common,
      name: 'automation_draft_save',
      description:
        'Write the person\'s request as an automation draft (Trigger → Agent → Result). You fill in When (trigger), what to do (prompt), the result and the project; who does it is the person\'s pick, never yours. A draft never runs: the person turns it on. Pass draftId to change a draft you wrote. Returns { draftId, problems[] }: each problem is something to fix or to ask the person about.',
      inputSchema: { type: 'object', properties: { draftId: { type: 'string' }, ...FIELDS }, required: ['name', 'trigger', 'prompt'] },
      class: 'mutation',
      handler: (args, ctx) => run(ctx, (tools) => tools.drafts.save(args, author(tools, ctx)))
    },
    {
      ...common,
      name: 'automation_ask',
      description: 'Ask the person one short question under a draft, with up to 4 quick answers. Their answer comes back as a message. Ask at most one question at a time.',
      inputSchema: {
        type: 'object',
        properties: { draftId: { type: 'string' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
        required: ['draftId', 'question']
      },
      class: 'mutation',
      handler: (args, ctx) => run(ctx, (tools) => tools.drafts.ask(args, author(tools, ctx)))
    },
    {
      ...common,
      name: 'automation_list',
      description: 'List the automations and drafts, each as { id, name, draft, enabled, paused, trigger, agent (who does it: {kind:"default"} or {kind:"bot", botId}), prompt, project, result, permissionMode, nextRunAt, cliName?, problems?, ask? }.',
      inputSchema: { type: 'object', properties: {} },
      class: 'read',
      handler: (_args, ctx) => run(ctx, (tools) => ({ automations: tools.drafts.list() }))
    },
    {
      ...common,
      name: 'automation_update',
      description:
        'Change an automation (or a draft) by id: pass only the fields to change (not who does it: the person picks that). A change to an automation takes effect at once and must leave it with no problems. Its permission mode can only be lowered here.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...FIELDS }, required: ['id'] },
      class: 'mutation',
      handler: (args, ctx) => run(ctx, (tools) => ({ automation: tools.drafts.update(args) }))
    },
    {
      ...common,
      name: 'automation_pause',
      description: 'Pause an automation by id, until an ISO time ("until") or until the person resumes it. A run in progress finishes.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' }, until: { type: 'string' }, reason: { type: 'string' } }, required: ['id'] },
      class: 'mutation',
      handler: (args, ctx) => run(ctx, (tools) => ({ automation: tools.drafts.pause(args) }))
    }
  ]
}
