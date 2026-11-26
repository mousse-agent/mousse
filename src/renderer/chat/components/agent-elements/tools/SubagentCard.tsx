import { Fragment, memo, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { SubagentCardModel } from "../../../adapters/subagentCards";
import { IconChevronDown, IconChevronRight } from "../../../../lib/icons";
import { isSubagentStartTool } from "../../../../../shared/subagentTools";
import { openThread } from "../../../../lib/openThread";
import { useProviderSnapshotsStore } from "../../../../lib/providerSnapshots";
import { SubagentAvatar } from "../../../../components/SubagentAvatar";
import { Collapse } from "../../../../components/ui/Collapse";
import { subagentBadgeTone, subagentIconId } from "../../../../components/subagentStatus";
import { getToolStatus } from "../utils/format-tool";
import { Markdown } from "../markdown";
import { GenericTool } from "./generic-tool";
import { toolRegistry } from "./tool-registry";
import { useInheritedProvider, useSubagentCard, useSubagentCards } from "./subagent-cards-context";
import { useSubagentRevealSeq } from "../../../../stores/chatNavigationStore";
import { nativeSubagentLabel } from "../../../../components/sideCard/lineageLogic";
import { useThreadRefMenu } from "../../../../components/ThreadRefMenu";
import {
  cardElapsedLabel,
  cardGroupElapsedLabel,
  cardGroupFoldedTitle,
  cardGroupLabel,
  cardGroupSummary,
  cardIconStack,
  cardLine,
  cardModelLabel,
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

/** Provider icon size inside a row's 24px avatar. */
const ROW_ICON_SIZE = 14;

/**
 * The inside of a row: the provider's icon with a status dot, the name (and where it runs) on the first
 * line, and on the second line one line of plain text: a state worth reading, then the result or the state.
 */
function SubagentRowBody({ card, result, label, inheritedProvider }: { card: SubagentCardModel; result: string | null | undefined; label: string | null; inheritedProvider?: string | null }) {
  const line = cardLine(card, result);
  return (
    <>
      <SubagentAvatar providerId={subagentIconId(card.provider, inheritedProvider)} tone={subagentBadgeTone(card)} size={ROW_ICON_SIZE} chip />
      <span className="subagent-card-body">
        <span className="subagent-card-head">
          <span className="subagent-card-title">{cardTitle(card)}</span>
          {label && <span className="subagent-card-model">{label}</span>}
        </span>
        <span className="subagent-card-line" title={line.text ?? undefined}>
          {line.note && <span className="subagent-card-note" data-tone={line.note.tone}>{line.note.text}</span>}
          {line.note && line.text && <span className="subagent-card-sep" aria-hidden="true"> · </span>}
          {line.text && <span className="subagent-card-result">{line.text}</span>}
        </span>
      </span>
    </>
  );
}

/**
 * One subagent task in the parent's timeline, as one compact row: the provider's icon with a status dot,
 * the subagent's name and where it runs, one line of what it last said (or its state), and how long it
 * took. Clicking opens the subagent's own thread, which holds the full result.
 */
export function SubagentCardView({ card, now, result, inheritedProvider, onOpen }: SubagentCardViewProps) {
  // The model's name comes from the providers' lists: a list that loads later renames the row.
  useProviderSnapshotsStore((state) => state.scopes);
  const title = cardTitle(card);
  const elapsed = cardElapsedLabel(card, now);
  const status = cardStatusLabel(card);
  const childThreadId = card.childThreadId;
  // Right-click: Copy reference, to point another chat's agent at the subagent's thread.
  const refMenu = useThreadRefMenu(childThreadId ?? undefined);
  return (<>
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
      {...refMenu.bind}
    >
      <SubagentRowBody card={card} result={result} label={cardModelLabel(card)} inheritedProvider={inheritedProvider} />
      {elapsed && <span className="subagent-card-elapsed">{elapsed}</span>}
      {childThreadId && <IconChevronRight className="subagent-card-chevron" aria-hidden="true" />}
    </button>
    {refMenu.menu}
  </>);
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
  // A subagent whose thread is gone quotes the result the daemon kept for its task.
  if (!key) return card.state === "done" ? card.summary ?? null : null;
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

export type NativeSubagentCardViewProps = {
  card: SubagentCardModel;
  now: number;
  /** The calls the subagent made, in order. */
  nestedTools: readonly any[];
  chatStatus?: string;
  inheritedProvider?: string | null;
};

/**
 * A subagent the runtime started with its own tool (Claude Code's `Agent`). It has no thread of its own,
 * so the row opens in place on the whole result and the calls the subagent made.
 */
export function NativeSubagentCardView({ card, now, nestedTools, chatStatus, inheritedProvider }: NativeSubagentCardViewProps) {
  const [open, setOpen] = useState(false);
  // Nest shows this subagent: the card opens on its result and calls, once per request.
  const revealSeq = useSubagentRevealSeq([card.toolCallId]);
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  useProviderSnapshotsStore((state) => state.scopes);
  const title = cardTitle(card);
  const elapsed = cardElapsedLabel(card, now);
  const status = cardStatusLabel(card);
  const result = card.error ?? card.native?.result ?? null;
  // The row's line is plain text; opened, the whole report keeps its Markdown.
  const fullResult = result?.trim() ?? "";
  const task = card.native?.acp?.prompt;
  const noActivity = Boolean(card.native?.acp && !nestedTools.length && !fullResult);
  const itemCount = nestedTools.length + Number(Boolean(fullResult)) + Number(Boolean(task)) + Number(noActivity);
  const expandable = itemCount > 0;
  if (revealSeq !== null && revealSeq !== openedFor) {
    setOpenedFor(revealSeq);
    if (expandable) setOpen(true);
  }
  return (
    <div className="subagent-card-native" data-native-subagent={card.toolCallId}>
      <button
        type="button"
        className="subagent-card"
        data-state={card.state}
        title={title}
        aria-label={`${title}, ${status}`}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen(!open)}
      >
        <SubagentRowBody card={card} result={result} label={nativeSubagentLabel(card.native)} inheritedProvider={inheritedProvider} />
        {elapsed && <span className="subagent-card-elapsed">{elapsed}</span>}
        {expandable && <IconChevronDown className="subagent-card-chevron ui-collapse-chevron" data-open={open || undefined} aria-hidden="true" />}
      </button>
      {expandable && (
        <Collapse open={open} className="subagent-card-calls" itemCount={itemCount}>
          {task && (
            <div className="subagent-card-full">
              <strong>Assigned task</strong>
              <p className="whitespace-pre-wrap">{task}</p>
            </div>
          )}
          {noActivity && <p className="subagent-card-full">No subagent activity reported</p>}
          {fullResult && <NativeSubagentResult text={fullResult} failed={Boolean(card.error)} />}
          {nestedTools.map((nestedPart, index) => {
            const meta = toolRegistry[nestedPart.type];
            if (!meta) return null;
            const { isPending, isError } = getToolStatus(nestedPart, chatStatus);
            return (
              <GenericTool
                key={nestedPart.toolCallId ?? index}
                icon={meta.icon}
                title={meta.title(nestedPart)}
                subtitle={meta.subtitle?.(nestedPart)}
                isPending={isPending}
                isError={isError}
              />
            );
          })}
        </Collapse>
      )}
    </div>
  );
}

/** A native subagent's whole report, opened under its row: Markdown, as the reply of a Mousse subagent's thread shows it. */
export function NativeSubagentResult({ text, failed }: { text: string; failed: boolean }) {
  return (
    <div className="subagent-card-full" data-tone={failed ? "failed" : undefined}>
      <Markdown content={text} />
    </div>
  );
}

/** A native subagent's card with a running clock. */
export const NativeSubagentCard = memo(function NativeSubagentCard({ card, nestedTools, chatStatus }: { card: SubagentCardModel; nestedTools: readonly any[]; chatStatus?: string }) {
  const now = useTick(isCardRunning(card));
  const inheritedProvider = useInheritedProvider();
  return (
    <div className="subagent-card-slot">
      <NativeSubagentCardView card={card} now={now} nestedTools={nestedTools} chatStatus={chatStatus} inheritedProvider={inheritedProvider} />
    </div>
  );
});

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
  // Still starting: the turn's progress line says so until the subagent has a name and a thread.
  if (card.spawning) return null;
  return <LiveSubagentCard card={card} />;
});

