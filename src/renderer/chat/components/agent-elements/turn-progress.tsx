import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { UIMessage } from "ai";
import { Collapse } from "../../../components/ui/Collapse";
import { LiveRunBodyContext, dropLiveRunFocus, liveRunToggleFocus, useToolOpen } from "./tools/tool-open-state";
import { IconChevronRight } from "../../../lib/icons";
import { useReplyPacing } from "../../../lib/replyPacingSetting";
import type { TurnPhase, TurnSetupStep, TurnStep } from "../../../../shared/types";
import { isWaitingPermissionRequest } from "./tools/permission-request";
import { useSubagentCards } from "./tools/subagent-cards-context";
import type { SubagentCardModel } from "../../adapters/subagentCards";
import { parseMcpToolType } from "./tools/tool-registry";
import { cuaPresentation, mousseToolLabels, mousseToolOf, mousseToolSubject } from "./tools/mousse-tools";
import { isCompactionRow, thoughtSourceOf, thoughtTextFromPart, type ToolPartBase } from "./utils/assistant-blocks";
import { liveThoughtText, thoughtHeadline } from "./utils/format-tool";
import { commandLabel } from "../../../../shared/agentActivity";
import { useLiveThought } from "../../../stores/liveTextStore";
import { ThinkingIcon } from "../../../lib/icons";
import { ToolIcon } from "./tools/tool-icon";
import { useOffscreenPause } from "../../../lib/offscreenMotion";
import { countRender } from "./render-counts";
import "./turn-progress.css";

/**
 * What the line under a running turn's Working reads from the thread: the turn's phase and step as
 * the service reports them, and whether a Stop is on its way. Without it (a list shown on its own)
 * the line reads the chat status and the messages only.
 */
export type TurnProgressState = {
  phase?: TurnPhase;
  step?: TurnStep;
  stopping?: boolean;
  /** The thread, and when the service last changed its turn state: together they name one sighting of a step. */
  threadId?: string | null;
  /** When the current turn (or optimistic subagent startup) began, for the Working timer before a prompt is saved. */
  startedAt?: string;
  updatedAt?: string;
  /**
   * A person's steer is held (`TurnState.heldSteer`): the line's tooltip says when it goes in. `turn_end`: strict
   * release keeps it until the agent's turn ends, and no call of the turn runs (`HeldSteer.untilTurnEnd`), so a tool
   * the line shows (a subagent's, a background call) is not what it waits for.
   */
  steerHeld?: boolean | "turn_end";
};

/** The tooltip sentence a running tool's line adds while a steer waits for it. */
export const STEER_HELD_TITLE = "Your steer goes in when it finishes.";
/** The same, while strict release keeps the steer until the agent's turn ends. */
export const STEER_HELD_TURN_END_TITLE = "Your steer goes in when the turn ends.";

export const TurnProgressContext = createContext<TurnProgressState | null>(null);

export function useTurnProgressState(): TurnProgressState | null {
  return useContext(TurnProgressContext);
}

export type TurnProgressKind =
  | "starting"
  | "preparing"
  | "waiting"
  | "thinking"
  | "writing"
  | "preparing-tool"
  | "running-tool"
  | "ran-tool"
  | "failed-tool"
  | "subagents"
  | "retrying"
  | "stopping"
  | "compacting"
  | "finishing";

export type TurnProgress = {
  kind: TurnProgressKind;
  label: string;
  /** More about it, for the tooltip. */
  title?: string;
  /** What the call works on (its command, file or query), shown dim after the label. */
  detail?: string;
  /** Other calls running beside the one named: "+2 running". */
  more?: number;
  /** A retry's start (ms): the label counts down to it. */
  until?: number;
  /** The call's part type: the line shows its icon (pulsing while it runs) instead of the dots. */
  tool?: string;
};

export type TurnProgressInput = {
  state: TurnProgressState | null;
  /** The running turn's assistant messages, in order. */
  messages: readonly UIMessage[];
  /** When this window first saw the turn's step (ms, its own clock): a retry counts down from there. */
  stepSince?: number;
  /** The turn ended, and subagents it started still work. */
  awaitingSubagents?: boolean;
  /** How many subagents the turn is still starting (no name or no task yet): their cards are not drawn. */
  spawningSubagents?: number;
  /** Nothing else of the turn is shown (it has no output yet): the line says everything, a compaction too. */
  standalone?: boolean;
  now: number;
};

