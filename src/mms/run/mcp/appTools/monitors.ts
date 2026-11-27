import {
  BACKGROUND_DEFAULT_MINUTES,
  BACKGROUND_MAX_MINUTES,
  KEEP_WORKING_DEFAULT_MINUTES,
  KEEP_WORKING_MAX_MINUTES,
  MONITOR_BATCH_MS,
  MONITOR_CHATTY_EVENTS_PER_MINUTE,
  MONITOR_CHATTY_NOTICES_PER_MINUTE,
  MONITOR_DEFAULT_MINUTES,
  MONITOR_MAX_MINUTES,
  MonitorInputError,
  type MonitorView,
  type ThreadMonitors
} from '../../../monitors/ThreadMonitors'
import type { AppToolHost } from './host'
import { CLIENT_REQUEST_ID_SCHEMA, json, type AppToolTurn, type MousseTool, type ToolCallContext, type ToolOutcome } from './types'

/** The tools that start and stop what a thread runs in the background (issue #1605). */
export const MONITOR_TOOL_NAMES = ['monitor_start', 'background_run', 'background_stop', 'keep_working'] as const

/** The permission key a monitor or background command asks under when the permission mode does not allow it. */
export const MONITOR_PERMISSION_KEY = 'mousse:monitor'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The thread a call acts for: its caller's. */
function threadOf(ctx: ToolCallContext): string {
  return ctx.transport === 'mcp' ? ctx.caller.threadId : ctx.turn.threadId
}

/** One request key per call, or per `clientRequestId` so a retry returns the first result. */
function requestKey(tool: string, args: Record<string, unknown>, ctx: ToolCallContext): string {
  const id = typeof args.clientRequestId === 'string' && args.clientRequestId.trim() ? args.clientRequestId.trim() : ctx.toolCallId
  return `${threadOf(ctx)}:${tool}:${id}`
}

/** Runs a command: refused in a mode that runs none (a read-only mode), as the agent's own shell is. */
function runsCommands(tool: string) {
  return (turn: AppToolTurn): true | string => (turn.modeFacts.readOnly ? `${tool} runs in the background, which this mode does not allow.` : true)
}

function shown(view: MonitorView & { replayed?: true }): Record<string, unknown> {
  return {
    id: view.id,
    kind: view.kind,
    description: view.description,
    ...(view.command ? { command: view.command } : {}),
    ...(view.url ? { url: view.url } : {}),
    startedAt: view.startedAt,
    until: view.until,
    ...(view.replayed ? { replayed: true } : {})
  }
}

/**
 * `monitor_start`, `background_run`, `background_stop` and `keep_working`: a thread's agent leaves something running
 * while it keeps working, and is told what it reports and when it ends (`ThreadMonitors`). Starting a script needs what
 * running a shell command needs: never in a read-only subagent or a read-only mode, and it asks first unless the permission
 * mode is Full access (a WebSocket only reads, so any mode that allows edits starts one). Personal bots keep their own
 * `watch_start` and are not offered these.
 */