/**
 * A `thread_send` or `thread_update` row that gave the caller's own subagent a follow-up task: that task's card,
 * like a `continue_subagent` call's. Until the task is known, the row (`children`) stays as it is.
 */
export function SubagentFollowUpTool({ part, children }: { part: any; children: ReactNode }) {
  const card = useSubagentCard(part.toolCallId);
  if (!card || card.spawning) return <>{children}</>;
  return <LiveSubagentCard card={card} />;
}

/**
 * Subagents started in quick succession. Two or more share one card headed by their provider icons, a title,
 * a coloured count of what they are doing and how long they have run. It starts open: it says how many there are
 * ("3 subagents") and lists their rows, each opening its subagent. Folded by the user, it is titled with the first
 * subagent's name and how many more ("Archive builder + 2"). A single card stands alone.
 */
export function SubagentCardGroup({ toolCallIds, children }: { toolCallIds: readonly string[]; children: ReactNode }) {
  const cards = useSubagentCards();
  const inheritedProvider = useInheritedProvider();
  const models = toolCallIds.map((id) => cards.get(id)).filter((card): card is SubagentCardModel => card !== undefined);
  const running = models.length > 1 && models.some(isCardRunning);
  const now = useTick(running);
  const [chosenOpen, setChosenOpen] = useState<boolean | null>(null);
  // Nest shows a subagent in this group: the group opens so its card can be reached, once per request.
  const revealSeq = useSubagentRevealSeq(toolCallIds);
  const [openedFor, setOpenedFor] = useState<number | null>(null);
  if (revealSeq !== null && revealSeq !== openedFor) {
    setOpenedFor(revealSeq);
    setChosenOpen(true);
  }
  if (models.length < 2) return <div className="subagent-cards">{children}</div>;
  // Open until the user folds it, so every subagent in a burst stays readable live and when "Worked for" is opened.
  const open = chosenOpen ?? true;
  const { title, parts } = cardGroupSummary(models);
  const folded = cardGroupFoldedTitle(models);
  const stack = cardIconStack(models);
  const elapsed = cardGroupElapsedLabel(models, now);
  return (
    <div className="subagent-cards is-group" role="group" aria-label={cardGroupLabel(models)}>
      <button type="button" className="subagent-group-head" aria-expanded={open} onClick={() => setChosenOpen(!open)}>
        <span className="subagent-group-stack" aria-hidden="true">
          {stack.shown.map((card) => (
            <SubagentAvatar key={card.toolCallId} providerId={subagentIconId(card.provider, inheritedProvider)} size={ROW_ICON_SIZE} chip />
          ))}
          {stack.extra > 0 && <span className="subagent-group-more">+{stack.extra}</span>}
        </span>
        <span className="subagent-group-text">
          {open ? (
            <span className="subagent-group-title">{title}</span>
          ) : (
            <span className="subagent-group-title" title={`${folded.name} ${folded.rest}`}>
              <span className="subagent-group-name">{folded.name}</span>
              <span className="subagent-group-rest"> {folded.rest}</span>
            </span>
          )}
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
        <IconChevronDown className="subagent-group-chevron ui-collapse-chevron" data-open={open || undefined} aria-hidden="true" />
      </button>
      <Collapse open={open} className="subagent-group-rows" itemCount={models.length}>{children}</Collapse>
    </div>
  );
}