type Part = { type?: string; state?: string; input?: unknown; output?: unknown; text?: string; subagentTool?: unknown; toolCallId?: string; useToolTarget?: unknown };

/** Fields a call's row has before its arguments arrive; they say nothing about what it will do. */
const PLACEHOLDER_INPUT_KEYS = new Set(["label", "cwd"]);

const NOT_TOOLS = new Set(["tool-Thinking", "tool-QuestionAnswers", "tool-PlanWrite"]);

function toolName(type: string): string {
  const mcp = parseMcpToolType(type);
  if (mcp) return mcp.displayName;
  const name = type.slice("tool-".length);
  return name === "Generic" || name === "mcp__custom__tool" ? "tool" : name;
}

function inputDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "pattern", "query", "url", "description", "prompt"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      const line = value.trim().split("\n")[0]!;
      return line.length > 120 ? `${line.slice(0, 117)}…` : line;
    }
  }
  return undefined;
}

function isCall(part: Part | undefined): part is Part & { type: string } {
  return typeof part?.type === "string" && part.type.startsWith("tool-") && !NOT_TOOLS.has(part.type);
}

function isRunningTool(part: Part): boolean {
  return isCall(part) && (part.state === "input-streaming" || part.state === "input-available");
}

/** A call the provider ran on behalf of another (a subagent's): named by its parent's line, not counted beside it. */
function isNestedCall(part: Part): boolean {
  return typeof part.toolCallId === "string" && part.toolCallId.includes(":");
}

const FILE_TYPES = new Set(["tool-Read", "tool-Edit", "tool-MultiEdit", "tool-Write", "tool-NotebookEdit"]);
const EDIT_TYPES = new Set(["tool-Edit", "tool-MultiEdit", "tool-Write", "tool-NotebookEdit"]);

/** What a call works on, in a few words: a command as run (no shell wrapper), a file's name, a query. */
function callDetail(part: Part & { type: string }): string | undefined {
  const input = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : undefined;
  if (part.type === "tool-Bash" && typeof input?.command === "string" && input.command.trim()) {
    const line = commandLabel(input.command);
    return line.length > 120 ? `${line.slice(0, 117)}…` : line;
  }
  if (FILE_TYPES.has(part.type)) {
    const path = input?.file_path ?? input?.path ?? input?.notebook_path;
    if (typeof path === "string" && path.trim()) return path.trim().split(/[\\/]/).pop();
  }
  return inputDetail(part.input);
}

/**
 * One call in a few words, in its tense: "Running npm test", "Ran npm test", "Bash failed" with "npm test" as its
 * detail. The live row says a call that just finished this way, and a run of one call is titled with it.
 */
export function callPhrase(part: Part & { type: string }, tense: "running" | "done" | "failed"): { label: string; detail?: string } {
  // A computer use call says what it did and one kept detail, never its raw arguments.
  const cua = cuaPresentation(part);
  if (cua) return { label: cua.labels[tense], ...(cua.detail ? { detail: cua.detail } : {}) };
  const detail = callDetail(part);
  const mousseTool = mousseToolOf(part.type);
  if (mousseTool) {
    const labels = mousseToolLabels(mousseTool);
    const subject = mousseToolSubject(mousseTool, part.input) ?? detail;
    return { label: tense === "running" ? labels.running : tense === "done" ? labels.done : labels.failed, detail: subject };
  }
  const name = toolName(part.type);
  if (tense === "failed") return { label: part.type === "tool-Bash" ? "Failed" : `${name} failed`, detail };
  const running = tense === "running";
  if (part.type === "tool-Bash") return { label: running ? "Running" : "Ran", detail };
  if (part.type === "tool-Read") return { label: running ? "Reading" : "Read", detail };
  if (EDIT_TYPES.has(part.type)) return { label: running ? "Editing" : "Edited", detail };
  if (part.type === "tool-Grep" || part.type === "tool-Glob") return { label: running ? "Searching" : "Searched", detail };
  if (part.type === "tool-WebSearch") return { label: running ? "Searching the web" : "Searched the web", detail };
  if (part.type === "tool-WebFetch") return { label: running ? "Fetching" : "Fetched", detail };
  if (part.type === "tool-Task" || part.type === "tool-Agent" || part.type === "tool-Subagent") {
    return { label: running ? "Running subagent" : "Ran subagent", detail };
  }
  return { label: running ? `Running ${name}` : `Used ${name}`, detail };
}

