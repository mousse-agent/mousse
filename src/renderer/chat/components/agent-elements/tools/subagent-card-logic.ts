import type { SubagentState } from "../../../../../shared/subagents";
import { isRunningSubagent } from "../../../../../shared/subagents";
import type { SubagentCardModel } from "../../../adapters/subagentCards";
import { lineageModelLabel, lineageSubagentName, waitingLabel } from "../../../../components/sideCard/lineageLogic";
import { subagentBadgeTone, type SubagentBadgeTone } from "../../../../components/subagentStatus";

/** Longest result a card quotes; the card clamps it to two lines. */
export const SUBAGENT_RESULT_CHARS = 280;

const STATE_LABELS: Partial<Record<SubagentState, string>> = {
  needs_input: "Needs input",
  queued: "Queued",
  starting: "Starting",
  working: "Working",
  paused: "Paused",
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

/**
 * What a row says next to its name. The dot on the provider icon already shows that a task is going
 * or done, so only the states worth reading get words: a question, a wait, a usage-limit pause, a failure or a stop, and a
 * finished task the subagent has since continued.
 */
export function cardStateNote(card: Pick<SubagentCardModel, "state" | "pending" | "waitingOn" | "continued">): string | null {
  if (card.pending) return null;
  const base =
    card.state === "waiting"
      ? waitingLabel(card)
      : card.state === "needs_input" || card.state === "paused" || card.state === "failed" || card.state === "stopped" || card.state === "interrupted"
        ? STATE_LABELS[card.state]!
        : null;
  if (!card.continued || isCardRunning(card)) return base;
  return base ? `${base} · continued` : "Continued";
}

type CardCounted = Pick<SubagentCardModel, "state" | "pending">;

/** One coloured count in a group's summary, such as "2 working". */
export interface GroupSummaryPart {
  tone: SubagentBadgeTone;
  text: string;
}

/** The counts a group's summary lists, in order: what needs the user first, then work going, then outcomes. */
const SUMMARY_KINDS: ReadonlyArray<{ tone: SubagentBadgeTone; matches: (card: CardCounted) => boolean; text: (count: number) => string }> = [
  { tone: "attention", matches: (card) => !card.pending && card.state === "needs_input", text: (count) => `${count} ${count === 1 ? "needs" : "need"} input` },
  { tone: "running", matches: (card) => subagentBadgeTone(card) === "running", text: (count) => `${count} working` },
  { tone: "attention", matches: (card) => !card.pending && card.state === "waiting", text: (count) => `${count} waiting` },
  { tone: "failed", matches: (card) => subagentBadgeTone(card) === "failed", text: (count) => `${count} failed` },
  { tone: "done", matches: (card) => subagentBadgeTone(card) === "done", text: (count) => `${count} done` },
  { tone: "idle", matches: (card) => !card.pending && card.state === "stopped", text: (count) => `${count} stopped` },
  { tone: "idle", matches: (card) => !card.pending && card.state === "idle", text: (count) => `${count} idle` },
];

/** Header of consecutive cards: "5 subagents", and below it "2 working · 3 done". */
export function cardGroupSummary(cards: readonly CardCounted[]): { title: string; parts: GroupSummaryPart[] } {
  const parts: GroupSummaryPart[] = [];
  for (const kind of SUMMARY_KINDS) {
    const count = cards.filter(kind.matches).length;
    if (count > 0) parts.push({ tone: kind.tone, text: kind.text(count) });
  }
  return { title: `${cards.length} ${cards.length === 1 ? "subagent" : "subagents"}`, parts };
}

/** The group's summary in one line, for its accessible name: "5 subagents · 2 working · 3 done". */
export function cardGroupLabel(cards: readonly CardCounted[]): string {
  const { title, parts } = cardGroupSummary(cards);
  return [title, ...parts.map((part) => part.text)].join(" · ");
}

/** How long the group has run: from the first task's start to now while any goes, else to the last finish. */
export function cardGroupElapsedLabel(
  cards: readonly Pick<SubagentCardModel, "createdAt" | "completedAt" | "state" | "pending">[],
  now: number,
): string | null {
  const starts = cards.map((card) => card.createdAt).filter((at): at is number => at !== null);
  if (starts.length === 0) return null;
  const ends = cards.some(isCardRunning) ? [now] : cards.map((card) => card.completedAt).filter((at): at is number => at !== null);
  if (ends.length === 0) return null;
  return formatElapsed(Math.max(...ends) - Math.min(...starts));
}

/** Most provider icons a group's header stacks before it says "+N". */
export const GROUP_ICON_LIMIT = 3;

/** The cards whose icons the header stacks, and how many more there are. */
export function cardIconStack<T>(cards: readonly T[], limit = GROUP_ICON_LIMIT): { shown: T[]; extra: number } {
  return { shown: cards.slice(0, limit), extra: Math.max(0, cards.length - limit) };
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
