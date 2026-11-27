/**
 * Mousse's own tools (`mcp__mousse__*`) in plain words: "Creating a thread in Mousse", "Saving to memory". The tool
 * row, its icon and the turn's live line use these instead of the tool's raw name ("Thread Create"). A tool not listed
 * here reads "Running <its name> in Mousse".
 */

import {
  classifyCuaCall,
  cuaCallWords,
  guardedInput,
  isGuardedCall,
  sanitizeCuaInput,
  sanitizeCuaOutput,
} from "../../../../../shared/cuaActivity";
import { canonicalToolName, isBotVariant } from "../../../../../shared/toolAliases";

const MOUSSE_TOOL_PREFIX = "tool-mcp__mousse__";
const CUSTOM_TOOL_PREFIX = "tool-mcp__custom__";

/** The Mousse tool a part's type names (`tool-mcp__mousse__thread_create` is `thread_create`), else null. */
export function mousseToolOf(partType: string | undefined): string | null {
  if (!partType?.startsWith(MOUSSE_TOOL_PREFIX)) return null;
  const name = partType.slice(MOUSSE_TOOL_PREFIX.length);
  return name ? name : null;
}

/** Each verb's forms: going on, and done. */
const VERBS: Record<string, readonly [ing: string, past: string]> = {
  add: ["adding", "added"],
  answer: ["answering", "answered"],
  archive: ["archiving", "archived"],
  ask: ["asking", "asked"],
  cancel: ["cancelling", "cancelled"],
  change: ["changing", "changed"],
  check: ["checking", "checked"],
  create: ["creating", "created"],
  edit: ["editing", "edited"],
  end: ["ending", "ended"],
  fork: ["forking", "forked"],
  forget: ["forgetting", "forgot"],
  give: ["giving", "gave"],
  keep: ["keeping", "kept"],
  hide: ["hiding", "hid"],
  list: ["listing", "listed"],
  load: ["loading", "loaded"],
  merge: ["merging", "merged"],
  message: ["messaging", "messaged"],
  open: ["opening", "opened"],
  pause: ["pausing", "paused"],
  publish: ["publishing", "published"],
  queue: ["queueing", "queued"],
  read: ["reading", "read"],
  remove: ["removing", "removed"],
  reorder: ["reordering", "reordered"],
  request: ["requesting", "requested"],
  run: ["running", "ran"],
  save: ["saving", "saved"],
  search: ["searching", "searched"],
  set: ["setting", "set"],
  start: ["starting", "started"],
  steer: ["steering", "steered"],
  stop: ["stopping", "stopped"],
  "turn on": ["turning on", "turned on"],
  update: ["updating", "updated"],
  use: ["using", "used"],
  wait: ["waiting", "waited"],
  watch: ["watching", "watched"],
};

type Verb = keyof typeof VERBS;