/** A call's phrase as one line: a run of one call is titled with it. */
export function callTitle(part: { type: string; state?: string; input?: unknown }, failed = false): string {
  const tense = failed ? "failed" : isRunningTool(part) ? "running" : "done";
  const { label, detail } = callPhrase(part, tense);
  return detail ? `${label} ${detail}` : label;
}

function toolProgress(part: Part): TurnProgress {
  const cua = cuaPresentation(part);
  if (cua) {
    const label = `${cua.labels.running}…`;
    return cua.input ? { kind: "running-tool", label, title: cua.detail, detail: cua.detail, tool: part.type } : { kind: "preparing-tool", label, tool: part.type };
  }
  const detail = inputDetail(part.input);
  if (part.type === "tool-Subagent" || part.type === "tool-Task" || part.type === "tool-Agent" || part.subagentTool) {
    return { kind: "running-tool", label: "Running subagent…", title: detail, detail };
  }
  // A tool search loads tools for the model: the line says what its row says.
  if (part.type === "tool-ToolSearch") return { kind: "running-tool", label: "Loading tools…", title: detail, detail, tool: part.type };
  const name = toolName(part.type!);
  // A call whose arguments are still streaming in: the model is writing it (a runtime that opens the row at the
  // call's start, before its arguments, shows it running with none).
  const noInput = !part.input || (typeof part.input === "object" && Object.entries(part.input as object).every(
    // A command row carries its working folder and a placeholder label before its command arrives.
    ([key, value]) => PLACEHOLDER_INPUT_KEYS.has(key) || value === undefined || value === null || value === "",
  ));
  const preparing = part.state === "input-streaming" || noInput;
  // Mousse's own tools say what they do, from the start: "Creating a thread in Mousse…".
  const mousseTool = mousseToolOf(part.type);
  if (mousseTool) {
    const label = `${mousseToolLabels(mousseTool).running}…`;
    const subject = mousseToolSubject(mousseTool, part.input) ?? detail;
    return preparing ? { kind: "preparing-tool", label, title: subject, tool: part.type } : { kind: "running-tool", label, title: subject, detail: subject, tool: part.type };
  }
  if (preparing) return { kind: "preparing-tool", label: `Preparing ${name}…`, title: detail, tool: part.type };
  return { kind: "running-tool", label: `Running ${name}…`, title: detail, detail, tool: part.type };
}

/** How long a sighting is kept: longer than any retry's wait. */
const SIGHTING_MS = 10 * 60_000;

/**
 * When this window first saw each step, by thread and by the state change that carried it (the service's
 * `updatedAt`). A retry's wait is sent as a duration, so a window on another computer counts it down on its own
 * clock. A copy of the same state read again (a window that reads its thread after missing events) keeps its first
 * sighting, so the countdown does not start over; another retry, even one that says the same, is a new state.
 */
const stepSightings = new Map<string, number>();

export function stepSeenAt(state: TurnProgressState | null | undefined, now = Date.now()): number | undefined {
  const step = state?.step;
  if (!step) return undefined;
  const key = JSON.stringify([state.threadId ?? "", state.updatedAt ?? "", step]);
  const seen = stepSightings.get(key);
  if (seen !== undefined) return seen;
  for (const [other, at] of stepSightings) if (now - at > SIGHTING_MS) stepSightings.delete(other);
  stepSightings.set(key, now);
  return now;
}

/** The steps that show the thinking icon: those that read "Thinking…", and the turn's start. */
const THINKING_KINDS: ReadonlySet<TurnProgressKind> = new Set(["thinking", "starting", "preparing", "waiting", "finishing"]);

/** A turn not started yet reads "Starting…"; the wait for the model's first output says only that it thinks. */
const STARTING: TurnProgress = { kind: "starting", label: "Starting…", title: "Starting the agent and its tools" };
const WAITING: TurnProgress = { kind: "waiting", label: "Thinking…", title: "Waiting for the model's first output" };
/** A step of the turn's setup that took a moment (`TurnStep` `preparing`), before the agent starts. */
const PREPARING: Record<TurnSetupStep, TurnProgress> = {
  check: { kind: "preparing", label: "Checking worktree…", title: "Checking this thread's worktree before the turn. Waits for other work on the same repository." },
  worktree: { kind: "preparing", label: "Creating worktree…", title: "Making this thread's worktree: a copy of the project on a new branch" },
  restore: { kind: "preparing", label: "Restoring worktree…", title: "Making this thread's worktree again from its last snapshot" },
  snapshot: { kind: "preparing", label: "Taking snapshot…", title: "Recording the worktree's files before the turn, so Undo can bring them back. Waits for other work on the same repository." },
};
const WRITING: TurnProgress = { kind: "writing", label: "Writing…" };

