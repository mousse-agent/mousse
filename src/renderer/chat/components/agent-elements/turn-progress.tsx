import { createContext, useContext, useEffect, useState } from "react";
import type { UIMessage } from "ai";
import type { TurnPhase, TurnStep } from "../../../../shared/types";
import { isWaitingPermissionRequest } from "./tools/permission-request";
import { parseMcpToolType } from "./tools/tool-registry";
import { isCompactionRow } from "./utils/assistant-blocks";
import { ThinkingIcon } from "../../../lib/icons";
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
};

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
  /** A retry's start (ms): the label counts down to it. */
  until?: number;
};

export type TurnProgressInput = {
  state: TurnProgressState | null;
  /** The running turn's assistant messages, in order. */
  messages: readonly UIMessage[];
  /** When this window first saw the turn's step (ms, its own clock): a retry counts down from there. */
  stepSince?: number;
  /** The turn ended, and subagents it started still work. */
  awaitingSubagents?: boolean;
  /** Nothing else of the turn is shown (it has no output yet): the line says everything, a compaction too. */
  standalone?: boolean;
  now: number;
};

type Part = { type?: string; state?: string; input?: unknown; text?: string; subagentTool?: unknown };

/** Fields a call's row has before its arguments arrive; they say nothing about what it will do. */
const PLACEHOLDER_INPUT_KEYS = new Set(["label", "cwd"]);

const NOT_TOOLS = new Set(["tool-Thinking", "tool-Note", "tool-QuestionAnswers", "tool-PlanWrite"]);

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

function isRunningTool(part: Part): boolean {
  return (
    typeof part.type === "string" &&
    part.type.startsWith("tool-") &&
    !NOT_TOOLS.has(part.type) &&
    (part.state === "input-streaming" || part.state === "input-available")
  );
}

function toolProgress(part: Part): TurnProgress {
  const detail = inputDetail(part.input);
  if (part.type === "tool-Subagent" || part.type === "tool-Task" || part.type === "tool-Agent" || part.subagentTool) {
    return { kind: "running-tool", label: "Running subagent…", title: detail };
  }
  // A tool search loads tools for the model: the line says what its row says.
  if (part.type === "tool-ToolSearch") return { kind: "running-tool", label: "Loading tools…", title: detail };
  const name = toolName(part.type!);
  // A call whose arguments are still streaming in: the model is writing it (a runtime that opens the row at the
  // call's start, before its arguments, shows it running with none).
  const noInput = !part.input || (typeof part.input === "object" && Object.entries(part.input as object).every(
    // A command row carries its working folder and a placeholder label before its command arrives.
    ([key, value]) => PLACEHOLDER_INPUT_KEYS.has(key) || value === undefined || value === null || value === "",
  ));
  if (part.state === "input-streaming" || noInput) return { kind: "preparing-tool", label: `Preparing ${name}…`, title: detail };
  return { kind: "running-tool", label: `Running ${name}…`, title: detail };
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

/**
 * The line under a running turn's Working: what the turn does now, in a few words. Null where
 * something else in the turn already says it (an approval waiting, a compaction running, an answer
 * the agent waits for, which the header shows, or a thought streaming, whose row is the live line).
 * Starting, waiting for the model and finishing all read "Thinking…", with what it is in the tooltip.
 */
export function describeTurnProgress({ state, messages, stepSince, awaitingSubagents, standalone, now }: TurnProgressInput): TurnProgress | null {
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

  // What the end of the turn shows live: its last part, or any tool still running.
  const parts = (last?.parts ?? []) as Part[];
  const tail = parts[parts.length - 1];
  if (tail && isRunningTool(tail)) return toolProgress(tail);
  // A thought that streams: its row (or its group's header) says Thinking with the thought's latest line.
  if (tail?.type === "tool-Thinking" && tail.state === "input-available") return null;
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const own = (messages[m]!.parts ?? []) as Part[];
    for (let p = own.length - 1; p >= 0; p -= 1) if (isRunningTool(own[p]!)) return toolProgress(own[p]!);
  }

  if (step?.kind === "starting") return STARTING;
  if (step?.kind === "waiting") return WAITING;
  if (step?.kind === "reasoning") return { kind: "thinking", label: "Thinking…" };

  const content = hasContent(messages);
  switch (phase) {
    case "streaming":
      return { kind: "writing", label: "Writing…" };
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
 * The live line at the end of a running turn, under its Working: a short label for what the turn does
 * now, details in its tooltip. While the turn thinks it shows the thinking icon; for anything else
 * (a tool, a retry, a stop), three small dots. Both move by transform or opacity only, so the line
 * costs no layout or paint while it animates. It reads the thread's turn from context,
 * so a memoised turn row still follows it.
 */
export function TurnProgressRow({
  messages,
  awaitingSubagents,
  standalone,
}: {
  messages: readonly UIMessage[];
  awaitingSubagents?: boolean;
  standalone?: boolean;
}) {
  countRender("TurnProgressRow");
  const state = useTurnProgressState();
  // The clock is read as the line renders, so a countdown that starts shows its right second at once; the timer
  // only renders the line again each second while one runs.
  const [, setTick] = useState(0);
  const now = Date.now();
  const progress = describeTurnProgress({ state, messages, stepSince: stepSeenAt(state, now), awaitingSubagents, standalone, now });
  const until = progress?.until;
  useEffect(() => {
    if (until == null) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  if (!progress) return null;
  return (
    <div
      className="turn-progress flex items-center gap-2 min-w-0 max-w-full select-none"
      role="status" data-find-ignore data-turn-progress={progress.kind} title={progress.title}>
      {THINKING_KINDS.has(progress.kind) ? (
        <span className="turn-progress-icon" aria-hidden="true">
          <ThinkingIcon size={18} active />
        </span>
      ) : (
        // Running a tool, retrying, stopping, writing, subagents: no thought, so no thinking icon.
        <span className="turn-progress-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      )}
      <span className="turn-progress-label">{progress.label}</span>
    </div>
  );
}