/** What each tool does, as a verb and the rest of the sentence. */
const TOOLS: Record<string, readonly [Verb, string]> = {
  // Threads
  thread_create: ["create", "a thread in Mousse"],
  thread_send: ["message", "a thread in Mousse"],
  thread_read: ["read", "a thread in Mousse"],
  thread_list: ["list", "threads in Mousse"],
  thread_search: ["search", "threads in Mousse"],
  terminal_read: ["read", "a terminal in Mousse"],
  thread_wait: ["wait", "for a thread in Mousse"],
  thread_stop: ["stop", "a thread in Mousse"],
  thread_fork: ["fork", "a thread in Mousse"],
  thread_return: ["merge", "a thread back in Mousse"],
  thread_archive: ["archive", "a thread in Mousse"],
  thread_update: ["update", "a thread in Mousse"],
  // A thread's queue
  queue_list: ["read", "a thread's queue in Mousse"],
  queue_enqueue: ["queue", "a message in Mousse"],
  queue_update: ["change", "a queued message in Mousse"],
  request_answer: ["answer", "a request in Mousse"],
  // Memory
  memory_save: ["save", "to memory"],
  memory_search: ["search", "memory"],
  memory_read: ["read", "memory"],
  memory_list: ["list", "memories"],
  memory_forget: ["forget", "a memory"],
  item_save: ["update", "the open items"],
  item_list: ["check", "the open items"],
  // Reminders and wake-ups
  remind: ["set", "a reminder"],
  wake: ["set", "a wake-up"],
  reminder_list: ["check", "reminders"],
  reminder_cancel: ["cancel", "a reminder"],
  // Schedules
  schedule_create: ["create", "a schedule in Mousse"],
  schedule_list: ["check", "schedules in Mousse"],
  schedule_update: ["update", "a schedule in Mousse"],
  schedule_pause: ["pause", "a schedule in Mousse"],
  schedule_run: ["run", "a schedule in Mousse"],
  schedule_done: ["end", "a schedule in Mousse"],
  bot_schedule_add: ["add", "a schedule in Mousse"],
  bot_schedule_list: ["check", "schedules in Mousse"],
  bot_schedule_remove: ["remove", "a schedule in Mousse"],
  // A bot's work and background commands
  work_start: ["start", "work in Mousse"],
  work_list: ["check", "work in Mousse"],
  work_stop: ["stop", "work in Mousse"],
  work_note: ["add", "a note to work in Mousse"],
  work_wait: ["wait", "for work in Mousse"],
  watch_start: ["start", "a background command in Mousse"],
  watch_list: ["check", "background commands in Mousse"],
  watch_stop: ["stop", "a background command in Mousse"],
  running_list: ["check", "what is running in Mousse"],
  // A thread's monitors and background commands
  monitor_start: ["start", "a monitor in Mousse"],
  background_run: ["start", "a background command in Mousse"],
  background_stop: ["stop", "background work in Mousse"],
  keep_working: ["keep", "the thread working in Mousse"],
  // Subagents and tasks
  delegate_task: ["start", "a subagent in Mousse"],
  create_subagent: ["start", "a subagent in Mousse"],
  create_subagents: ["start", "subagents in Mousse"],
  subagent_start: ["start", "a subagent in Mousse"],
  continue_subagent: ["message", "a subagent in Mousse"],
  recall_subagent: ["message", "a subagent in Mousse"],
  subagent_send: ["message", "a subagent in Mousse"],
  task_status: ["check", "a subagent in Mousse"],
  subagent_result: ["check", "a subagent in Mousse"],
  subagent_wait: ["wait", "for a subagent in Mousse"],
  task_cancel: ["stop", "a subagent in Mousse"],
  subagent_stop: ["stop", "a subagent in Mousse"],
  list_subagents: ["list", "subagents in Mousse"],
  list_delegations: ["list", "subagents in Mousse"],
  task_create: ["create", "a task in Mousse"],
  task_list: ["list", "tasks in Mousse"],
  task_update: ["update", "a task in Mousse"],
  computer_list: ["list", "computers in Mousse"],
  computer_tools: ["list", "computer tools"],
  computer_use: ["use", "the computer"],
  computer_use_request: ["request", "computer use setup"],
  model_list: ["list", "models in Mousse"],
  // Asking the person
  question_ask: ["ask", "you a question"],
  question_withdraw: ["withdraw", "a question"],
  permission_ask: ["ask", "you for a permission"],
  automation_ask: ["ask", "you a question"],
  secret_request: ["ask", "you for a secret"],
  secret_run: ["run", "a command with a secret"],
  // A bot's settings
  consult: ["ask", "a context thread"],
  use_model: ["change", "the model"],
  set_depth: ["change", "how deeply it thinks"],
  set_profile: ["update", "its profile"],
  // Skills, automations and quick actions
  skill_list: ["list", "skills in Mousse"],
  skill_load: ["load", "a skill in Mousse"],
  automation_draft_save: ["save", "an automation draft in Mousse"],
  automation_enable: ["turn on", "an automation in Mousse"],
  automation_list: ["list", "automations in Mousse"],
  automation_pause: ["pause", "an automation in Mousse"],
  automation_update: ["update", "an automation in Mousse"],
  create_quick_action: ["create", "a quick action in Mousse"],
  publish_applet: ["publish", "an applet"],
  read_applet: ["read", "an applet"],
  // The web, the browser, the look, Git and the profiler
  web_search: ["search", "the web"],
  web_fetch: ["read", "a web page"],
  browser_open: ["open", "a page in the browser"],
  theme_read: ["read", "themes in Mousse"],
  theme_set: ["change", "the theme in Mousse"],
  goal_update: ["check", "the goal in Mousse"],
  git_status: ["check", "Git status"],
  git_diff: ["read", "the Git diff"],
};

/** Families of tools that share one sentence (`browser_*`, `profiler_*`). */
const FAMILIES: ReadonlyArray<readonly [prefix: string, Verb, string]> = [
  ["browser_", "use", "the browser"],
  ["profiler_", "check", "performance in Mousse"],
];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A Mousse tool's row in words, running, done and failed. */
export type MousseToolLabels = { running: string; done: string; failed: string };

