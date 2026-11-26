import { getToolStatus, thoughtHeadline } from "./format-tool";
import { normalizeAssistantToolParts } from "./tool-part-normalizer";
import type { LiveThoughtSource } from "../../../../stores/liveTextStore";

export type ToolPartBase = {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isTextPart(
  part: unknown,
): part is { type: "text"; text: string } {
  return (
    isRecord(part) && part.type === "text" && typeof part.text === "string"
  );
}

export function isErrorPart(
  part: unknown,
): part is { type: "error"; title?: string; message: string } {
  return (
    isRecord(part) && part.type === "error" && typeof part.message === "string"
  );
}

export function isV5ToolPart(part: unknown): part is ToolPartBase {
  if (!isRecord(part)) return false;
  const partType = part.type;
  return (
    partType === "dynamic-tool" ||
    (typeof partType === "string" && partType.startsWith("tool-"))
  );
}

/**
 * Rows that need their own surface and never join an activity group or fold behind a finished turn's
 * "Worked for" line: questions and what the user answered, an approval card, a plan to approve.
 */
const STANDALONE_TOOL_TYPES = new Set(["tool-Question", "tool-QuestionAnswers", "tool-QuickAction", "tool-PlanWrite"]);

/** A call drawn on its own surface, never inside a group (see `STANDALONE_TOOL_TYPES`). */
export function isStandaloneToolType(type: string): boolean {
  return STANDALONE_TOOL_TYPES.has(type);
}

export type AssistantToolItem = {
  part: ToolPartBase;
  nestedTools?: ToolPartBase[];
};

export type AssistantMessageAnalysis = {
  /**
   * True when the message renders only groupable activity rows (tools,
   * thoughts, and file edits; no text, error, or question rows), so it can
   * merge into one activity group.
   */
  toolsOnly: boolean;
  toolItems: AssistantToolItem[];
  /**
   * True when the message renders only subagent cards. Cards never join an
   * activity group: a running one must stay in view when the turn ends, and a
   * finished one stays as the record of what the subagent did.
   */
  cardsOnly: boolean;
  cardParts: ToolPartBase[];
  /** The calls a card's subagent made (a runtime's own subagent holds them), by the card's call id. */
  cardNestedTools?: ReadonlyMap<string, ToolPartBase[]>;
};

const NO_CARD_IDS: ReadonlySet<string> = new Set();

/**
 * Pure per-message analysis mirroring AssistantParts rendering rules:
 * text/error/question rows disqualify grouping; thoughts and file edits join it.
 * TaskOutput,
 * nested, and suppressed-question parts are invisible and ignored.
 * `cardIds` are the tool calls drawn as subagent cards; a message that holds
 * one is groupable as neither tools nor cards unless it holds only cards.
 */
export function analyzeAssistantMessage(
  rawParts: unknown[],
  suppressQuestionTool: boolean,
  cardIds: ReadonlySet<string> = NO_CARD_IDS,
): AssistantMessageAnalysis {
  const notGroupable: AssistantMessageAnalysis = {
    toolsOnly: false,
    toolItems: [],
    cardsOnly: false,
    cardParts: [],
  };
  const parts = normalizeAssistantToolParts(rawParts) as unknown[];

  const taskPartIds = new Set(
    parts
      .filter(
        (p): p is ToolPartBase =>
          isV5ToolPart(p) &&
          (p.type === "tool-Task" || p.type === "tool-Agent") &&
          typeof p.toolCallId === "string",
      )
      .map((p) => p.toolCallId!),
  );
  const nestedToolsMap = new Map<string, ToolPartBase[]>();
  const nestedToolIds = new Set<string>();
  for (const part of parts) {
    if (!isV5ToolPart(part)) continue;
    if (part.type === "tool-TaskOutput") continue;
    if (!part.toolCallId || !part.toolCallId.includes(":")) continue;
    const parentId = part.toolCallId.split(":")[0];
    if (!taskPartIds.has(parentId)) continue;
    if (!nestedToolsMap.has(parentId)) {
      nestedToolsMap.set(parentId, []);
    }
    nestedToolsMap.get(parentId)!.push(part);
    nestedToolIds.add(part.toolCallId);
  }

  const toolItems: AssistantToolItem[] = [];
  const cardParts: ToolPartBase[] = [];
  const cardNestedTools = new Map<string, ToolPartBase[]>();
  for (const part of parts) {
    if (isTextPart(part)) {
      if (part.text) return notGroupable;
      continue;
    }
    if (isRecord(part) && (part.type === "data-applet" || part.type === "data-applet-pending")) return notGroupable;
    if (isErrorPart(part)) return notGroupable;
    if (!isV5ToolPart(part)) continue;
    if (part.type === "tool-TaskOutput") continue;
    if (suppressQuestionTool && part.type === "tool-Question") continue;
    if (part.toolCallId && nestedToolIds.has(part.toolCallId)) continue;
    if (STANDALONE_TOOL_TYPES.has(part.type)) {
      return notGroupable;
    }
    if (part.toolCallId && cardIds.has(part.toolCallId)) {
      cardParts.push(part);
      const nested = nestedToolsMap.get(part.toolCallId);
      if (nested) cardNestedTools.set(part.toolCallId, nested);
      continue;
    }
    const toolCallId = part.toolCallId;
    const nestedTools =
      (part.type === "tool-Task" || part.type === "tool-Agent") &&
      toolCallId
        ? nestedToolsMap.get(toolCallId)
        : undefined;
    toolItems.push({ part, nestedTools });
  }

  if (cardParts.length > 0) {
    // Cards and other rows in one message render as the message itself.
    return toolItems.length === 0
      ? { toolsOnly: false, toolItems: [], cardsOnly: true, cardParts, ...(cardNestedTools.size > 0 ? { cardNestedTools } : {}) }
      : notGroupable;
  }
  if (toolItems.length === 0) return notGroupable;
  return { toolsOnly: true, toolItems, cardsOnly: false, cardParts: [] };
}

export type TurnSegment =
  | { kind: "message"; msgIndex: number }
  | { kind: "tools"; msgIndices: number[] }
  | { kind: "cards"; msgIndices: number[] };

/**
 * A compaction row: Mousse's line about the context, drawn after the turn it follows. It is never the
 * agent's answer, so a `/compact` after a reply leaves that reply where it was.
 */
export function isCompactionRow(message: SettleTurnMessage): boolean {
  return (message.metadata as { compaction?: boolean } | undefined)?.compaction === true;
}

/**
 * A provider retry row: Mousse's line counting a turn's retries of a failed request. Like a compaction row it is
 * never the agent's answer, and it stays in place when the turn folds its activity.
 */
export function isProviderRetryRow(message: SettleTurnMessage): boolean {
  return (message.metadata as { providerRetry?: unknown } | undefined)?.providerRetry != null;
}

/**
 * A model switch marker: Mousse's line naming the model that takes over, drawn where the turn starts. Like a
 * compaction row it is neither the answer nor a note, so a finished turn does not fold it into its activity.
 */
function isHandoffMarker(message: SettleTurnMessage): boolean {
  return (message.metadata as { contextHandoff?: unknown } | undefined)?.contextHandoff != null;
}

/** The text of a reply row, or "" when the message is not one. */
function replyText(message: SettleTurnMessage): string {
  if (message.role !== "assistant" || isCompactionRow(message) || isProviderRetryRow(message) || isHandoffMarker(message)) return "";
  return (message.parts ?? [])
    .filter(isTextPart)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export type SettleTurnMessage = { id: string; role?: string; parts?: unknown[]; metadata?: unknown };

/** The text of a turn's answer: its last reply row, the one a finished turn draws last. */
export function turnAnswerText(messages: SettleTurnMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = replyText(messages[index]!);
    if (text) return text;
  }
  return "";
}

/**
 * A finished turn as it reads once the work is done: its answer, the last reply row, comes last.
 * Activity after the answer moves above it. Reply rows before it (the agent's narration between
 * calls) stay where they were, as prose that splits the work into groups. Returns the order to draw
 * the messages in and each message's analysis; a turn with no reply text keeps its order.
 *
 * Moving activity above the last reply row is for a turn that ran to its end: there the last reply is
 * the answer, written after the work even when an older turn saved it in a row that opened early. A
 * turn cut off by a Stop or a restart (`cutOff`) has no answer, so when activity follows its last reply
 * row, that row is narration written before the work and the turn keeps the order it ran in.
 */
export function settleFinishedTurn(
  messages: SettleTurnMessage[],
  analyses: AssistantMessageAnalysis[],
  cutOff = false,
): { order: number[]; analyses: AssistantMessageAnalysis[] } {
  const order = messages.map((_, index) => index);
  // Messages steered into the turn (a person's rows inside it) split it: what was written before the last of
  // them answered the earlier messages and stays as it was, where it was. Only what came after settles.
  let from = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isSteerRow(messages[index]!)) {
      from = index + 1;
      break;
    }
  }
  let answer = -1;
  for (let index = messages.length - 1; index >= from; index -= 1) {
    if (replyText(messages[index]!)) {
      answer = index;
      break;
    }
  }
  if (answer === -1) return { order, analyses };
  if (cutOff && order.some((index) => index > answer && analyses[index]!.toolsOnly)) return { order, analyses };
  const after = order.filter((index) => index > answer);
  return {
    order: [
      ...order.filter((index) => index < answer),
      ...after.filter((index) => analyses[index]!.toolsOnly),
      answer,
      ...after.filter((index) => !analyses[index]!.toolsOnly),
    ],
    analyses,
  };
}