function hasContent(messages: readonly UIMessage[]): boolean {
  return messages.some((message) =>
    (message.parts ?? []).some((part) => {
      const p = part as Part;
      if (p.type === "text") return Boolean(p.text?.trim());
      return typeof p.type === "string" && p.type !== "step-start";
    }),
  );
}

/** Whether the turn's latest reply ends on text with words in it: the text being written is what shows. */
function textOnScreen(messages: readonly UIMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    const parts = (message.parts ?? []) as Part[];
    const end = parts[parts.length - 1];
    return end?.type === "text" && Boolean(end.text?.trim());
  }
  return false;
}

/**
 * What a running turn does now, in a few words: the second line of the turn's live row. Null where something else in
 * the turn already says it (an approval waiting, a compaction running, an answer the agent waits for, which the header
 * shows, or text being written, which is on screen). A call that just finished is said in the past tense until
 * something new starts. A turn sent and not started yet (its thread, workspace, agent and tools being set up) reads
 * "Starting…"; waiting for the model and finishing read "Thinking…", with what it is in the tooltip.
 */
export function describeTurnProgress(input: TurnProgressInput): TurnProgress | null {
  const progress = describeProgress(input);
  // The line keeps "Running Bash…" while a steer waits for it; the Steer block shows the wait, the tooltip says when.
  if (progress && input.state?.steerHeld && (progress.kind === "running-tool" || progress.kind === "preparing-tool")) {
    const when = input.state.steerHeld === "turn_end" ? STEER_HELD_TURN_END_TITLE : STEER_HELD_TITLE;
    return { ...progress, title: progress.title ? `${progress.title}\n${when}` : when };
  }
  return progress;
}

/** The calls in `messages` whose subagent card is still starting. */
export function countSpawningSubagents(messages: readonly UIMessage[], cards: ReadonlyMap<string, SubagentCardModel>): number {
  if (cards.size === 0) return 0;
  let count = 0;
  for (const message of messages)
    for (const part of (message.parts ?? []) as Part[])
      if (typeof part.toolCallId === "string" && cards.get(part.toolCallId)?.spawning) count += 1;
  return count;
}

