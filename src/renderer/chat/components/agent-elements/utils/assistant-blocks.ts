import { latestThoughtHeading } from "./format-tool";
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
const STANDALONE_TOOL_TYPES = new Set(["tool-Question", "tool-QuestionAnswers", "tool-QuickAction", "tool-ExitPlanMode", "tool-PlanWrite"]);

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
 * A model switch marker: Mousse's line naming the model that takes over, drawn where the turn starts. Like a
 * compaction row it is neither the answer nor a note, so a finished turn does not fold it into its activity.
 */
function isHandoffMarker(message: SettleTurnMessage): boolean {
  return (message.metadata as { contextHandoff?: unknown } | undefined)?.contextHandoff != null;
}

/** The text of a reply row, or "" when the message is not one. */
function replyText(message: SettleTurnMessage): string {
  if (message.role !== "assistant" || isCompactionRow(message) || isHandoffMarker(message)) return "";
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
function thoughtTextFromPart(part: ToolPartBase): string {
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

/** A thought still being written: while the turn runs it is the turn's live line, never folded into a group. */
export function isLiveThoughtItem(item: AssistantToolItem | undefined): boolean {
  return item?.part.type === "tool-Thinking" && item.part.state === "input-available";
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

/** One line from the latest thought in `items` that has text: a group of thoughts alone is titled with it. */
function latestThoughtTitle(items: AssistantToolItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const heading = latestThoughtHeading(thoughtTextFromPart(items[index]!.part));
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
  /** A reply row with text (narration, or the answer). */
  text?: boolean;
  /** A person's message steered into the turn. */
  steer?: boolean;
  /**
   * Stays in view whatever the fold: an error, a question, an approval, a notice, a marker of Mousse's own, or calls
   * holding a failure the agent did not get past.
   */
  keep?: boolean;
  /** Cards of which one still works. */
  running?: boolean;
};

/**
 * Which segments of a finished turn fold behind its "Worked for" line: the work (thoughts, tool groups, narration,
 * finished subagents), not the answer. The answer is the last reply row with no work after it; a turn cut off
 * before it wrote one folds all of its work. What needs the person stays in view: errors and failures the agent did
 * not get past, questions, approvals, notices, Mousse's own markers, steered messages and the replies written before
 * them, and subagents still working.
 */
export function foldTurnWork(rows: FoldRow[]): boolean[] {
  let answer = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (row.kind === "tools") break;
    if (row.kind === "cards") continue;
    if (row.steer || row.toolsOnly) break;
    if (row.keep) continue;
    if (row.text) answer = index;
    break;
  }
  let lastSteer = -1;
  rows.forEach((row, index) => {
    if (row.steer) lastSteer = index;
  });
  return rows.map((row, index) => {
    if (row.kind === "tools") return !row.keep;
    if (row.kind === "cards") return !row.running;
    if (row.steer || row.keep || index === answer) return false;
    if (row.toolsOnly) return true;
    return !(row.text && index < lastSteer);
  });
}

/**
 * Partition a turn's assistant messages into render segments: runs of
 * consecutive activity messages (tools and thoughts) collapse into one group
 * when they hold at least `minCalls` calls (`callCounts` per message, one
 * when absent); consecutive subagent-card messages form one card list,
 * outside any group; everything else renders message by message. Narration
 * (a reply row) between calls ends a group.
 */
export function partitionTurnSegments(
  toolsOnlyFlags: boolean[],
  cardsOnlyFlags: boolean[] = [],
  callCounts: number[] = [],
  /** Whether a run of fewer calls still folds into a group (while the turn runs, one with a call still running). */
  groupSmallRun?: (msgIndices: number[]) => boolean,
): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let run: number[] = [];
  let cards: number[] = [];
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
  toolsOnlyFlags.forEach((flag, msgIndex) => {
    if (cardsOnlyFlags[msgIndex]) {
      flush();
      cards.push(msgIndex);
      return;
    }
    flushCards();
    if (flag) {
      run.push(msgIndex);
    } else {
      flush();
      segments.push({ kind: "message", msgIndex });
    }
  });
  flush();
  flushCards();
  return segments;
}
