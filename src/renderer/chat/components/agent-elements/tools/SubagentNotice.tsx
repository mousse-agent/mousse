import { useState } from "react";
import type { BackgroundTaskNoticeItem, SubagentNoticeItem } from "../../../../../shared/subagents";
import type { SettleNoticeItem } from "../../../../../shared/settleNotice";
import { settleNoticeName, settleNoticeOutcome } from "../../../adapters/settleNotice";
import { backgroundNoticeName } from "../../../adapters/nativeSubagents";
import { monitorNoticeLine, noteNoticeName, noticeItemName, noticeOutcome } from "../../../adapters/subagentNotice";
import { openThread } from "../../../../lib/openThread";
import { ThreadChip } from "../../../../components/ThreadChip";
import "./subagent-card.css";

/** Most results a notice lists; a wake that reports more says how many it left out. */
export const SUBAGENT_NOTICE_ROWS = 5;

export type SubagentNoticeViewProps = {
  items: readonly SubagentNoticeItem[];
  onOpen: (childThreadId: string) => void;
};

/**
 * What reaches this thread about its subagents (a wake turn, a steer, a queued steer): a result, a
 * question one of them waits on, a stop. Drawn from the structured payload on the message: one quiet
 * row each that opens the subagent's thread. The message text, which the model reads, is not shown.
 */
export function SubagentNoticeView({ items, onOpen }: SubagentNoticeViewProps) {
  const shown = items.slice(0, SUBAGENT_NOTICE_ROWS);
  const hidden = items.length - shown.length;
  return (
    <div className="subagent-notice" role="note" aria-label="Notice from Mousse">
      {shown.map((item, index) => {
        if (item.event === "note" || item.event === "monitor") return <OpenableNoticeRow key={`${item.event}:${item.delegationId}:${index}`} item={item} />;
        const name = noticeItemName(item);
        const { verb, tone } = noticeOutcome(item);
        return (
          <button
            key={item.requestId ?? item.delegationId}
            type="button"
            className="subagent-notice-row"
            title={`Open ${name}`}
            onClick={() => onOpen(item.childThreadId)}
          >
            <span className="subagent-notice-dot" data-tone={tone} aria-hidden="true" />
            <span className="subagent-notice-name">{name}</span>
            <span className="subagent-notice-detail">{verb}</span>
            {!item.fullyShown && <span className="subagent-notice-detail">· partial result</span>}
          </button>
        );
      })}
      {hidden > 0 && <span className="subagent-notice-row">and {hidden} more</span>}
    </div>
  );
}

/**
 * Another agent's note, or what this thread's monitor or background command reported: one quiet row that opens in place
 * on the words (the note, the monitor's lines and a command's last output). Nothing on it moves; it opens only when
 * clicked. The notice text the agent reads is not shown.
 */
export function OpenableNoticeRow({ item, initiallyOpen = false }: { item: SubagentNoticeItem; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const line = item.event === "monitor"
    ? monitorNoticeLine(item)
    : { name: noteNoticeName(item), detail: "sent a note", tone: "done" as const };
  const words = item.event === "note"
    ? item.note?.text ?? ""
    : [
        ...(item.monitor?.lines ?? []),
        ...(item.monitor?.dropped ? [`\u2026 ${item.monitor.dropped} more not shown`] : []),
        ...(item.monitor?.tail ? [item.monitor.tail.replace(/\s+$/, "")] : []),
      ].join("\n");
  return (
    <div className="subagent-notice-openable">
      <button
        type="button"
        className="subagent-notice-row"
        aria-expanded={words ? open : undefined}
        disabled={!words}
        title={words ? (open ? "Hide" : "Show") : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="subagent-notice-dot" data-tone={line.tone} aria-hidden="true" />
        <span className="subagent-notice-name">{line.name}</span>
        <span className="subagent-notice-detail">{line.detail}</span>
      </button>
      {open && words && (item.event === "note"
        ? <div className="subagent-notice-words" data-kind="note">{words}</div>
        : <pre className="subagent-notice-words" data-kind="monitor">{words}</pre>)}
    </div>
  );
}

export function SubagentNotice({ items }: { items: readonly SubagentNoticeItem[] }) {
  return <SubagentNoticeView items={items} onOpen={(threadId) => void openThread(threadId)} />;
}

/**
 * Background tasks of the runtime (a Claude Code background agent or shell) that finished and that the
 * agent's own turn reads now. Drawn from the structured payload on the message that opens that turn; a task
 * whose subagent card is in the thread shows there instead.
 */
export function BackgroundNotice({ items }: { items: readonly BackgroundTaskNoticeItem[] }) {
  const shown = items.slice(0, SUBAGENT_NOTICE_ROWS);
  const hidden = items.length - shown.length;
  return (
    <div className="subagent-notice">
      {shown.map((item) => (
        <span key={item.taskId} className="subagent-notice-row">
          <span className="subagent-notice-dot" data-tone="done" aria-hidden="true" />
          <span className="subagent-notice-name">{backgroundNoticeName(item)}</span>
          <span className="subagent-notice-detail">finished</span>
        </span>
      ))}
      {hidden > 0 && <span className="subagent-notice-row">and {hidden} more</span>}
    </div>
  );
}

/**
 * What Mousse told this thread's agent about work it asked to hear about (`notify`): one quiet row per thread, the
 * thread as its chip (title and live status; a click opens it) and what happened there. Mousse wrote it; it is neither
 * the person's message nor an agent's. The message text, which the model reads, is not shown.
 */
export function SettleNotice({ items }: { items: readonly SettleNoticeItem[] }) {
  const shown = items.slice(0, SUBAGENT_NOTICE_ROWS);
  const hidden = items.length - shown.length;
  return (
    <div className="subagent-notice" role="note" aria-label="Notice from Mousse">
      {shown.map((item) => {
        const { verb, tone } = settleNoticeOutcome(item);
        return (
          <span key={`${item.watchId}:${item.event}`} className="subagent-notice-row">
            <span className="subagent-notice-dot" data-tone={tone} aria-hidden="true" />
            <ThreadChip threadId={item.threadId} label={settleNoticeName(item)} />
            <span className="subagent-notice-detail">{verb}</span>
            {item.cut && <span className="subagent-notice-detail">· partial reply</span>}
          </span>
        );
      })}
      {hidden > 0 && <span className="subagent-notice-row">and {hidden} more</span>}
    </div>
  );
}