function describeProgress({ state, messages, stepSince, awaitingSubagents, spawningSubagents, standalone, now }: TurnProgressInput): TurnProgress | null {
  const phase = state?.phase;
  const step = state?.step;
  if (state?.stopping) return { kind: "stopping", label: "Stopping…" };
  if (phase === "awaiting_input") return null;
  if (messages.some(isWaitingPermissionRequest)) return null;
  const last = messages[messages.length - 1];
  const compacting = last && isCompactionRow(last) && (last.metadata as { compacting?: boolean } | undefined)?.compacting === true;
  if (compacting) return standalone ? { kind: "compacting", label: "Compacting context…" } : null;

  if (step?.kind === "retrying") {
    const until = step.delayMs !== undefined ? (stepSince ?? now) + step.delayMs : NaN;
    const seconds = Number.isFinite(until) ? Math.ceil((until - now) / 1000) : 0;
    const title = step.noResponse
      ? "No answer from the provider yet"
      : step.maxAttempts ? `Attempt ${step.attempt} of ${step.maxAttempts}` : `Attempt ${step.attempt}`;
    return seconds > 0
      ? { kind: "retrying", label: `Retrying in ${seconds}s…`, title, until }
      : { kind: "retrying", label: "Retrying…", title };
  }

  // Subagents still starting have no card yet: the line stands for them until each has a name and a task.
  if (spawningSubagents && spawningSubagents > 0) {
    return { kind: "preparing-tool", label: spawningSubagents === 1 ? "Starting subagent…" : `Starting ${spawningSubagents} subagents…` };
  }

  // What runs now: the latest call still running (the end of the turn's last message first), and how many others run
  // beside it.
  const parts = (last?.parts ?? []) as Part[];
  const tail = parts[parts.length - 1];
  const running: Part[] = [];
  for (const message of messages) for (const part of (message.parts ?? []) as Part[]) if (isRunningTool(part)) running.push(part);
  if (running.length > 0) {
    const named = tail && isRunningTool(tail) ? tail : running[running.length - 1]!;
    const others = running.filter((part) => part !== named && !isNestedCall(part)).length;
    const progress = toolProgress(named);
    return others > 0 ? { ...progress, more: others } : progress;
  }
  // A thought being written: the row above this line shows its headline.
  if (tail?.type === "tool-Thinking" && tail.state === "input-available") return { kind: "thinking", label: "Thinking…" };
  if (step?.kind === "reasoning") return { kind: "thinking", label: "Thinking…" };
  // The latest call finished and nothing new started: say what it did, not that something still runs.
  if (isCall(tail) && (tail.state === "output-available" || tail.state === "output-error") && !tail.subagentTool) {
    const failed = tail.state === "output-error" || (tail as { output?: { success?: unknown } }).output?.success === false;
    const { label, detail } = callPhrase(tail, failed ? "failed" : "done");
    return { kind: failed ? "failed-tool" : "ran-tool", label, detail, title: detail, tool: tail.type };
  }

  if (step?.kind === "starting") return STARTING;
  if (step?.kind === "preparing") return PREPARING[step.what] ?? STARTING;
  if (step?.kind === "waiting") return WAITING;

  const content = hasContent(messages);
  switch (phase) {
    case "streaming":
      // Text being written is on screen already (a steer may sit under it): nothing to add. Before its first words
      // show, say so.
      return textOnScreen(messages) ? null : { kind: "writing", label: "Writing…" };
    case "tool_running":
      return { kind: "running-tool", label: "Running tools…" };
    case "finalizing":
      return { kind: "finishing", label: "Thinking…", title: "Finishing the turn" };
    case "thinking":
      return content ? { kind: "thinking", label: "Thinking…" } : WAITING;
    case "queued":
      return STARTING;
  }
  if (awaitingSubagents) return { kind: "subagents", label: "Waiting for subagents…" };
  // Sent, and the service has not started the turn yet (or this list has no thread behind it).
  if (!content) return STARTING;
  return { kind: "thinking", label: "Thinking…" };
}

/** How often the live row's status region speaks at most: a step that changes sooner is said once this has passed. */
export const ANNOUNCE_EVERY_MS = 2000;

/**
 * What a screen reader hears for a step of the live row: a few calm words, never the thought's headline or a
 * countdown. "Thinking", "Running Bash npm test", "Ran npm test", "Retrying"; nothing when the row has nothing to say.
 */
export function announcementOf(progress: TurnProgress | null): string {
  if (!progress) return "";
  switch (progress.kind) {
    case "starting":
      return "Starting";
    case "waiting":
    case "thinking":
    case "finishing":
      return "Thinking";
    case "retrying":
      return "Retrying";
    case "writing":
      return "Writing";
    case "stopping":
      return "Stopping";
    case "compacting":
      return "Compacting context";
    case "subagents":
      return "Waiting for subagents";
  }
  const words = progress.label.replace(/…$/, "");
  return progress.detail ? `${words} ${progress.detail}` : words;
}

/**
 * Writes `text` into the live region `ref` at most once every ANNOUNCE_EVERY_MS: a change sooner waits for the end of
 * that interval, and only the latest text by then is said. The region's text is set directly, so a step change
 * renders nothing more than it did. An empty text clears it at once and does not count as speaking.
 */
function useCalmAnnouncement(ref: { current: HTMLElement | null }, text: string): void {
  const saidAt = useRef(-Infinity);
  useEffect(() => {
    const region = ref.current;
    if (!region || region.textContent === text) return;
    const say = () => {
      region.textContent = text;
      if (text) saidAt.current = Date.now();
    };
    const wait = text ? saidAt.current + ANNOUNCE_EVERY_MS - Date.now() : 0;
    if (wait <= 0) {
      say();
      return;
    }
    const timer = window.setTimeout(say, wait);
    return () => window.clearTimeout(timer);
  }, [ref, text]);
}

/**
 * The turn's current run of work (its thoughts and calls since the last text), which the live row stands for while it
 * runs: no group line is drawn for it until it ends.
 */
export type LiveRun = {
  /** The open-state key of the group line the run becomes, so a run opened here is open there too. */
  openKey: string;
  /** How many rows it has. */
  count: number;
  /** Calls in it that failed and that nothing has got past yet. */
  failed: number;
  /** Its rows, as its group would show them. */
  rows: ReactNode;
};