export function monitorTools(host: AppToolHost): MousseTool[] {
  if (!host.monitors) return []
  const monitors = (): ThreadMonitors | undefined => host.monitors?.()
  const listed = (listing: { botRole?: unknown }): boolean => !listing.botRole && Boolean(monitors())
  const cwdOf = (ctx: ToolCallContext): string | undefined => ctx.turn.projectPath ?? host.projectPathFor?.(threadOf(ctx))
  const run = (work: (service: ThreadMonitors) => Record<string, unknown>): ToolOutcome => {
    const service = monitors()
    if (!service) return { text: 'Monitors are not available here.', isError: true }
    try {
      return json(work(service))
    } catch (error) {
      if (error instanceof MonitorInputError) return { text: error.message, isError: true }
      throw error
    }
  }
  return [
    {
      name: 'monitor_start',
      description: [
        'Start a monitor: a watcher that runs in the background while you keep working (or end your turn), and whose output reaches you as notices (<mousse_notice kind="monitor_event">).',
        'command: a shell script run in the thread\'s project folder (sh on macOS and Linux, cmd on Windows); every line it prints, stdout and stderr, is an event.',
        'url: a WebSocket (wss://, or ws:// on this computer only); every message the server sends is an event.',
        `Events within ${MONITOR_BATCH_MS} ms of each other arrive as one notice.`,
        'Make the script print on failure, on exit and on timeout too, not only on success: a script that prints nothing looks the same as one still waiting.',
        `Filter its output to the lines you need (grep): a monitor that reports more than ${MONITOR_CHATTY_EVENTS_PER_MINUTE} events or ${MONITOR_CHATTY_NOTICES_PER_MINUTE} notices in a minute is stopped.`,
        'When it ends (the script exits, the socket closes, its time runs out, the thread is stopped, or Mousse restarts) a last notice says why; after a timeout start it again if you still need it.',
        'Prefer a monitor or background_run to polling in a loop or waiting in your turn. The thread shows as Working while it runs. Stop it with background_stop.'
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What it watches, in a few words; the user sees it, e.g. "CI for PR 12".' },
          command: { type: 'string', description: 'A shell script that prints a line per event. Give command or url.' },
          url: { type: 'string', description: 'A wss:// address (ws:// only for localhost). Give command or url.' },
          timeoutMinutes: { type: 'number', description: `How long it may run: default ${MONITOR_DEFAULT_MINUTES}, at most ${MONITOR_MAX_MINUTES}.` },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        },
        required: ['description']
      },
      // It runs a script in the caller's own folder: what the agent's shell needs.
      access: 'editsWorkspace',
      permissionKey: MONITOR_PERMISSION_KEY,
      approvalPrompt: (args) => text(args.command).trim()
        ? `Allow the agent to start a monitor that runs this command in the background?\n$ ${text(args.command).trim().slice(0, 600)}`
        : `Allow the agent to watch this WebSocket in the background? ${text(args.url).trim().slice(0, 300)}`,
      // A script asks unless the mode is Full access, as the agent's shell commands do; a socket only receives.
      runsWithoutAsking: (args) => (text(args.command).trim() || !text(args.url).trim() ? 'full' : 'edit'),
      class: 'mutation',
      listed,
      available: runsCommands('monitor_start'),
      describe: (args) => `Started a monitor: ${text(args.description).slice(0, 120) || 'monitor'}`,
      handler: (args, ctx) => run((service) => shown(service.startMonitor({
        threadId: threadOf(ctx),
        description: text(args.description),
        ...(text(args.command).trim() ? { command: text(args.command) } : {}),
        ...(text(args.url).trim() ? { url: text(args.url) } : {}),
        ...(text(args.command).trim() ? { cwd: cwdOf(ctx) } : {}),
        timeoutMinutes: args.timeoutMinutes,
        requestKey: requestKey('monitor_start', args, ctx)
      })))
    },
    {
      name: 'background_run',
      description: [
        'Run one shell command in the background, in the thread\'s project folder (sh on macOS and Linux, cmd on Windows), and be told once when it ends:',
        'a notice (<mousse_notice kind="monitor_event">) with its exit code and the end of its output. Use it for "tell me when this finishes" (a build, a test run, a wait loop that exits when something happens) instead of waiting in your turn.',
        'You may end your turn: the notice starts a new one. The thread shows as Working while it runs. Stop it with background_stop.'
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'What it does, in a few words; the user sees it.' },
          command: { type: 'string', description: 'The shell command.' },
          timeoutMinutes: { type: 'number', description: `How long it may run: default ${BACKGROUND_DEFAULT_MINUTES}, at most ${BACKGROUND_MAX_MINUTES}.` },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        },
        required: ['description', 'command']
      },
      access: 'editsWorkspace',
      permissionKey: MONITOR_PERMISSION_KEY,
      approvalPrompt: (args) => `Allow the agent to run this command in the background?\n$ ${text(args.command).trim().slice(0, 600)}`,
      runsWithoutAsking: () => 'full',
      class: 'mutation',
      listed,
      available: runsCommands('background_run'),
      describe: (args) => `Ran in the background: ${text(args.description).slice(0, 120) || 'a command'}`,
      handler: (args, ctx) => run((service) => shown(service.startBackground({
        threadId: threadOf(ctx),
        description: text(args.description),
        command: text(args.command),
        cwd: cwdOf(ctx),
        timeoutMinutes: args.timeoutMinutes,
        requestKey: requestKey('background_run', args, ctx)
      })))
    },
    {
      name: 'background_stop',
      description: 'Stop one of this thread\'s monitors, background commands or keep_working holds by its id (from monitor_start, background_run, keep_working or running_list). No notice follows: this result carries anything it reported since its last notice (unreported) and a background command\'s last output (tail).',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The id it was started with.' } },
        required: ['id']
      },
      access: 'actsAsCaller',
      class: 'mutation',
      listed,
      describe: (args) => `Stopped ${text(args.id) || 'background work'}`,
      handler: (args, ctx) => run((service) => {
        const id = text(args.id).trim()
        if (!id) throw new MonitorInputError('id is required.')
        const stopped = service.stop(threadOf(ctx), id)
        if (!stopped) throw new MonitorInputError(`Nothing with id ${id} runs in this thread now; it may have ended already.`)
        return {
          id: stopped.id,
          kind: stopped.kind,
          description: stopped.description,
          stopped: true,
          ...(stopped.unreported ? { unreported: stopped.unreported } : {}),
          ...(stopped.droppedEvents ? { droppedEvents: stopped.droppedEvents } : {}),
          ...(stopped.tail ? { tail: stopped.tail } : {})
        }
      })
    },
    {
      name: 'keep_working',
      description: [
        'Keep this thread shown as Working while you wait on something outside Mousse that will come back to you (a reply, a deploy, a review), so it does not look finished.',
        'Monitors and background commands already keep it Working while they run; use this when nothing of yours runs.',
        'release: true ends every hold of this thread (do that once the wait is over). A hold that runs out of time tells you; call keep_working again if you are still waiting.'
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'What the thread waits for, in a few words; the user sees it.' },
          minutes: { type: 'number', description: `How long at most: default ${KEEP_WORKING_DEFAULT_MINUTES}, at most ${KEEP_WORKING_MAX_MINUTES}.` },
          release: { type: 'boolean', description: 'End this thread\'s holds instead of adding one.' },
          clientRequestId: CLIENT_REQUEST_ID_SCHEMA
        }
      },
      access: 'actsAsCaller',
      class: 'mutation',
      listed,
      describe: (args) => (args.release === true ? 'Stopped keeping the thread Working' : `Kept the thread Working: ${text(args.reason).slice(0, 120)}`),
      handler: (args, ctx) => run((service) => {
        if (args.release === true) return { released: service.release(threadOf(ctx)) }
        return shown(service.keepWorking({ threadId: threadOf(ctx), reason: text(args.reason), minutes: args.minutes, requestKey: requestKey('keep_working', args, ctx) }))
      })
    }
  ]
}