function isSteerRow(message: SettleTurnMessage): boolean {
  return isRecord(message.metadata) && Array.isArray((message.metadata as { steerGroup?: unknown }).steerGroup);
}

/** A thinking part's text (what streamed so far, or its final output). */
export function thoughtTextFromPart(part: ToolPartBase): string {
  if (part.type !== "tool-Thinking") return "";
  const input = isRecord(part.input) ? part.input.thought : undefined;
  const output = part.output ?? part.result;
  return typeof input === "string" && input.trim()
    ? input
    : typeof output === "string"
      ? output
      : "";
}

/** The settled copy of each message that held a thought still marked as streaming, kept while it is the same object. */
const settledThoughtCopies = new WeakMap<object, object>();

/**
 * The turn's messages with every thought but one at the very end marked done. A provider closes a thought only when
 * the turn ends, so one followed by text or a tool call would read as still thinking while the turn writes. A message
 * that changes nothing stays the same object, and a settled copy is reused, so memoised rows do not render again.
 */
export function settleEarlierThoughts<T extends { parts?: unknown[] }>(messages: T[]): T[] {
  let changed = false;
  const out = messages.map((message, index) => {
    if (index === messages.length - 1) return message;
    const settled = settleThoughtsOf(message);
    if (settled !== message) changed = true;
    return settled;
  });
  return changed ? out : messages;
}