/**
 * The live row at the end of a running turn, under its Working: one element for the whole turn, which changes its
 * text and never its place. It is the turn's current run of work (`run`): that run has no group line of its own while
 * it runs, and takes one (its only change of shape) when text starts or the turn ends.
 *
 * - Line 1, while the current run has a thought (`thought`, its latest): the thinking icon and the thought's headline
 *   (`thoughtHeadline`), one line cut at its width. It changes only when the thought starts a new section or
 *   paragraph; the thought's latest paragraph is its tooltip.
 * - Line 2: what the turn does now (`describeTurnProgress`), details in its tooltip, and "· 1 failed" while a call of
 *   the run failed and nothing has got past it. The thinking icon pulses while the turn thinks; a running call's icon
 *   pulses; a call that just finished shows its icon still; anything else (a retry, a stop) shows three small dots.
 *   All move by opacity or transform only, so the row costs no layout or paint while it animates, and each holds
 *   still while no one can see it (scrolled away, or the window hidden: lib/offscreenMotion.ts).
 * - A chevron opens the run's rows under it, in the box a group uses, under the group's open-state key. Open, the box
 *   keeps its newest row in view as rows arrive and as the thought being written grows; that thought shows open.
 *
 * With nothing to say and closed it is hidden, not removed, so it comes back as the same element. A streamed thought
 * delta renders this row alone (it reads the thought's live text, liveTextStore), and the thought's own row too while
 * the run is open. It reads the thread's turn from context, so a memoised turn row still follows it.
 *
 * Screen readers hear a calm summary from a hidden status region beside the row, not the lines themselves:
 * "Thinking" when the turn thinks (not each headline), what a call does as it starts or ends, and "Retrying" once
 * rather than every second of a countdown (`announcementOf`). It speaks at most once every ANNOUNCE_EVERY_MS, saying
 * the latest step. It stays outside the row, so it is there when the row hides and comes back.
 */
