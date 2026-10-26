import { Fragment, memo, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { SubagentCardModel } from "../../../adapters/subagentCards";
import { IconChevronDown, IconChevronRight } from "../../../../lib/icons";
import { isSubagentStartTool } from "../../../../../shared/subagentTools";
import { openThread } from "../../../../lib/openThread";
import { SubagentAvatar } from "../../../../components/SubagentAvatar";
import { subagentBadgeTone, subagentIconId } from "../../../../components/subagentStatus";
import { getToolStatus } from "../utils/format-tool";
import { GenericTool } from "./generic-tool";
import { toolRegistry } from "./tool-registry";
import { useInheritedProvider, useSubagentCard, useSubagentCards } from "./subagent-cards-context";
import {
  cardElapsedLabel,
  cardGroupElapsedLabel,
  cardGroupLabel,
  cardGroupSummary,
  cardIconStack,
  cardModelLabel,
  cardStateNote,
  cardStatusLabel,
  cardTitle,
  isCardRunning,
  lastResultText,
  LruCache,
  RESULT_CACHE_LIMIT,
} from "./subagent-card-logic";
import "./subagent-card.css";

export type SubagentCardViewProps = {
  card: SubagentCardModel;
  /** Current time, for the elapsed label of a running task. */
  now: number;
  /** What the subagent last said (or why it failed); empty while it has nothing to show. */
  result?: string | null;
  /** The provider the parent runs on, for a subagent that names none. */
  inheritedProvider?: string | null;
  onOpen: (childThreadId: string) => void;
};

/**
 * One subagent task in the parent's timeline: the provider's icon with a status dot, the subagent's
 * name, where it runs, what it last said and how long it took. Clicking opens the subagent's own thread.
 */
export function SubagentCardView({ card, now, result, inheritedProvider, onOpen }: SubagentCardViewProps) {
  const title = cardTitle(card);
  const model = cardModelLabel(card);
  const elapsed = cardElapsedLabel(card, now);
  const tone = subagentBadgeTone(card);
  const note = cardStateNote(card);
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
      <SubagentAvatar providerId={subagentIconId(card.provider, inheritedProvider)} tone={tone} chip />
      <span className="subagent-card-body">
        <span className="subagent-card-head">
          <span className="subagent-card-title">{title}</span>
          {note && <span className="subagent-card-note" data-tone={tone}>{note}</span>}
          {model && <span className="subagent-card-model">{model}</span>}
        </span>
        {result && <span className="subagent-card-result">{result}</span>}
      </span>
      {elapsed && <span className="subagent-card-elapsed">{elapsed}</span>}
      {childThreadId && <IconChevronRight className="subagent-card-chevron" aria-hidden="true" />}
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
  const inheritedProvider = useInheritedProvider();
  return (
    <div ref={ref} className="subagent-card-slot">
      <SubagentCardView
        card={card}
        now={now}
        result={result}
        inheritedProvider={inheritedProvider}
        onOpen={(threadId) => void openThread(threadId)}
      />
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
 * Consecutive subagent cards. Two or more fold into one group headed by their provider icons, how many
 * there are, a coloured count of what they are doing and how long they have run. The group is open
 * while any task is going and folded once all have finished, until the user opens or folds it.
 * A single card stands alone.
 */
export function SubagentCardGroup({ toolCallIds, children }: { toolCallIds: readonly string[]; children: ReactNode }) {
  const cards = useSubagentCards();
  const inheritedProvider = useInheritedProvider();
  const models = toolCallIds.map((id) => cards.get(id)).filter((card): card is SubagentCardModel => card !== undefined);
  const running = models.length > 1 && models.some(isCardRunning);
  const now = useTick(running);
  const [chosenOpen, setChosenOpen] = useState<boolean | null>(null);
  if (models.length < 2) return <div className="subagent-cards">{children}</div>;
  const open = chosenOpen ?? running;
  const { title, parts } = cardGroupSummary(models);
  const stack = cardIconStack(models);
  const elapsed = cardGroupElapsedLabel(models, now);
  return (
    <div className="subagent-cards is-group" role="group" aria-label={cardGroupLabel(models)}>
      <button type="button" className="subagent-group-head" aria-expanded={open} onClick={() => setChosenOpen(!open)}>
        <span className="subagent-group-stack" aria-hidden="true">
          {stack.shown.map((card) => (
            <SubagentAvatar key={card.toolCallId} providerId={subagentIconId(card.provider, inheritedProvider)} chip />
          ))}
          {stack.extra > 0 && <span className="subagent-group-more">+{stack.extra}</span>}
        </span>
        <span className="subagent-group-text">
          <span className="subagent-group-title">{title}</span>
          <span className="subagent-group-summary">
            {parts.map((part, index) => (
              <Fragment key={part.text}>
                {index > 0 && <span className="subagent-group-sep"> · </span>}
                <span data-tone={part.tone}>{part.text}</span>
              </Fragment>
            ))}
          </span>
        </span>
        {elapsed && <span className="subagent-group-elapsed">{elapsed}</span>}
        <IconChevronDown className={`subagent-group-chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>
      {open && <div className="subagent-group-rows">{children}</div>}
    </div>
  );
}