function settleThoughtsOf<T extends { parts?: unknown[] }>(message: T): T {
  const parts = message.parts ?? [];
  if (!parts.some((part) => isLiveThought(part))) return message;
  const cached = settledThoughtCopies.get(message as object);
  if (cached) return cached as T;
  const copy = {
    ...message,
    parts: parts.map((part) => {
      if (!isLiveThought(part)) return part;
      const text = thoughtTextFromPart(part as ToolPartBase);
      return { ...(part as object), state: "output-available", output: text };
    }),
  };
  settledThoughtCopies.set(message as object, copy);
  return copy;
}

function isLiveThought(part: unknown): boolean {
  return isRecord(part) && part.type === "tool-Thinking" && part.state === "input-available";
}

/**
 * A thinking part's text as the transcript holds it, and the thought whose live text (see liveTextStore) can
 * stand for its end: the newest of the thoughts the row joins.
 */
export function thoughtSourceOf(part: ToolPartBase & { liveId?: string; liveFrom?: number }): LiveThoughtSource | undefined {
  if (part.type !== "tool-Thinking") return undefined;
  const thought = isRecord(part.input) && typeof part.input.thought === "string" ? part.input.thought : "";
  const id = part.liveId ?? part.toolCallId;
  if (!id) return undefined;
  return { id, thought, from: Math.min(part.liveFrom ?? 0, thought.length) };
}

/**
 * The calls of a running turn that failed with nothing after them yet: no later call succeeded and no reply followed.
 * The transcript marks such a failure as got past while the turn runs (`markRecoveredFailures`), so its row stays
 * quiet; a group line still counts it, as it will if the turn ends there.
 */