export function TurnProgressRow({
  messages,
  awaitingSubagents,
  standalone,
  thought,
  run,
}: {
  messages: readonly UIMessage[];
  awaitingSubagents?: boolean;
  standalone?: boolean;
  /** The latest thought of the turn's current run of work, if it has one. */
  thought?: ToolPartBase;
  /** The turn's current run of work, if one runs. */
  run?: LiveRun;
}) {
  countRender("TurnProgressRow");
  const state = useTurnProgressState();
  const spawningSubagents = countSpawningSubagents(messages, useSubagentCards());
  // The thought as it is written (see liveTextStore), or as the transcript holds it.
  const liveThought = useLiveThought(thought ? thoughtSourceOf(thought) : undefined);
  const thoughtText = liveThought || (thought ? thoughtTextFromPart(thought) : "");
  // A thought still being written keeps its last full paragraph as the line while a new one begins.
  const headline = thoughtHeadline(thoughtText, { live: thought?.state === "input-available" });
  const [ownOpen, setOwnOpen] = useState(false);
  const kept = useToolOpen(run?.openKey, false);
  const open = Boolean(run && run.count > 0) && (kept ? kept[0] : ownOpen);
  const toggle = () => {
    if (kept) kept[1](!kept[0]);
    else setOwnOpen((value) => !value);
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  // Whether the open box shows its end: rows that arrive, and a thought that grows, then keep it in view.
  const atEndRef = useRef(true);
  const count = run?.count ?? 0;
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || !open || !atEndRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [count, open]);
  useEffect(() => {
    const box = scrollRef.current;
    const rows = rowsRef.current;
    if (!open || !box || !rows || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (atEndRef.current) box.scrollTop = box.scrollHeight;
    });
    observer.observe(rows);
    return () => observer.disconnect();
  }, [open]);
  // The clock is read as the line renders, so a countdown that starts shows its right second at once; the timer
  // only renders the line again each second while one runs.
  const [, setTick] = useState(0);
  const now = Date.now();
  const described = describeTurnProgress({ state, messages, stepSince: stepSeenAt(state, now), awaitingSubagents, spawningSubagents, standalone, now });
  // Paced, reply text reaches the screen a finished block at a time, so text in the reply may not show yet: the row
  // still says "Writing…", and turn-progress.css hides it once the reply above it shows text.
  const paced = useReplyPacing();
  const untilText = !described && paced && state?.phase === "streaming" && textOnScreen(messages);
  const progress = untilText ? WRITING : described;
  const until = progress?.until;
  useEffect(() => {
    if (until == null) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  const failed = run && progress?.kind !== "failed-tool" ? run.failed : 0;
  const statusRef = useRef<HTMLSpanElement>(null);
  useCalmAnnouncement(statusRef, announcementOf(progress));
  const dots = !!progress && !THINKING_KINDS.has(progress.kind) && !progress.tool;
  const pauseDots = useOffscreenPause<HTMLSpanElement>(dots);
  // Whatever took the chevron's focus took it as it mounted; no line that mounts later may take it.
  const chevronKey = run && run.count > 0 ? run.openKey : undefined;
  useEffect(() => () => dropLiveRunFocus(chevronKey), [chevronKey]);
  // The chevron follows the two lines, level with the first: one element whichever lines show, so focus stays on it.
  const chevron = run && run.count > 0 ? (
    <button
      type="button"
      className="turn-live-toggle"
      aria-expanded={open}
      aria-label={open ? "Hide this run's steps" : "Show this run's steps"}
      onClick={(event) => {
        event.stopPropagation();
        toggle();
      }}
      onFocus={(event) => liveRunToggleFocus(run.openKey, true, event.currentTarget)}
      onBlur={(event) => liveRunToggleFocus(run.openKey, false, event.currentTarget)}
    >
      <IconChevronRight className="ui-collapse-chevron an-row-chevron" data-open={open || undefined} aria-hidden="true" />
    </button>
  ) : null;
  return (
    <>
    <div className="turn-live flex flex-col min-w-0 max-w-full" data-find-ignore data-turn-live
      data-until-text={untilText || undefined} hidden={!headline && !progress && !open}>
      <div className="turn-live-lines flex items-start gap-1 min-w-0 max-w-full select-none"
        data-toggles={chevron ? "" : undefined} onClick={chevron ? toggle : undefined}>
      <div className="turn-live-text an-row-stack min-w-0 max-w-full">
      {headline && (
        <div className="turn-live-thought flex items-center gap-2 min-w-0" title={liveThoughtText(thoughtText) || headline}>
          <span className="turn-progress-icon" aria-hidden="true">
            <ThinkingIcon size={18} />
          </span>
          <span className="turn-live-headline">{headline}</span>
        </div>
      )}
      {progress && (
        <div className="turn-progress flex items-center gap-2 min-w-0 max-w-full" data-turn-progress={progress.kind} title={progress.title}>
          {THINKING_KINDS.has(progress.kind) ? (
            <span className="turn-progress-icon" aria-hidden="true">
              <ThinkingIcon size={18} active />
            </span>
          ) : progress.tool ? (
            // A call: its own icon, pulsing gently while it runs, still once it finished.
            <ToolIcon type={progress.tool} state={progress.kind === "failed-tool" ? "failed" : progress.kind === "ran-tool" ? "done" : "running"} />
          ) : (
            // Retrying, stopping, writing, subagents: no thought, so no thinking icon.
            <span ref={pauseDots} className="turn-progress-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          )}
          <span className={progress.kind === "failed-tool" ? "turn-progress-label turn-progress-failed" : "turn-progress-label"}>{progress.label}</span>
          {progress.detail && <span className="turn-progress-detail">{progress.detail}</span>}
          {progress.more ? <span className="turn-progress-more">+{progress.more} running</span> : null}
          {failed > 0 ? <span className="turn-progress-failed turn-progress-badge">· {failed} failed</span> : null}
        </div>
      )}
      </div>
      {chevron}
      </div>
      {run && (
        <Collapse open={open} className="overflow-hidden pt-2" itemCount={run.count}>
          <div
            ref={scrollRef}
            className="an-tool-group-scroll"
            data-tool-group-scroll
            onScroll={(event) => {
              const box = event.currentTarget;
              atEndRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
            }}
          >
            <div ref={rowsRef} className="an-tool-group-rows ui-collapse-items an-row-stack ml-1.5 pl-3">
              <LiveRunBodyContext.Provider value>{run.rows}</LiveRunBodyContext.Provider>
            </div>
          </div>
        </Collapse>
      )}
    </div>
    {/* What screen readers hear (useCalmAnnouncement writes it); Find skips it. */}
    <span ref={statusRef} className="sr-only" role="status" data-live-announce data-find-ignore />
    </>
  );
}
