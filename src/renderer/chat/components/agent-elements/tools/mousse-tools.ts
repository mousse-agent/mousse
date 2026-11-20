/**
 * Mousse's own tools (`mcp__mousse__*`) in plain words: "Creating a thread in Mousse", "Saving to memory". The tool
 * row, its icon and the turn's live line use these instead of the tool's raw name ("Thread Create"). A tool not listed
 * here reads "Running <its name> in Mousse".
 */

const MOUSSE_TOOL_PREFIX = "tool-mcp__mousse__";

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
  run: ["running", "ran"],
  save: ["saving", "saved"],
  search: ["searching", "searched"],
  set: ["setting", "set"],
  start: ["starting", "started"],
  steer: ["steering", "steered"],
  stop: ["stopping", "stopped"],
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
  thread_steer: ["steer", "a thread in Mousse"],
  thread_interrupt: ["stop", "a thread in Mousse"],
  thread_fork: ["fork", "a thread in Mousse"],
  thread_merge_back: ["merge", "a thread back in Mousse"],
  thread_archive: ["archive", "a thread in Mousse"],
  thread_hide: ["hide", "a thread in Mousse"],
  thread_update: ["update", "a thread in Mousse"],
  // A thread's queue
  queue_list: ["read", "a thread's queue in Mousse"],
  queue_enqueue: ["queue", "a message in Mousse"],
  queue_edit: ["edit", "a queued message in Mousse"],
  queue_remove: ["remove", "a queued message in Mousse"],
  queue_reorder: ["reorder", "queued messages in Mousse"],
  queue_promote_to_steer: ["steer", "with a queued message in Mousse"],
  approval_respond: ["answer", "an approval in Mousse"],
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
  work_models: ["check", "models in Mousse"],
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
  answer_subagent: ["answer", "a subagent in Mousse"],
  task_status: ["check", "a subagent in Mousse"],
  subagent_result: ["check", "a subagent in Mousse"],
  subagent_wait: ["wait", "for a subagent in Mousse"],
  task_cancel: ["stop", "a subagent in Mousse"],
  subagent_stop: ["stop", "a subagent in Mousse"],
  list_subagents: ["list", "subagents in Mousse"],
  list_delegations: ["list", "subagents in Mousse"],
  create_task: ["create", "a task in Mousse"],
  list_tasks: ["list", "tasks in Mousse"],
  update_task: ["update", "a task in Mousse"],
  list_computers: ["list", "computers in Mousse"],
  list_models: ["list", "models in Mousse"],
  // Asking the person
  ask_user: ["ask", "you a question"],
  withdraw_question: ["withdraw", "a question"],
  escalate: ["ask", "you for a permission"],
  automation_ask: ["ask", "you a question"],
  secret_request: ["ask", "you for a secret"],
  secret_run: ["run", "a command with a secret"],
  // A bot's settings
  consult: ["ask", "a context thread"],
  use_model: ["change", "the model"],
  set_depth: ["change", "how deeply it thinks"],
  set_profile: ["update", "its profile"],
  // Skills, automations and quick actions
  list_skills: ["list", "skills in Mousse"],
  load_skill: ["load", "a skill in Mousse"],
  automation_draft_save: ["save", "an automation draft in Mousse"],
  automation_list: ["list", "automations in Mousse"],
  automation_pause: ["pause", "an automation in Mousse"],
  automation_update: ["update", "an automation in Mousse"],
  create_quick_action: ["create", "a quick action in Mousse"],
  publish_applet: ["publish", "an applet"],
  // The web, the browser, the look, Git and the profiler
  web_search: ["search", "the web"],
  web_fetch: ["read", "a web page"],
  browser_open: ["open", "a page in the browser"],
  theme_read: ["read", "themes in Mousse"],
  theme_set: ["change", "the theme in Mousse"],
  goal_status: ["check", "the goal in Mousse"],
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
  const own = TOOLS[tool] ?? (family ? ([family[1], family[2]] as const) : undefined);
  if (!own) {
    const name = tool.replace(/_/g, " ").trim();
    return { running: `Running ${name} in Mousse`, done: `Ran ${name} in Mousse`, failed: `Couldn't run ${name} in Mousse` };
  }
  const [verb, rest] = own;
  const [ing, past] = VERBS[verb]!;
  return { running: capitalize(`${ing} ${rest}`), done: capitalize(`${past} ${rest}`), failed: `Couldn't ${verb} ${rest}` };
}