export function pendingFailures(messages: readonly { parts?: unknown[] }[]): ReadonlySet<string> {
  let pending: string[] = [];
  for (const message of messages) {
    for (const part of (message.parts ?? []) as unknown[]) {
      if (isTextPart(part)) {
        if (part.text.trim()) pending = [];
        continue;
      }
      if (!isV5ToolPart(part) || part.type === "tool-Thinking") continue;
      // The row's own rule: a call that ended with `success: false` in its output failed too. Only a call that
      // succeeded gets past the failures before it.
      const status = getToolStatus(part);
      if (status.isError) {
        if (part.toolCallId) pending.push(part.toolCallId);
      } else if (status.isSuccess) pending = [];
    }
  }
  return new Set(pending);
}

/** What a call in a work group did, for the group's title. */
type WorkKind = "edit" | "command" | "read" | "search" | "web" | "fetch" | "agent" | "other" | "thought";

const EDIT_TYPES = new Set(["tool-Edit", "tool-MultiEdit", "tool-Write", "tool-NotebookEdit", "tool-Write_file", "tool-Apply_patch"]);
const SEARCH_TYPES = new Set(["tool-Grep", "tool-Glob", "tool-Search"]);

function workKindOf(type: string): WorkKind {
  if (type === "tool-Thinking") return "thought";
  if (type === "tool-Read") return "read";
  if (EDIT_TYPES.has(type)) return "edit";
  if (type === "tool-Bash") return "command";
  if (SEARCH_TYPES.has(type)) return "search";
  if (type === "tool-WebSearch") return "web";
  if (type === "tool-WebFetch") return "fetch";
  if (type === "tool-Task" || type === "tool-Agent" || type === "tool-Subagent") return "agent";
  return "other";
}

/** Which kinds a title names first when a group did more than two kinds of thing: changes before reads. */
const KIND_PRIORITY: WorkKind[] = ["edit", "command", "read", "search", "web", "fetch", "agent", "other"];

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const times = (count: number) => (count === 1 ? "once" : count === 2 ? "twice" : `${count} times`);

function kindPhrase(kind: WorkKind, count: number): string {
  switch (kind) {
    case "edit": return `Edited ${plural(count, "file")}`;
    case "command": return `Ran ${plural(count, "command")}`;
    case "read": return `Read ${plural(count, "file")}`;
    case "search": return `Searched code ${times(count)}`;
    case "web": return `Searched the web ${times(count)}`;
    case "fetch": return `Fetched ${plural(count, "page")}`;
    case "agent": return `Ran ${plural(count, "subagent")}`;
    default: return `Used ${plural(count, "tool")}`;
  }
}

/** The file a read or an edit touched, so reading one file twice counts once. */
function touchedFile(part: ToolPartBase): string | undefined {
  if (!isRecord(part.input)) return undefined;
  const path = part.input.file_path ?? part.input.path ?? part.input.notebook_path;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

type KindTally = { kind: WorkKind; calls: number; files: Set<string>; first: number };

function tallyKinds(items: AssistantToolItem[]): KindTally[] {
  const tallies = new Map<WorkKind, KindTally>();
  items.forEach((item, index) => {
    const kind = workKindOf(item.part.type);
    let tally = tallies.get(kind);
    if (!tally) tallies.set(kind, (tally = { kind, calls: 0, files: new Set(), first: index }));
    const file = kind === "read" || kind === "edit" ? touchedFile(item.part) : undefined;
    if (file) {
      if (!tally.files.has(file)) tally.calls += 1;
      tally.files.add(file);
    } else tally.calls += 1;
  });
  return [...tallies.values()];
}

/** The headline of the latest thought in `items` that has text: a group of thoughts alone is titled with it. */
function latestThoughtTitle(items: AssistantToolItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const heading = thoughtHeadline(thoughtTextFromPart(items[index]!.part));
    if (heading) return heading;
  }
  return "";
}

/**
 * Title for a group of calls: what was done, by kind, such as "Read 3 files and ran 3 commands" or "Edited 2 files".
 * Up to three kinds are named, in the order they first ran; with more, the two that changed most (edits, then
 * commands, then reads) are named and the rest counted as other actions. Thoughts are left out; a group of thoughts alone takes its latest thought's line.
 */