export function mousseToolLabels(tool: string): MousseToolLabels {
  const family = FAMILIES.find(([prefix]) => tool.startsWith(prefix));
  // A call an older transcript names by a tool's old name reads as the tool it was renamed to; a bot's own tool that
  // became a variant of a thread tool (`work_start`) keeps its words.
  const own = TOOLS[isBotVariant(tool) ? tool : canonicalToolName(tool)] ?? (family ? ([family[1], family[2]] as const) : undefined);
  if (!own) {
    const name = tool.replace(/_/g, " ").trim();
    return { running: `Running ${name} in Mousse`, done: `Ran ${name} in Mousse`, failed: `Couldn't run ${name} in Mousse` };
  }
  const [verb, rest] = own;
  const [ing, past] = VERBS[verb]!;
  return { running: capitalize(`${ing} ${rest}`), done: capitalize(`${past} ${rest}`), failed: `Couldn't ${verb} ${rest}` };
}

/** Which argument says what a call works on, by tool; any other tool tries `SUBJECT_KEYS` in order. */
const SUBJECTS: Record<string, readonly string[]> = {
  web_fetch: ["url"],
  browser_open: ["url"],
  thread_create: ["title", "firstMessage"],
  thread_send: ["content"],
  thread_steer: ["content"],
  queue_enqueue: ["content"],
  schedule_create: ["name", "prompt"],
  monitor_start: ["description", "command", "url"],
  background_run: ["description", "command"],
};

const SUBJECT_KEYS = ["query", "url", "title", "name", "question", "description", "content", "message", "text", "brief", "prompt", "command", "skill", "path"];

const SUBJECT_CHARS = 120;

/**
 * What a Mousse tool call works on, in a few words: a search's query, a fetch's URL, a new thread's title. Its first
 * line, cut to fit; undefined when its arguments say nothing readable (only ids) or were cut when saved.
 */
export function mousseToolSubject(tool: string, input: unknown): string | undefined {
  const args = record(input);
  if (!args || isCutInput(args)) return undefined;
  // A bot's use_tool names the tool it ran, and what that call works on.
  if (tool === "use_tool" && typeof args.tool === "string" && args.tool.trim()) {
    const inner = mousseToolSubject(args.tool, args.arguments);
    return inner ? `${args.tool.trim()}: ${inner}` : args.tool.trim();
  }
  for (const key of SUBJECTS[tool] ?? SUBJECT_KEYS) {
    const value = args[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const line = value.trim().split("\n")[0]!.trim();
    return line.length > SUBJECT_CHARS ? `${line.slice(0, SUBJECT_CHARS - 1)}…` : line;
  }
  return undefined;
}

/** A site a web search returned. */
export type WebSite = { title: string; url: string; host: string };

const MAX_SITES = 10;

function siteOf(url: string, title: string | undefined): WebSite | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const host = parsed.hostname.replace(/^www\./, "");
    return { url: parsed.href, host, title: title?.trim() || host };
  } catch {
    return undefined;
  }
}

/** Sites in a parsed result: objects with a `url` (and maybe a `title`), a few levels deep. */
function sitesInValue(value: unknown, out: WebSite[], depth = 0): void {
  if (out.length >= MAX_SITES || depth > 4 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) sitesInValue(entry, out, depth + 1);
    return;
  }
  const item = value as Record<string, unknown>;
  const url = typeof item.url === "string" ? item.url : typeof item.link === "string" ? item.link : undefined;
  const site = url ? siteOf(url, typeof item.title === "string" ? item.title : undefined) : undefined;
  if (site) out.push(site);
  else for (const child of Object.values(item)) sitesInValue(child, out, depth + 1);
}

/**
 * The sites a web search's result text lists, in its order, at most ten: the `url`s of a JSON result, the `URL:` lines
 * of a text one (each with the `Title:` line before it), else any web address in it. Empty when it lists none.
 */
