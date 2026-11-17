import { createContext, useContext, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import type { TurnPhase, TurnStep } from "../../../../shared/types";
import { isWaitingPermissionRequest } from "./tools/permission-request";
import { useSubagentCards } from "./tools/subagent-cards-context";
import type { SubagentCardModel } from "../../adapters/subagentCards";
import { parseMcpToolType } from "./tools/tool-registry";
import { mousseToolLabels, mousseToolOf } from "./tools/mousse-tools";
import { isCompactionRow, thoughtSourceOf, thoughtTextFromPart, type ToolPartBase } from "./utils/assistant-blocks";
import { liveThoughtText, thoughtHeadline } from "./utils/format-tool";
import { commandLabel } from "../../../../shared/agentActivity";
import { useLiveThought } from "../../../stores/liveTextStore";
import { ThinkingIcon } from "../../../lib/icons";
import { ToolIcon } from "./tools/tool-icon";
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

type Part = { type?: string; state?: string; input?: unknown; text?: string; subagentTool?: unknown; toolCallId?: string };

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
  const detail = callDetail(part);
  const mousseTool = mousseToolOf(part.type);
  if (mousseTool) {
    const labels = mousseToolLabels(mousseTool);
    return { label: tense === "running" ? labels.running : tense === "done" ? labels.done : labels.failed, detail };
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
    return preparing ? { kind: "preparing-tool", label, title: detail, tool: part.type } : { kind: "running-tool", label, title: detail, detail, tool: part.type };
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

/** The steps that read "Thinking…": they show the thinking icon. */
const THINKING_KINDS: ReadonlySet<TurnProgressKind> = new Set(["thinking", "starting", "waiting", "finishing"]);

/** The turn's start and the wait for the model's first output say nothing more than that it thinks: the tooltip says which. */
const STARTING: TurnProgress = { kind: "starting", label: "Thinking…", title: "Starting the agent and its tools" };
const WAITING: TurnProgress = { kind: "waiting", label: "Thinking…", title: "Waiting for the model's first output" };

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
 * something new starts. Starting, waiting for the model and finishing all read "Thinking…", with what it is in the
 * tooltip.
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

/**
 * The live row at the end of a running turn, under its Working: one element for the whole turn, which changes its
 * text and never its place.
 *
 * - Line 1, while the turn's current run of work has a thought (`thought`, its latest): the thinking icon and the
 *   thought's headline (`thoughtHeadline`), one line cut at its width. It changes only when the thought starts a new
 *   paragraph; the newest paragraph is its tooltip.
 * - Line 2: what the turn does now (`describeTurnProgress`), details in its tooltip. The thinking icon turns while the
 *   turn thinks; a running call's icon pulses; a call that just finished shows its icon still; anything else (a retry,
 *   a stop) shows three small dots. All move by transform or opacity only, so the row costs no layout or paint while
 *   it animates.
 *
 * With neither line it is hidden, not removed, so it comes back as the same element. A streamed thought delta renders
 * this row alone (it reads the thought's live text, liveTextStore). It reads the thread's turn from context, so a
 * memoised turn row still follows it.
 */
export function TurnProgressRow({
  messages,
  awaitingSubagents,
  standalone,
  thought,
}: {
  messages: readonly UIMessage[];
  awaitingSubagents?: boolean;
  standalone?: boolean;
  /** The latest thought of the turn's current run of work, if it has one. */
  thought?: ToolPartBase;
}) {
  countRender("TurnProgressRow");
  const state = useTurnProgressState();
  const spawningSubagents = countSpawningSubagents(messages, useSubagentCards());
  // The thought as it is written (see liveTextStore), or as the transcript holds it.
  const liveThought = useLiveThought(thought ? thoughtSourceOf(thought) : undefined);
  const thoughtText = liveThought || (thought ? thoughtTextFromPart(thought) : "");
  const headline = thoughtHeadline(thoughtText);
  // The clock is read as the line renders, so a countdown that starts shows its right second at once; the timer
  // only renders the line again each second while one runs.
  const [, setTick] = useState(0);
  const now = Date.now();
  const progress = describeTurnProgress({ state, messages, stepSince: stepSeenAt(state, now), awaitingSubagents, spawningSubagents, standalone, now });
  const until = progress?.until;
  useEffect(() => {
    if (until == null) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return (
    <div className="turn-live flex flex-col min-w-0 max-w-full select-none" role="status" data-find-ignore data-turn-live
      hidden={!headline && !progress}>
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
            <span className="turn-progress-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          )}
          <span className={progress.kind === "failed-tool" ? "turn-progress-label turn-progress-failed" : "turn-progress-label"}>{progress.label}</span>
          {progress.detail && <span className="turn-progress-detail">{progress.detail}</span>}
          {progress.more ? <span className="turn-progress-more">+{progress.more} running</span> : null}
        </div>
      )}
    </div>
  );
}