export function workGroupTitle(items: AssistantToolItem[]): string {
  const tallies = tallyKinds(items);
  const work = tallies.filter((tally) => tally.kind !== "thought");
  if (work.length === 0) return latestThoughtTitle(items) || (tallies.length > 0 ? "Thought" : "");
  // Three kinds still read as one line; past that the rest are counted.
  const named = [...work]
    .sort((a, b) => KIND_PRIORITY.indexOf(a.kind) - KIND_PRIORITY.indexOf(b.kind))
    .slice(0, work.length === 3 ? 3 : 2)
    .sort((a, b) => a.first - b.first);
  const rest = work.filter((tally) => !named.includes(tally)).reduce((sum, tally) => sum + tally.calls, 0);
  const phrases = named.map((tally, index) => {
    const phrase = kindPhrase(tally.kind, tally.calls);
    return index === 0 ? phrase : phrase[0]!.toLowerCase() + phrase.slice(1);
  });
  if (rest > 0) phrases.push(plural(rest, "other action"));
  return phrases.length > 1 ? `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}` : phrases[0]!;
}

/**
 * A group's header: the headline of the run's latest thought before its last call (the headline the person last saw
 * while the run was live), with a short tag of what the calls did (`summary`: "Ran 1 command", or "8 actions" for a
 * mix); otherwise what the calls did (`workGroupTitle`) and no summary. A thought after the last call is about what
 * comes next, not about this run. A running run is shown by the live row, not as a group, so a group line is drawn
 * only once its run has ended and never changes. `thought` is set when a thought is the title, so the row shows the
 * thinking icon beside it.
 */
export function workGroupHeading(items: AssistantToolItem[]): { title: string; summary?: string; thought?: true } {
  const title = workGroupTitle(items);
  let lastCall = -1;
  items.forEach((item, index) => {
    if (workKindOf(item.part.type) !== "thought") lastCall = index;
  });
  const thought = lastCall > 0 ? latestThoughtTitle(items.slice(0, lastCall)) : "";
  if (!thought) return { title };
  // Short beside a thought: one kind keeps its phrase ("Ran 3 commands"), a mix counts its calls ("8 actions").
  const kinds = tallyKinds(items).filter((tally) => tally.kind !== "thought").length;
  const calls = items.filter((item) => workKindOf(item.part.type) !== "thought").length;
  return { title: thought, summary: kinds === 1 ? title : plural(calls, "action"), thought: true };
}

/**
 * The part type whose icon stands for a group: its calls' type when they are all of one kind ("tool-Thinking" when
 * it holds only thoughts), undefined for a mix.
 */
export function workGroupIconType(items: AssistantToolItem[]): string | undefined {
  const tallies = tallyKinds(items);
  const work = tallies.filter((tally) => tally.kind !== "thought");
  if (work.length === 0) return tallies.length > 0 ? "tool-Thinking" : undefined;
  if (work.length > 1) return undefined;
  return items.find((item) => workKindOf(item.part.type) === work[0]!.kind)?.part.type;
}

/** What `foldTurnWork` needs to know of one segment of a finished turn. */
export type FoldRow = {
  kind: TurnSegment["kind"];
  /** Tool calls and thoughts only. */
  toolsOnly?: boolean;
  /** A reply row with text (narration, or the answer), calls written beside the text included. */
  text?: boolean;
  /** A person's message steered into the turn. */
  steer?: boolean;
  /**
   * Stays in view whatever the fold: an error, a question, an approval, a notice, a marker of Mousse's own, calls
   * holding a failure the agent did not get past, or subagent cards still going or failed without being continued.
   */
  keep?: boolean;
};

/**
 * The parts of a finished turn that each get their own fold line, as ranges of its rows: the rows before the first
 * steered message ("Worked for"), then each steered message with the rows after it ("Continued for"). A turn nobody
 * steered is one part.
 */
export function turnFoldParts(rows: ReadonlyArray<Pick<FoldRow, "steer">>): Array<{ from: number; to: number }> {
  const parts: Array<{ from: number; to: number }> = [];
  let from = 0;
  rows.forEach((row, index) => {
    if (!row.steer || index === 0) return;
    parts.push({ from, to: index });
    from = index;
  });
  parts.push({ from, to: rows.length });
  return parts;
}

/**
 * Which rows of a finished turn fold behind their part's line (see `turnFoldParts`): the work (thoughts, tool groups,
 * narration, settled subagent cards). Each part's last reply row stays below its line, whether it is the answer, a
 * reply to a steered message or the last thing a stopped turn said: what was said to the person is never hidden. What
 * needs the person stays in view too: errors and failures the agent did not get past, questions, approvals, notices,
 * Mousse's own markers, steered messages, and subagent cards still running or failed without being continued (`keep`).
 */
