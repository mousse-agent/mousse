import { memo, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { SubagentCardModel } from "../../../adapters/subagentCards";
import { IconChevronRight } from "../../../../lib/icons";
import { isSubagentStartTool } from "../../../../../shared/subagentTools";
import { openThread } from "../../../../lib/openThread";
import { getToolStatus } from "../utils/format-tool";
import { GenericTool } from "./generic-tool";
import { toolRegistry } from "./tool-registry";
import { useSubagentCard, useSubagentCards } from "./subagent-cards-context";
import {
  cardElapsedLabel,
  cardGroupLabel,
  cardModelLabel,
  cardStatusLabel,
  cardTitle,
  isCardRunning,
  lastResultText,
  LruCache,
  RESULT_CACHE_LIMIT,
} from "./subagent-card-logic";
import "./subagent-card.css";

type CardTone = "live" | "ask" | "fail" | "quiet";

function cardTone(card: Pick<SubagentCardModel, "state" | "pending">): CardTone {
  if (card.state === "needs_input") return "ask";
  if (card.state === "failed" || card.state === "interrupted") return "fail";
  return isCardRunning(card) ? "live" : "quiet";
}

export type SubagentCardViewProps = {
  card: SubagentCardModel;
  /** Current time, for the elapsed label of a running task. */
  now: number;
  /** What the subagent last said (or why it failed); empty while it has nothing to show. */
  result?: string | null;
  onOpen: (childThreadId: string) => void;
};

/**
 * One subagent task in the parent's timeline: the subagent's name, where it runs, what state it is
 * in and what it last said. Clicking opens the subagent's own thread.
 */
export function SubagentCardView({ card, now, result, onOpen }: SubagentCardViewProps) {
  const title = cardTitle(card);
  const model = cardModelLabel(card);
  const elapsed = cardElapsedLabel(card, now);
  const tone = cardTone(card);
  const status = cardStatusLabel(card);
  const childThreadId = card.childThreadId;
  return (
    <button
      type="button"
      className="subagent-card"
      data-state={card.pending ? "pending" : card.state}
      title={childThreadId ? `Open ${title}` : title}
      aria-label={childThreadId ? `Open ${title}, ${status}` : `${title}, ${status}`}
      disabled={!childThreadId}
      onClick={() => {
        if (childThreadId) onOpen(childThreadId);
      }}
    >
      <span className="subagent-card-head">
        {tone !== "quiet" && <span className="subagent-card-dot" data-tone={tone} aria-hidden="true" />}
        <span className="subagent-card-title">{title}</span>
        {model && <span className="subagent-card-model">{model}</span>}
        <span className="subagent-card-status">{elapsed ? `${status} · ${elapsed}` : status}</span>
        {childThreadId && <IconChevronRight className="subagent-card-chevron" aria-hidden="true" />}
      </span>
      {result && <span className="subagent-card-result">{result}</span>}
    </button>
  );
}

/** Replies already read from subagent threads, so reopening a thread does not read them again. */
const resultCache = new LruCache<string | null>(RESULT_CACHE_LIMIT);

function useOnceVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (visible || !element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, visible]);
  return visible;
}

/**
 * What a finished card quotes: why the task failed, or the subagent's last reply for a task that
 * is done and is still the subagent's latest. The reply is read from the subagent's thread the
 * first time the card is on screen; an older task has no reply of its own to quote.
 */
function useCardResult(card: SubagentCardModel, visible: boolean): string | null {
  const key = card.childThreadId && card.latest && !card.continued && card.state === "done"
    ? `${card.childThreadId}:${card.completedAt ?? ""}`
    : null;
  const [fetched, setFetched] = useState<{ key: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!key || !visible || resultCache.has(key)) return;
    let cancelled = false;
    void window.mousse.orchestrator
      .getMessages(card.childThreadId!)
      .then((messages) => lastResultText(messages))
      .catch(() => null)
      .then((text) => {
        resultCache.set(key, text);
        if (!cancelled) setFetched({ key, text });
      });
    return () => {
      cancelled = true;
    };
  }, [key, visible, card.childThreadId]);
  if (!isCardRunning(card) && card.error && card.state !== "done") return card.error;
  if (!key) return null;
  return resultCache.get(key) ?? (fetched?.key === key ? fetched.text : null);
}

function useTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

function LiveSubagentCard({ card }: { card: SubagentCardModel }) {
  const ref = useRef<HTMLDivElement>(null);
  const visible = useOnceVisible(ref);
  const now = useTick(isCardRunning(card));
  const result = useCardResult(card, visible);
  return (
    <div ref={ref} className="subagent-card-slot">
      <SubagentCardView card={card} now={now} result={result} onOpen={(threadId) => void openThread(threadId)} />
    </div>
  );
}

/** What the tool-registry row says for a call: used when a call has no card. */
function RawSubagentRow({ part, chatStatus }: { part: any; chatStatus?: string }) {
  const meta = toolRegistry["tool-Subagent"]!;
  const { isPending } = getToolStatus(part, chatStatus);
  // A call that never returned and is not running now was cut off: the turn stopped or the app closed.
  const unfinished = isSubagentStartTool(part.subagentTool) && part.state !== "output-available" && part.state !== "output-error" && !isPending;
  return (
    <GenericTool
      icon={meta.icon}
      title={unfinished ? "Subagent call didn't finish" : meta.title(part)}
      subtitle={meta.subtitle?.(part)}
      isPending={isPending}
    />
  );
}

/**
 * A Mousse subagent tool row. A call that started a task shows as that task's card; every other
 * call, and a call that failed or started nothing, keeps its ordinary tool row.
 */
export const SubagentTool = memo(function SubagentTool({ part, chatStatus }: { part: any; chatStatus?: string }) {
  const card = useSubagentCard(part.toolCallId);
  if (!card) return <RawSubagentRow part={part} chatStatus={chatStatus} />;
  return <LiveSubagentCard card={card} />;
});

/**
 * Consecutive subagent cards. Two or more get a heading with how many there are and how many are
 * still going; a single card stands alone.
 */
export function SubagentCardGroup({ toolCallIds, children }: { toolCallIds: readonly string[]; children: ReactNode }) {
  const cards = useSubagentCards();
  const models = toolCallIds.map((id) => cards.get(id)).filter((card): card is SubagentCardModel => card !== undefined);
  if (models.length < 2) return <div className="subagent-cards">{children}</div>;
  const label = cardGroupLabel(models);
  return (
    <div className="subagent-cards" role="group" aria-label={label}>
      <div className="subagent-cards-label">{label}</div>
      {children}
    </div>
  );
}
