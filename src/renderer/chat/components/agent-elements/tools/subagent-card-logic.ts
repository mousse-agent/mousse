import type { SubagentState } from "../../../../../shared/subagents";
import { isRunningSubagent } from "../../../../../shared/subagents";
import type { SubagentCardModel } from "../../../adapters/subagentCards";
import { lineageModelLabel, lineageSubagentName, waitingLabel } from "../../../../components/sideCard/lineageLogic";

/** Longest result a card quotes; the card clamps it to two lines. */
export const SUBAGENT_RESULT_CHARS = 280;

const STATE_LABELS: Partial<Record<SubagentState, string>> = {
  needs_input: "Needs input",
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

/** "45s", "2m 05s", "1h 03m": how long a task has run or ran. */
export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The card is for work still going: the subagent is working, queued, asking, or waiting. */
export function isCardRunning(card: Pick<SubagentCardModel, "state" | "pending">): boolean {
  return card.pending || isRunningSubagent(card);
}

/** Time on a card: how long a running task has been going, how long a finished one took. */
export function cardElapsedLabel(card: Pick<SubagentCardModel, "createdAt" | "completedAt" | "state" | "pending">, now: number): string | null {
  if (card.createdAt === null) return null;
  const end = isCardRunning(card) ? now : card.completedAt;
  if (end === null) return null;
  return formatElapsed(end - card.createdAt);
}

/** The state in words; a task the subagent has since continued says so. */
export function cardStatusLabel(card: Pick<SubagentCardModel, "state" | "pending" | "waitingOn" | "continued">): string {
  const base =
    card.state === "waiting"
      ? waitingLabel(card)
      : (STATE_LABELS[card.state] ?? "Done");
  return card.continued && !isCardRunning(card) ? `${base} · continued` : base;
}

/** Title shown on a card: the subagent's name with whitespace collapsed. */
export function cardTitle(card: Pick<SubagentCardModel, "title">): string {
  return lineageSubagentName(card);
}

/** "provider · model", or null when the subagent inherited its parent's. */
export function cardModelLabel(card: Pick<SubagentCardModel, "provider" | "model">): string | null {
  return lineageModelLabel(card);
}

/** Header of consecutive cards: "3 subagents", with how many are still going. */
export function cardGroupLabel(cards: readonly Pick<SubagentCardModel, "state" | "pending">[]): string {
  const running = cards.filter(isCardRunning).length;
  const total = `${cards.length} ${cards.length === 1 ? "subagent" : "subagents"}`;
  return running > 0 ? `${total} · ${running} running` : total;
}

/**
 * The last thing a subagent said: the text of its latest finished assistant reply, clipped to one
 * short paragraph. Null while it has said nothing.
 */
export function lastResultText(
  messages: ReadonlyArray<{ role: string; kind?: string; content?: string; hidden?: boolean; streaming?: boolean }>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || message.hidden || message.streaming) continue;
    if (message.kind !== undefined && message.kind !== "message") continue;
    const text = (message.content ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    return text.length > SUBAGENT_RESULT_CHARS ? `${text.slice(0, SUBAGENT_RESULT_CHARS - 1)}…` : text;
  }
  return null;
}

/** A map that keeps at most `limit` entries, dropping the one used longest ago. */
export class LruCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly limit: number) {}

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value as string);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Subagent replies kept for cards; older ones are read again if their card comes back on screen. */
export const RESULT_CACHE_LIMIT = 200;