export function foldTurnWork(rows: FoldRow[]): boolean[] {
  const folded = rows.map(() => false);
  for (const { from, to } of turnFoldParts(rows)) {
    let reply = -1;
    for (let index = to - 1; index >= from; index -= 1) {
      const row = rows[index]!;
      if (row.kind === "message" && row.text && !row.toolsOnly && !row.keep && !row.steer) {
        reply = index;
        break;
      }
    }
    for (let index = from; index < to; index += 1) {
      const row = rows[index]!;
      if (row.steer || row.keep || index === reply) continue;
      folded[index] = true;
    }
  }
  return folded;
}

/** Time the agent waited on the person (an approval, a question, a secret); `to` is null while it still waits. */
export type WaitSpan = { from: number; to: number | null };

/** The span from `from` to `to` less the time in `waits` (overlaps count once): how long the agent worked in it. */
export function activeMs(from: number, to: number, waits: readonly WaitSpan[]): number {
  const clipped = waits
    .map((wait) => ({ from: Math.max(from, wait.from), to: Math.min(to, wait.to ?? to) }))
    .filter((wait) => wait.to > wait.from)
    .sort((a, b) => a.from - b.from);
  let waited = 0;
  let reach = from;
  for (const wait of clipped) {
    const start = Math.max(wait.from, reach);
    if (wait.to > start) waited += wait.to - start;
    reach = Math.max(reach, wait.to);
  }
  return Math.max(0, to - from - waited);
}

/**
 * Each part's own working time (see `turnFoldParts`), not the time since the prompt. The parts tile the turn: a part
 * starts when its prompt or steered message was sent and runs until the next steered message was sent (the agent
 * worked the whole time; a command running when the steer came in has not ended yet), the last one until its newest
 * message ended. Time spent waiting on the person does not count. Null when nothing says when the turn started.
 */
export function partWorkTimes(
  parts: ReadonlyArray<{ startedAt: number | null; endedAt: number | null }>,
  waits: readonly WaitSpan[],
): Array<number | null> {
  let previousEnd: number | null = null;
  return parts.map((part, index) => {
    const start: number | null =
      part.startedAt == null ? previousEnd : previousEnd == null ? part.startedAt : Math.max(part.startedAt, previousEnd);
    if (start == null) return null;
    const next = parts[index + 1]?.startedAt ?? null;
    const end = Math.max(next ?? part.endedAt ?? start, start);
    previousEnd = end;
    return activeMs(start, end, waits);
  });
}


const PERMISSION_PART = "data-permission-request";
const SECRET_PART = "data-secret-request";