export function webSearchSites(output: unknown): WebSite[] {
  const text = outputText(output);
  if (!text?.trim()) return [];
  const found: WebSite[] = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      sitesInValue(JSON.parse(trimmed), found);
    } catch {
      // Not JSON: read it as text.
    }
  }
  if (found.length === 0) {
    let title: string | undefined;
    for (const line of text.split("\n")) {
      const titled = /^\s*(?:#+\s*)?Title:\s*(.+)$/i.exec(line);
      if (titled) title = titled[1];
      const addressed = /^\s*(?:URL|Link|Source):\s*(\S+)/i.exec(line);
      if (!addressed) continue;
      const site = siteOf(addressed[1]!, title);
      if (site) found.push(site);
      title = undefined;
    }
  }
  if (found.length === 0) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
      const site = siteOf(match[0].replace(/[.,;:]+$/, ""), undefined);
      if (site) found.push(site);
      if (found.length >= MAX_SITES * 2) break;
    }
  }
  const seen = new Set<string>();
  return found.filter((site) => !seen.has(site.url) && seen.add(site.url)).slice(0, MAX_SITES);
}

/**
 * The Mousse tool a part names however its runtime spelled the call: `tool-mcp__mousse__<tool>`, or on a row with no
 * server (`tool-mcp__custom__…`) a bare name (Pi), `mousse_<tool>` (`mousse.<tool>`) or `<tool>_mousse_mcp_server_`
 * (an ACP title `<tool> (mousse MCP Server)`). Null for anything else.
 */
function mousseToolOfAnyPart(partType: string | undefined): string | null {
  const own = mousseToolOf(partType);
  if (own) return own;
  if (!partType?.startsWith(CUSTOM_TOOL_PREFIX)) return null;
  const slug = partType.slice(CUSTOM_TOOL_PREFIX.length).replace(/^mousse_+/, "").replace(/_mousse_mcp_server_$/, "");
  return /^[a-z][a-z0-9_]*$/.test(slug) ? slug : null;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** A row whose arguments were cut to fit when saved (`capRecord`): only a preview of the raw text is left. */
function isCutInput(input: unknown): boolean {
  const args = record(input);
  return args?.truncated === true && "preview" in args;
}

/** The result text of a part: the text itself, or the `text` an interrupted or older row wraps it in. */
function outputText(output: unknown): string | undefined {
  if (typeof output === "string") return output;
  const text = record(output)?.text;
  return typeof text === "string" ? text : undefined;
}

/** What a computer use row shows: its words, one detail, and its arguments and result held to the allowlist. */
export type CuaPresentation = {
  labels: MousseToolLabels;
  detail?: string;
  /** The arguments as the row may show them, unwrapped from a bot's `use_tool`. */
  input?: Record<string, unknown>;
  output?: string;
};

const PENDING_LABELS: MousseToolLabels = { running: "Using a tool", done: "Used a tool", failed: "Couldn't use a tool" };

/**
 * A computer use call's row (`computer_tools`, `computer_use`, `computer_use_request`, directly or through a bot's
 * `use_tool`), held again to `src/shared/cuaActivity.ts` so a row saved before that existed shows nothing it would not
 * keep now. A `use_tool` whose tool is not known (`useToolTarget`, or its arguments) shows nothing of its arguments or
 * result, nor does a row whose arguments were cut to fit. The words follow one rule, not a table of the driver's tools:
 * the driver tool's name in words and one detail ("Mouse click", "(420, 180)"); a row that recorded no action says
 * only that it used the computer. Null for any other part.
 */
export function cuaPresentation(part: { type?: string; input?: unknown; output?: unknown; state?: string; useToolTarget?: unknown }): CuaPresentation | null {
  const tool = mousseToolOfAnyPart(part.type);
  if (!tool) return null;
  const call = classifyCuaCall(tool, { input: part.input, useToolTarget: part.useToolTarget });
  if (!isGuardedCall(call)) return null;
  if (call.kind === "use_tool_pending") return { labels: PENDING_LABELS };
  if (isCutInput(part.input)) return { labels: mousseToolLabels(call.tool) };
  // A bot's use_tool shows the call it made, unwrapped.
  const inner = call.kind === "use_tool_cua" ? sanitizeCuaInput(call.tool, record(part.input)?.arguments) : guardedInput(call, part.input);
  const output = sanitizeCuaOutput(call.tool, outputText(part.output), part.state === "output-error");
  const { action, detail } = cuaCallWords(call.tool, inner);
  const labels = action ? { running: action, done: action, failed: `${action} failed` } : mousseToolLabels(call.tool);
  return {
    labels,
    ...(detail ? { detail } : {}),
    ...(inner && Object.keys(inner).length ? { input: inner } : {}),
    ...(output ? { output } : {}),
  };
}