function timeOf(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const ms = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Mousse's `secret_request` call, however the runtime names it (`mcp__mousse__secret_request`, a bare
 * `secret_request`, or the name an ACP agent leaves in the call's summary).
 */
function isSecretRequestCall(part: Record<string, unknown>): boolean {
  if (typeof part.type !== "string" || !part.type.startsWith("tool-")) return false;
  const bare = (name: string) => name.trim().split("__").pop() === "secret_request";
  const summary = isRecord(part.input) && typeof part.input.summary === "string" ? part.input.summary : "";
  return bare(part.type.slice(5)) || bare(summary);
}

/**
 * When a turn's messages say the agent waited on the person: an approval from when it was asked until it was answered
 * (still waiting while pending), a secret request while it is open, and a question until its answers when nothing
 * ran in between (a question asked without waiting lets the agent go on, so its time counts). A `secret_request`
 * call blocks until the person answers, declines or an hour passes, so once it ended its wait runs from the call to
 * its saved end (`endedAt`, when its result arrived), which stays after the open request is gone. A call saved
 * without its end (an older transcript) counts only while its request is open.
 */
export function turnWaitSpans(messages: ReadonlyArray<SettleTurnMessage & { createdAt?: unknown }>): WaitSpan[] {
  const spans: WaitSpan[] = [];
  messages.forEach((message, index) => {
    const at = timeOf(message.createdAt);
    for (const part of message.parts ?? []) {
      if (!isRecord(part)) continue;
      if (part.type === PERMISSION_PART && isRecord(part.data)) {
        if (at == null) continue;
        if (part.data.status === "pending") spans.push({ from: at, to: null });
        else {
          const to = timeOf(part.data.settledAt);
          if (to != null) spans.push({ from: at, to });
        }
      } else if (part.type === SECRET_PART && isRecord(part.data)) {
        const from = at ?? timeOf(part.data.createdAt);
        if (from != null) spans.push({ from, to: null });
      } else if (isSecretRequestCall(part)) {
        const from = timeOf(part.startedAt) ?? at;
        const to = timeOf(part.endedAt);
        if (from != null && to != null && to > from) spans.push({ from, to });
      } else if (part.type === "tool-Question" && at != null) {
        const next = messages[index + 1];
        const answered = next?.parts?.some((p) => isRecord(p) && p.type === "tool-QuestionAnswers");
        if (answered) {
          const to = timeOf(next!.createdAt);
          if (to != null) spans.push({ from: at, to });
        } else if (index === messages.length - 1 && (part.state === "input-streaming" || part.state === "input-available")) {
          spans.push({ from: at, to: null });
        }
      }
    }
  });
  return spans;
}

/**
 * Partition a turn's assistant messages into render segments: runs of
 * consecutive activity messages (tools and thoughts) collapse into one group
 * when they hold at least `minCalls` calls (`callCounts` per message, one
 * when absent); consecutive subagent-card messages form one card list,
 * outside any group; everything else renders message by message. Narration
 * (a reply row) between calls ends a group.
 *
 * With `cardBurst`, subagents started in quick succession share one card list
 * even with thinking between them: a card message joins the list before it
 * when only `quiet` messages (thoughts) lie between them and `join` accepts the
 * pair; those thoughts render just above the list. Anything else between them
 * (tool work, narration) starts a new list.
 */
export type CardBurst = {
  /** A message that may sit between two starts of one burst (a thought). */
  quiet: (msgIndex: number) => boolean;
  /** Whether the card message `next` joins the list whose last card message is `last`. */
  join: (last: number, next: number) => boolean;
};

/** Starts at most this far apart join one card. A start waits for the call before it to return, about 10 s. */
export const SUBAGENT_BURST_GAP_MS = 30_000;

export function partitionTurnSegments(
  toolsOnlyFlags: boolean[],
  cardsOnlyFlags: boolean[] = [],
  callCounts: number[] = [],
  /** Whether a run of fewer calls still folds into a group (while the turn runs, one with a call still running). */
  groupSmallRun?: (msgIndices: number[]) => boolean,
  cardBurst?: CardBurst,
): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let run: number[] = [];
  let cards: number[] = [];
  // Thoughts after the open card list, held until it is known whether the next start joins that list.
  let held: number[] = [];
  const flush = () => {
    const calls = run.reduce((sum, msgIndex) => sum + (callCounts[msgIndex] ?? 1), 0);
    if (run.length > 0 && (calls >= 2 || groupSmallRun?.(run))) {
      segments.push({ kind: "tools", msgIndices: run });
    } else {
      for (const msgIndex of run) segments.push({ kind: "message", msgIndex });
    }
    run = [];
  };
  const flushCards = () => {
    if (cards.length > 0) segments.push({ kind: "cards", msgIndices: cards });
    cards = [];
  };
  const place = (msgIndex: number) => {
    if (toolsOnlyFlags[msgIndex]) {
      run.push(msgIndex);
    } else {
      flush();
      segments.push({ kind: "message", msgIndex });
    }
  };
  const release = () => {
    const thoughts = held;
    held = [];
    thoughts.forEach(place);
  };
  toolsOnlyFlags.forEach((_flag, msgIndex) => {
    if (cardsOnlyFlags[msgIndex]) {
      const last = cards[cards.length - 1];
      if (last !== undefined && cardBurst && !cardBurst.join(last, msgIndex)) {
        flushCards();
        release();
      } else if (held.length > 0) {
        // The start joins the list: the thoughts that came between render above it.
        release();
      }
      flush();
      cards.push(msgIndex);
      return;
    }
    if (cards.length > 0 && cardBurst?.quiet(msgIndex)) {
      held.push(msgIndex);
      return;
    }
    flushCards();
    release();
    place(msgIndex);
  });
  flushCards();
  release();
  flush();
  return segments;
}
