import React, {
  memo,
  useId,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useState,
  useMemo,
} from "react";
import type { UIMessage, ChatStatus } from "ai";
import { cn } from "./utils/cn";
import { motionScale } from "../../../lib/motion";
import { ProviderIcon } from "../../../lib/providerIcons";
import { inferModelBrand } from "../../../../shared/modelVariants";
import { useProviderSnapshotsStore } from "../../../lib/providerSnapshots";
import { resolveModelChoice } from "../../../lib/modelChoice";
import { modelLabel } from "../../../../shared/modelChoice";

import { UserMessage } from "./user-message";
import { AppletCard, isAppletPart } from "../../../components/applets/AppletCard";
import { PacedMarkdown } from "./paced-markdown";
import { holdReplyPacing } from "../../../lib/replyPacingSetting";
import { ErrorMessage } from "./error-message";
import { useTurnActions } from "./turn-actions";
import type { CustomToolRendererProps } from "./types";
import { ToolRowBase } from "./tools/tool-row-base";
import { ArrowShrink, GitFork, History, ThinkingIcon, IconChevronDown, IconCopy, IconCheck, IconInfoCircle, IconX, Square, Wrench } from "../../../lib/icons";
import {
  formatResponseTime,
  formatTokens,
  formatTokensPerSecond,
} from "../../../utils/assistantMessageActions";
import { ToolRenderer as DefaultToolRenderer } from "./tools/tool-renderer";
import { ToolCallsGroup } from "./tools/tool-calls-group";
import { TurnProgressRow, useTurnProgressState } from "./turn-progress";
import {
  PermissionRequestRow,
  isPermissionRequestPart,
  isWaitingPermissionRequest,
} from "./tools/permission-request";
import { SubagentCardGroup } from "./tools/SubagentCard";
import { BackgroundNotice, SubagentNotice } from "./tools/SubagentNotice";
import { SteerGroup } from "./steer-group";
import { isRunningSubagent } from "../../../../shared/subagents";
import { useSubagentCards } from "./tools/subagent-cards-context";
import { readSubagentNotice } from "../../adapters/subagentNotice";
import { readBackgroundNotice } from "../../adapters/nativeSubagents";
import { openThread } from "../../../lib/openThread";
import { normalizeAssistantToolParts } from "./utils/tool-part-normalizer";
import { getToolStatus } from "./utils/format-tool";
import {
  activityGroupLabel,
  analyzeAssistantMessage,
  liveGroupThought,
  settleEarlierThoughts,
  isErrorPart,
  isRecord,
  isTextPart,
  isV5ToolPart,
  partitionTurnSegments,
  isCompactionRow,
  settleFinishedTurn,
  turnAnswerText,
  type ToolPartBase,
} from "./utils/assistant-blocks";
import { PromptEditButton, PromptUndoButton, PromptVersionSwitcher } from "../../../components/PromptUndoControls";
import { RepeatThisMenu } from "../../../components/automations/RepeatThis";
import { TurnEditSummary } from "./turn-edit-summary";
import { SpiralLoader } from "./spiral-loader";
import { ReadAloudButton, useIsReadingAloud } from "../../../readAloud/ReadAloudButton";
import { useVisiblePromptIds } from "./use-visible-prompt-ids";
import { formatDurationLong, formatWorkedFor, formatWorkingFor } from "../../../utils/responseTimeline";
import {
  classifyIntent,
  nextComposerCompact,
  reduceFollow,
  type FollowEvent,
  type FollowMode,
  type Intent,
  type KeyFocus,
} from "./virtual/follow-mode";
import {
  RENDER_ALL_THRESHOLD,
  estimateTurnHeight,
  lastIndexAtOrBefore,
  resolveTurnKey,
  shouldGlide,
  windowRowItems,
  type RowItem,
} from "./virtual/turn-window";
import { useTurnWindow } from "./virtual/use-turn-window";
import { createEndFollower, type EndFollower } from "./virtual/end-follower";
import { TurnIdContext } from "./turn-context";
import { countRender } from "./render-counts";
import { FindInThreadBar } from "./find/FindInThreadBar";
import { findBarHost, placeFindBar } from "./find/find-bar-host";
import { useThreadFind } from "./find/use-thread-find";
import { FindRailButton } from "./find/FindRailButton";
import { cappedWords, markdownPreviewText } from "./utils/preview-text";
import { flashLocated, revealMessage } from "./reveal-message";
import { isStale, useChatNavigationStore } from "../../../stores/chatNavigationStore";
import "../../../styles/prompt-visibility.css";

export type MessageListProps = {
  messages: UIMessage[];
  status: ChatStatus;
  className?: string;
  onAtBottomChange?: (atBottom: boolean) => void;
  /** The composer should fold to one line: the reader is browsing earlier messages. */
  onComposerCompactChange?: (compact: boolean) => void;
  lastTurnNotice?: React.ReactNode;
  /**
   * Drawn after the last turn (the thread's queued messages), above the reply gap. Outside the
   * windowed rows, so it follows the end.
   */
  afterTurns?: React.ReactNode;
  showCopyToolbar?: boolean;
  suppressQuestionTool?: boolean;
  /**
   * Where to position the scroll container on initial mount.
   * - "bottom" (default): classic chat behavior, pinned to the latest message.
   * - "top": start from the top of the conversation — useful for static demos
   *   or read-only transcripts where the user should read top-to-bottom.
   */
  initialScrollBehavior?: "bottom" | "top";
  /**
   * When true (default) clicking an attached image in a user message opens
   * the fullscreen lightbox preview. Set to false to disable previews.
   */
  enableImagePreview?: boolean;
  /**
   * When true, Ctrl/Cmd+F opens a find bar over the transcript that searches
   * the whole thread, including turns that are not mounted. Off by default:
   * only the list the app shows as its open thread turns it on.
   */
  enableFind?: boolean;
  slots?: {
    UserMessage?: React.ComponentType<{
      message: UIMessage;
      className?: string;
      enableImagePreview?: boolean;
    }>;
    ToolRenderer?: React.ComponentType<ToolRendererProps>;
  };
  classNames?: {
    userMessage?: string;
  };
  toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
};

const SCROLL_THRESHOLD = 80;
/**
 * The space under the newest text while a reply is in progress: about three lines above the
 * composer (with the list's end padding). A finished last turn's toolbar takes the same space,
 * since it overlaps that padding by the rest of its height, so the text does not move when the
 * reply ends.
 */
const REPLY_GAP_CLASS = "h-[44px]";
const TURN_TOOLBAR_CLASS = "h-[48px] flex items-start w-full";
const LAST_TURN_TOOLBAR_CLASS = `${TURN_TOOLBAR_CLASS} -mb-1`;
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
type ToolRendererProps = {
  part: ToolPartBase;
  nestedTools?: ToolPartBase[];
  chatStatus?: string;
  toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
};

function normalizeMessages(messages: UIMessage[]): UIMessage[] {
  let changed = false;
  const normalized = messages.map((message) => {
    if (Array.isArray(message.parts) && message.parts.length > 0)
      return message;
    const raw = message as { content?: string; text?: string };
    const content = raw.content ?? raw.text;
    if (typeof content !== "string" || !content) return message;
    changed = true;
    return {
      ...message,
      parts: [{ type: "text", text: content }],
    } as UIMessage;
  });
  return changed ? normalized : messages;
}

function getLastAssistantHasContent(messages: UIMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    return (msg.parts ?? []).some((part) => {
      if (isTextPart(part)) return part.text.trim().length > 0;
      if (isRecord(part) && part.type === "data-applet-pending") return true;
      if (isPermissionRequestPart(part)) return true;
      return isV5ToolPart(part) || isAppletPart(part);
    });
  }
  return false;
}

function readCreatedAt(message: UIMessage | undefined): number | null {
  const raw = (message as { createdAt?: Date | string } | undefined)?.createdAt;
  if (!raw) return null;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

/** A line Mousse adds to the thread (see `ThreadNotice`); it is not part of a turn's work. */
function isThreadNotice(message: UIMessage | undefined): boolean {
  return (message?.metadata as { notice?: boolean } | undefined)?.notice === true;
}

/** Mousse's own line in the thread, quiet and apart from the agent's answer. Backticks mark a command. */
function ThreadNotice({ text }: { text: string }) {
  return <div role="note" className="w-full py-1.5 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
    {text.split("`").map((part, index) => index % 2 ? <code key={index} className="font-mono text-[11px] text-foreground/80">{part}</code> : part)}
  </div>;
}

function turnDurationMs(
  user: UIMessage | undefined,
  assistants: UIMessage[],
): number | null {
  const start = readCreatedAt(user);
  if (start == null) return null;
  let end = start;
  for (const message of assistants) {
    // A compaction started after the turn (Compact now, hours later) is no part of its work.
    if (isThreadNotice(message) || isCompactionRow(message)) continue;
    const at = readCreatedAt(message);
    if (at != null && at > end) end = at;
  }
  return Math.max(0, end - start);
}

function TurnWorkStatus({
  active,
  startedAt,
  durationMs,
  waitingLabel,
}: {
  active: boolean;
  startedAt?: number | null;
  durationMs: number | null;
  /** Said instead of the time while the reply waits for the user (an approval). */
  waitingLabel?: string;
}) {
  const fallbackStartRef = useRef<number | null>(null);
  if (!active) fallbackStartRef.current = null;
  else if (startedAt == null && fallbackStartRef.current == null) {
    fallbackStartRef.current = Date.now();
  }
  const origin = startedAt ?? fallbackStartRef.current;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const elapsedMs =
    active && origin != null ? Math.max(0, now - origin) : durationMs;
  const label =
    active && waitingLabel
      ? waitingLabel
      : elapsedMs == null
        ? null
        : active
          ? formatWorkingFor(elapsedMs)
          : formatWorkedFor(elapsedMs);
  if (!label) return null;
  const longLabel =
    elapsedMs == null || (active && waitingLabel)
      ? undefined
      : `${active ? "Working for" : "Worked for"} ${formatDurationLong(elapsedMs)}`;
  return (
    <div className="turn-work" data-find-ignore>
      {active && !waitingLabel ? (
        <LiveWorkLabel working={label} title={longLabel} />
      ) : (
        <div className="turn-work-label" title={longLabel}>{label}</div>
      )}
      <div className="turn-work-rule" aria-hidden="true" />
    </div>
  );
}

/**
 * A running turn's header: Working, or what the run waits for when it is the person (an answer to its question).
 * Only a running turn reads the thread's turn, so a finished one does not render again as it changes.
 */
function LiveWorkLabel({ working, title }: { working: string; title?: string }) {
  // The tooltip goes with the label: a run waiting for an answer is not "Working for …".
  if (useTurnProgressState()?.phase === "awaiting_input") return <div className="turn-work-label">Waiting for your answer</div>;
  return <div className="turn-work-label" title={title}>{working}</div>;
}

function getTextFromParts(parts: unknown[], joiner: string): string {
  return parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join(joiner);
}

function formatTimestamp(date: Date): string {
  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isSameDay) {
    return timeFormatter.format(date);
  }
  return dateFormatter.format(date);
}

/**
 * A prompt open for editing, in place of its bubble. Send (or Enter) sends the edited text as a new version of the
 * prompt; Cancel (or Escape) closes it unchanged. Shift+Enter adds a line.
 */
function PromptEditor({ initial, onCancel, onSend }: { initial: string; onCancel: () => void; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState(initial);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, []);
  useEffect(() => {
    const area = ref.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(area.scrollHeight, 320)}px`;
  }, [text]);
  const send = () => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    void onSend(value).finally(() => setSending(false));
  };
  return (
    <div className="ml-auto w-full max-w-[85%] rounded-2xl border border-an-border bg-an-background-secondary p-2" data-find-ignore>
      <textarea
        ref={ref}
        aria-label="Edit message"
        value={text}
        disabled={sending}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); }
        }}
        rows={1}
        className="w-full resize-none bg-transparent px-2 py-1 text-sm text-an-foreground outline-none"
      />
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} disabled={sending} className="rounded-md px-2.5 py-1 text-xs text-an-foreground-muted hover:bg-an-foreground/10">Cancel</button>
        <button type="button" onClick={send} disabled={sending || !text.trim()} className="rounded-md bg-an-foreground px-2.5 py-1 text-xs text-an-background disabled:opacity-40">{sending ? "Sending…" : "Send"}</button>
      </div>
    </div>
  );
}

/** Fork from here: a new thread that starts after this finished turn, with the conversation up to it. */
function ForkFromTurnButton({ turnId }: { turnId: string }) {
  const turnActions = useTurnActions();
  const [forking, setForking] = useState(false);
  if (!turnActions?.forkFrom) return null;
  const forkFrom = turnActions.forkFrom;
  return (
    <button
      type="button"
      disabled={forking}
      onClick={() => {
        setForking(true);
        forkFrom(turnId);
        window.setTimeout(() => setForking(false), 1500);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      title="Fork from here"
      aria-label="Fork from here"
      className={cn(
        "size-6 flex items-center justify-center rounded-md active:scale-[0.97] transition-[background-color,opacity,transform] duration-150 ease-out",
        "opacity-50 bg-transparent enabled:hover:opacity-100 enabled:hover:bg-an-foreground/10 disabled:cursor-default",
      )}
    >
      <GitFork className="w-3.5 h-3.5 text-an-foreground-muted" />
    </button>
  );
}

function CopyButton({
  text,
  onCopied,
}: {
  text: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  const handleCopy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 2000);
    onCopied?.();
  };
  return (
    <>
      <button
        type="button"
        onClick={handleCopy}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        title="Copy"
        aria-label="Copy"
        className={cn(
          "size-6 flex items-center justify-center rounded-md active:scale-[0.97] transition-[background-color,opacity,transform] duration-150 ease-out",
          "opacity-50 bg-transparent hover:opacity-100 hover:bg-an-foreground/10",
        )}
      >
        <div className="relative w-3.5 h-3.5">
          <IconCopy
            className={cn(
              "absolute inset-0 w-3.5 h-3.5 text-an-foreground-muted transition-[opacity,transform] duration-150 ease-out",
              copied ? "opacity-0 scale-50" : "opacity-100 scale-100",
            )}
          />
          <IconCheck
            className={cn(
              "absolute inset-0 w-3.5 h-3.5 text-an-foreground-muted transition-[opacity,transform] duration-150 ease-out",
              copied ? "opacity-100 scale-100" : "opacity-0 scale-50",
            )}
          />
        </div>
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

/** LLM details carried on UIMessage.metadata via mousseToUIMessages(). */
export type ResponseMetadata = {
  modelName?: string;
  totalResponseTimeMs?: number;
  tokensUsed?: number;
  tokensPerSecond?: number;
};

/**
 * A finished turn shows its toolbar when it has text to copy or a reply's metadata. The list keeps
 * the reply gap under a last turn without one, so neither ending a reply nor opening the thread
 * moves the text.
 */
function finishedTurnHasToolbar(assistantMsgs: UIMessage[], showCopyToolbar: boolean): boolean {
  if (assistantMsgs.some((message) => getResponseMetadata(message) !== undefined)) return true;
  return showCopyToolbar && Boolean(getTextFromParts(assistantMsgs.flatMap((message) => message.parts ?? []), "\n\n").trim());
}

function getResponseMetadata(msg: UIMessage): ResponseMetadata | undefined {
  const raw = (msg as { metadata?: unknown }).metadata;
  if (!raw || typeof raw !== "object") return undefined;
  const meta = raw as Record<string, unknown>;
  const pickNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const pickString = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value : undefined;
  const resolved: ResponseMetadata = {
    modelName: pickString(meta.modelName),
    totalResponseTimeMs: pickNumber(meta.totalResponseTimeMs),
    tokensUsed: pickNumber(meta.tokensUsed),
    tokensPerSecond: pickNumber(meta.tokensPerSecond),
  };
  if (
    resolved.modelName === undefined &&
    resolved.totalResponseTimeMs === undefined &&
    resolved.tokensUsed === undefined &&
    resolved.tokensPerSecond === undefined
  ) {
    return undefined;
  }
  return resolved;
}

function MetadataButton({
  metadata,
  onOpenChange,
}: {
  metadata: ResponseMetadata;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open ]);

  const buttonClass = cn(
    "size-6 flex items-center justify-center rounded-md active:scale-[0.97] transition-[background-color,opacity,transform] duration-150 ease-out",
    "opacity-50 bg-transparent hover:opacity-100 hover:bg-an-foreground/10",
    open && "opacity-100 bg-an-foreground/10",
  );

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        title="Details"
        aria-label="Details"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={panelId}
        className={buttonClass}
      >
        <IconInfoCircle className="w-3.5 h-3.5 text-an-foreground-muted" />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Response metadata"
          className="absolute bottom-full left-0 z-20 mb-2 w-64 rounded-lg border border-an-border-color bg-an-background p-3 shadow-lg"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-an-foreground">
              Response metadata
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close response metadata"
              className="flex size-5 items-center justify-center rounded-md opacity-60 hover:opacity-100 hover:bg-an-foreground/10"
            >
              <IconX className="size-3.5 text-an-foreground-muted" />
            </button>
          </div>
          <dl className="space-y-1.5 text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-an-foreground-muted">Model</dt>
              <dd className="text-right font-medium text-an-foreground">
                {metadata.modelName ? <span title={metadata.modelName}>{modelLabel(resolveModelChoice({ provider: "", model: metadata.modelName }))}</span> : "Unavailable"}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-an-foreground-muted">Time taken</dt>
              <dd className="text-right font-medium text-an-foreground">
                {formatResponseTime(metadata.totalResponseTimeMs)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-an-foreground-muted">Tokens</dt>
              <dd className="text-right font-medium text-an-foreground">
                {formatTokens(metadata.tokensUsed)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-an-foreground-muted">Speed</dt>
              <dd className="text-right font-medium text-an-foreground">
                {formatTokensPerSecond(metadata.tokensPerSecond)} tok/s
              </dd>
            </div>
          </dl>
        </div>
      )}
    </div>
  );
}

function MessageToolbar({
  text,
  timestamp,
  heightClass,
  hoverClass,
  isVisible,
  alignClass,
  onCopied,
  undoMessageId,
  promptTurnId,
  onEdit,
  forkTurnId,
  metadata,
  speechKey,
  speechText,
  repeatText,
}: {
  text?: string;
  timestamp?: string;
  heightClass: string;
  hoverClass: string;
  isVisible: boolean;
  alignClass: string;
  onCopied?: () => void;
  undoMessageId?: string;
  /** The prompt's turn, for Edit and its versions. */
  promptTurnId?: string;
  onEdit?: () => void;
  /** The finished turn Fork from here starts after (its run, the `turnId` of its messages). */
  forkTurnId?: string;
  metadata?: ResponseMetadata;
  /** Identifies the message for read aloud; the button shows only with text. */
  speechKey?: string;
  /** What read aloud reads, when not all of `text` (a turn's answer, without its notes). */
  speechText?: string;
  /** A prompt the person wrote: its menu offers Repeat this… (an automation that sends it again). */
  repeatText?: string;
}) {
  const [metadataOpen, setMetadataOpen] = useState(false);
  const reading = useIsReadingAloud(speechKey);
  // Keep the toolbar interactive while the popup is open — otherwise the
  // hover-gated opacity hides the popup the moment the cursor leaves.
  const visible = isVisible || metadataOpen || reading;
  return (
    <div
      data-find-ignore
      className={cn(
        // Keyboard focus shows the toolbar the same way hover does.
        "chat-message-toolbar relative flex items-center gap-1 pt-1 text-sm text-an-foreground-muted/70 opacity-0 transition-opacity duration-100 pointer-events-none focus-within:opacity-100 focus-within:pointer-events-auto",
        heightClass,
        alignClass,
        hoverClass,
        visible && "opacity-100 pointer-events-auto",
      )}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {timestamp && <span>{timestamp}</span>}
      {undoMessageId && <PromptUndoButton messageId={undoMessageId} />}
      {onEdit && <PromptEditButton turnId={promptTurnId} onEdit={onEdit} />}
      {text && speechKey && (speechText ?? text) && (
        <ReadAloudButton speechKey={speechKey} markdown={speechText ?? text} />
      )}
      {text && <CopyButton text={text} onCopied={onCopied} />}
      {forkTurnId && <ForkFromTurnButton turnId={forkTurnId} />}
      {repeatText && <RepeatThisMenu text={repeatText} />}
      {metadata && (
        <span onPointerDown={(event) => event.stopPropagation()}>
          <MetadataButton metadata={metadata} onOpenChange={setMetadataOpen} />
        </span>
      )}
    </div>
  );
}

/**
 * Group flat messages into turns: a message the user wrote and everything that
 * follows it. Subagent results delivered to the thread are not something the
 * user wrote: they join the reply in progress, in place, with only their
 * structured notice kept (their text is what the model reads).
 */
export type Turn = { userMsg?: UIMessage; assistantMsgs: UIMessage[] };

/** A message that reports results (a subagent's, or the runtime's own background tasks): not something the user wrote. */
function isResultNotice(msg: UIMessage | undefined): boolean {
  return Boolean(readSubagentNotice(msg) || readBackgroundNotice(msg));
}

/** The empty-parts copy of a subagent-results message that joins a reply, one per message. */
const noticeCopies = new WeakMap<UIMessage, UIMessage>();

/** A user message sent into a reply already in progress (Steer): it joins that reply, not a turn of its own. */
function isSteeredMessage(message: UIMessage): boolean {
  return (message.metadata as { steered?: unknown } | undefined)?.steered === true;
}

/** The messages a steer group row stands for, or undefined when the row is not one. */
export function readSteerGroup(message: UIMessage): UIMessage[] | undefined {
  const group = (message.metadata as { steerGroup?: unknown } | undefined)?.steerGroup;
  return Array.isArray(group) ? (group as UIMessage[]) : undefined;
}

/** Steer group rows by their first message, kept while their messages are the same objects (memoised rows). */
const steerGroups = new WeakMap<UIMessage, UIMessage>();

function steerGroupRow(members: UIMessage[]): UIMessage {
  const first = members[0]!;
  const cached = steerGroups.get(first);
  const same = cached && readSteerGroup(cached)?.length === members.length &&
    readSteerGroup(cached)!.every((message, index) => message === members[index]);
  if (cached && same) return cached;
  const row = {
    id: `steer-group:${first.id}`,
    role: "user",
    parts: [],
    metadata: { steerGroup: members },
  } as unknown as UIMessage;
  steerGroups.set(first, row);
  return row;
}

export function groupMessagesIntoTurns(messages: UIMessage[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  // Messages steered into the reply one after another, with nothing of the reply between them: one block.
  let steered: UIMessage[] = [];
  const flushSteered = () => {
    if (!steered.length || !current) return;
    current.assistantMsgs.push(steerGroupRow(steered));
    steered = [];
  };

  for (const msg of messages) {
    if (msg.role === "user" && current && isSteeredMessage(msg) && !isResultNotice(msg)) {
      steered.push(msg);
      continue;
    }
    flushSteered();
    if (msg.role === "user") {
      if (current && isResultNotice(msg)) {
        let copy = noticeCopies.get(msg);
        if (!copy) {
          copy = { ...msg, parts: [] };
          noticeCopies.set(msg, copy);
        }
        current.assistantMsgs.push(copy);
        continue;
      }
      if (current) turns.push(current);
      current = { userMsg: msg, assistantMsgs: [] };
    } else if (msg.role === "assistant") {
      if (!current) current = { assistantMsgs: [] };
      current.assistantMsgs.push(msg);
    }
  }
  flushSteered();
  if (current) turns.push(current);
  return turns;
}

function sameTurn(a: Turn, b: Turn): boolean {
  if (a.userMsg !== b.userMsg) return false;
  if (a.assistantMsgs.length !== b.assistantMsgs.length) return false;
  return a.assistantMsgs.every((message, index) => message === b.assistantMsgs[index]);
}

/**
 * `next` with every turn whose messages are the same objects as in `previous` replaced by the
 * previous turn, so memoised rows of unchanged turns skip rendering. Turns are matched by position:
 * a thread only grows at the end, and a page of earlier messages shifts every turn (a cache miss).
 */
function reuseTurns(previous: Turn[], next: Turn[]): Turn[] {
  let reused = 0;
  const merged = next.map((turn, index) => {
    const before = previous[index];
    if (before && sameTurn(before, turn)) {
      reused += 1;
      return before;
    }
    return turn;
  });
  return reused === next.length && next.length === previous.length ? previous : merged;
}

type PromptMarker = { id: string; offset: number; preview: string; responsePreview: string };

/**
 * What the overlay needs from a windowed list, where most prompts are not in
 * the DOM: every prompt's offset from the layout, and an instant, settled jump.
 */
export type PromptMarkerLayout = {
  offsetOf: (id: string) => number | undefined;
  scrollTo: (id: string) => void;
  subscribe: (listener: () => void) => () => void;
};


/** Width of the tick column (`.chat-prompt-ticks`), its distance from the pane's left edge, and the least gap it keeps to the transcript text. */
const PROMPT_RAIL_WIDTH = 40;
const PROMPT_RAIL_EDGE = 12;
const PROMPT_RAIL_GAP = 8;
/** The rail shows once the thread has this many prompts to move between, however short the thread is. */
const PROMPT_RAIL_MIN_PROMPTS = 2;

/**
 * Where the rail sits (px from the left of the list): close to the pane's left edge, or null when the
 * thread has a single prompt or the gutter is too narrow for the rail to stay clear of the text.
 */
export function promptRailLeft({ textLeft, prompts }: {
  textLeft: number;
  prompts: number;
}): number | null {
  if (prompts < PROMPT_RAIL_MIN_PROMPTS) return null;
  return textLeft - PROMPT_RAIL_EDGE - PROMPT_RAIL_WIDTH >= PROMPT_RAIL_GAP ? PROMPT_RAIL_EDGE : null;
}

/**
 * Conversation ticks. Deliberately isolated with its own state: position
 * recomputes (ResizeObserver + streaming + expand/collapse) must never
 * re-render the message list — that was the expand/collapse stutter whenever
 * the markers were visible. Marker updates only re-render this tiny overlay.
 */
/** A turn's tick tooltip text, kept per turn object: only a turn whose messages changed is read again. */
const markerPreviews = new WeakMap<Turn, { preview: string; responsePreview: string }>();

function markerPreview(turn: Turn): { preview: string; responsePreview: string } {
  let cached = markerPreviews.get(turn);
  if (!cached) {
    // The tooltip shows plain text: Markdown syntax in the prompt or the reply is dropped.
    cached = {
      preview: cappedWords(markdownPreviewText(getTextFromParts(turn.userMsg?.parts ?? [], "\n")), 10),
      responsePreview: cappedWords(
        markdownPreviewText(
          turn.assistantMsgs.map((message) => getTextFromParts(message.parts ?? [], "\n\n")).join("\n\n"),
        ),
        24,
      ),
    };
    markerPreviews.set(turn, cached);
  }
  return cached;
}

/**
 * While the transcript grows (a streamed reply, an image loading), ticks are placed again at most
 * this often. Adding or removing a prompt places them at once.
 */
const MARKER_GROWTH_MS = 500;

export const PromptMarkersOverlay = memo(function PromptMarkersOverlay({
  messages,
  turns: givenTurns,
  containerRef,
  contentRef,
  visible,
  onActive,
  onUserNavigate,
  markProgrammatic,
  scrollAnimRef,
  layout,
  onFind,
}: {
  /** The transcript; `turns` instead when the list already grouped it. */
  messages?: UIMessage[];
  turns?: Turn[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  onActive: () => void;
  onUserNavigate: () => void;
  markProgrammatic: () => void;
  scrollAnimRef: React.MutableRefObject<number>;
  /** Set while the list is windowed; without it every prompt is read from the DOM. */
  layout?: PromptMarkerLayout;
  /** Opens find in thread: a search button sits above the ticks. */
  onFind?: (() => void) | null;
}) {
  const [markers, setMarkers] = useState<PromptMarker[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [previewId, setPreviewId] = useState<string>();
  const [railLeft, setRailLeft] = useState<number | null>(null);
  const markerPositionsRef = useRef<PromptMarker[]>([]);
  const markerOffsetsRef = useRef<number[]>([]);
  const rafRef = useRef(0);
  const growthTimerRef = useRef(0);
  /** The transcript column's left edge (viewport px) when the rail was last placed. */
  const columnLeftRef = useRef<number | null>(null);
  const turns = useMemo(
    () => givenTurns ?? groupMessagesIntoTurns(normalizeMessages(messages ?? [])),
    [givenTurns, messages],
  );
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  // The prompts the ticks stand for. A streamed delta leaves it unchanged, so it does not place the ticks again.
  const promptKey = useMemo(
    () =>
      turns
        .map((turn) => (turn.userMsg && !isResultNotice(turn.userMsg) ? turn.userMsg.id : ""))
        .join("\n"),
    [turns],
  );

  const updateActiveMarker = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const atBottom = container.scrollHeight > container.clientHeight &&
      container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
    if (layout) {
      // Offsets are ascending and all finite: binary search instead of a scan.
      const all = markerPositionsRef.current;
      if (!all.length) return;
      const index = lastIndexAtOrBefore(markerOffsetsRef.current, container.scrollTop + 24);
      setActiveId((atBottom ? all[all.length - 1] : all[Math.max(index, 0)])?.id);
      return;
    }
    const positions = markerPositionsRef.current.filter((marker) => Number.isFinite(marker.offset));
    if (!positions.length) return;
    let current = positions[0];
    for (const marker of positions) {
      if (atBottom || marker.offset <= container.scrollTop + 24) current = marker;
      else break;
    }
    setActiveId(current?.id);
  }, [containerRef, layout]);

  const updateMarkers = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (growthTimerRef.current) {
      window.clearTimeout(growthTimerRef.current);
      growthTimerRef.current = 0;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      countRender("updateMarkers");
      const container = containerRef.current;
      const content = contentRef.current;
      if (!container || !content) return;
      // Not laid out yet (a hidden pane): the container's observer places the rail once it is.
      if (!container.scrollHeight) return;
      const escapeId =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? (id: string) => CSS.escape(id)
          : (id: string) => id.replace(/["\\]/g, "\\$&");
      const next: PromptMarker[] = [];
      const containerRect = container.getBoundingClientRect();
      for (const turn of turnsRef.current) {
        const userMsg = turn.userMsg;
        // A message that delivers subagent results is not a prompt the user wrote.
        if (!userMsg || isResultNotice(userMsg)) continue;
        const target: Element | null = layout
          ? null
          : content.querySelector(`[data-prompt-id="${escapeId(userMsg.id)}"]`);
        // Rect-based so nested `relative` wrappers / transforms can't skew it.
        const y = layout
          ? layout.offsetOf(userMsg.id) ?? Infinity
          : target instanceof HTMLElement
            ? target.getBoundingClientRect().top - containerRect.top + container.scrollTop
            : markerPositionsRef.current.find((marker) => marker.id === userMsg.id)?.offset ?? Infinity;
        const { preview, responsePreview } = markerPreview(turn);
        next.push({
          id: userMsg.id,
          offset: y,
          preview: preview || "Your prompt",
          responsePreview: responsePreview || "No response yet",
        });
      }
      markerPositionsRef.current = next;
      markerOffsetsRef.current = next.map((marker) => marker.offset);
      const listLeft = (container.parentElement ?? container).getBoundingClientRect().left;
      const columnLeft = content.getBoundingClientRect().left;
      columnLeftRef.current = columnLeft;
      setRailLeft(promptRailLeft({
        textLeft: columnLeft - listLeft + (parseFloat(getComputedStyle(content).paddingLeft) || 0),
        prompts: next.length,
      }));
      updateActiveMarker();
      setMarkers((prev) => {
        if (
          prev.length === next.length &&
          prev.every(
            (m, i) =>
              m.id === next[i]!.id &&
              m.preview === next[i]!.preview &&
              m.responsePreview === next[i]!.responsePreview,
          )
        ) {
          return prev;
        }
        return next;
      });
    });
    // `promptKey` stands for the turns, which are read through `turnsRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptKey, containerRef, contentRef, updateActiveMarker, layout]);
  // Growth of the transcript places the ticks again at most every MARKER_GROWTH_MS.
  const updateMarkersSoon = useCallback(() => {
    if (growthTimerRef.current || rafRef.current) return;
    growthTimerRef.current = window.setTimeout(() => {
      growthTimerRef.current = 0;
      updateMarkers();
    }, MARKER_GROWTH_MS);
  }, [updateMarkers]);
  const visiblePromptIds = useVisiblePromptIds(containerRef, contentRef, updateMarkers);

  // The layout moves without the DOM saying so: rows measured, window shifted.
  useEffect(() => layout?.subscribe(updateMarkers), [layout, updateMarkers]);

  useEffect(() => {
    const container = containerRef.current;
    container?.addEventListener("scroll", updateActiveMarker, { passive: true });
    return () => container?.removeEventListener("scroll", updateActiveMarker);
  }, [containerRef, updateActiveMarker]);

  // Keep ticks in sync with layout (streaming text, images, expanding tool
  // cards all change offsets after first paint).
  useLayoutEffect(() => {
    updateMarkers();
  }, [updateMarkers]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    // The content grows with every streamed delta, which moves no tick above the reply.
    const contentObserver = new ResizeObserver(() => updateMarkersSoon());
    contentObserver.observe(content);
    const containerObserver = new ResizeObserver(() => updateMarkers());
    containerObserver.observe(container);
    window.addEventListener("resize", updateMarkers);
    return () => {
      contentObserver.disconnect();
      containerObserver.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (growthTimerRef.current) window.clearTimeout(growthTimerRef.current);
      growthTimerRef.current = 0;
      window.removeEventListener("resize", updateMarkers);
    };
  }, [updateMarkers, updateMarkersSoon, containerRef, contentRef]);

  // The column can move with nothing resizing: the docked side card takes width on the right and the
  // column slides left, and slides back when the card goes (Chats, Settings, Usage, the card's button).
  // The pane's style or class changes first, and a slide ends with a transition on the column.
  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    let frame = 0;
    const placeIfMoved = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (content.getBoundingClientRect().left !== columnLeftRef.current) updateMarkers();
      });
    };
    const ancestors = new MutationObserver(placeIfMoved);
    for (let element = container.parentElement; element; element = element.parentElement) {
      ancestors.observe(element, { attributes: true, attributeFilter: ["style", "class"] });
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === content) placeIfMoved();
    };
    content.addEventListener("transitionend", onTransitionEnd);
    content.addEventListener("transitioncancel", onTransitionEnd);
    return () => {
      ancestors.disconnect();
      if (frame) cancelAnimationFrame(frame);
      content.removeEventListener("transitionend", onTransitionEnd);
      content.removeEventListener("transitioncancel", onTransitionEnd);
    };
  }, [updateMarkers, containerRef, contentRef]);

  const cancelScroll = useCallback(() => {
    if (scrollAnimRef.current) {
      cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = 0;
    }
  }, [scrollAnimRef]);

  const scrollToPrompt = useCallback(
    (id: string) => {
      const container = containerRef.current;
      const content = contentRef.current;
      if (!container || !content) return;
      const escapeId =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(id)
          : id;
      const el = content.querySelector(`[data-prompt-id="${escapeId}"]`);
      const y = el instanceof HTMLElement
        ? el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
        : layout?.offsetOf(id) ?? markerPositionsRef.current.find((marker) => marker.id === id)?.offset;
      if (y === undefined || !Number.isFinite(y)) return;
      onUserNavigate();
      onActive();
      const targetTop = Math.max(0, y - 16);
      const start = container.scrollTop;
      const distance = targetTop - start;
      // A prompt that is not mounted, or is far away, lands instantly and is
      // corrected against the real DOM; gliding across rows that are still
      // being measured would aim at an estimate.
      if (layout && (!(el instanceof HTMLElement) || !shouldGlide(distance, container.clientHeight))) {
        cancelScroll();
        layout.scrollTo(id);
        return;
      }
      if (Math.abs(distance) < 4) {
        container.scrollTop = targetTop;
        return;
      }
      cancelScroll();
      // Animation speed (or the OS reduced-motion setting) scales the glide; Off jumps.
      const scale = motionScale();
      if (scale === 0) {
        container.scrollTop = targetTop;
        return;
      }
      // Custom eased glide — native smooth scroll is janky over long
      // distances. Distance-based duration keeps short hops snappy.
      const duration = Math.min(900, 320 + Math.abs(distance) * 0.22) * scale;
      const startedAt = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - startedAt) / duration);
        const eased =
          t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        markProgrammatic();
        container.scrollTop = start + distance * eased;
        if (t < 1) {
          scrollAnimRef.current = requestAnimationFrame(step);
        } else {
          scrollAnimRef.current = 0;
          // Rows measured on the way may have moved the target.
          layout?.scrollTo(id);
        }
      };
      scrollAnimRef.current = requestAnimationFrame(step);
    },
    [
      containerRef,
      contentRef,
      onUserNavigate,
      onActive,
      cancelScroll,
      markProgrammatic,
      scrollAnimRef,
      layout,
    ],
  );

  if (markers.length === 0 || railLeft === null) return null;
  const previewMarker = markers.find((marker) => marker.id === previewId);
  const highlightedIndex = markers.findIndex((marker) => marker.id === previewId);

  return (
    <div
      data-testid="prompt-markers"
      data-find-ignore
      className={cn("chat-prompt-rail", visible && "is-active", previewId && "is-previewing")}
      style={{ left: railLeft }}
      onMouseLeave={(event) => {
        const focused = document.activeElement;
        setPreviewId(focused instanceof HTMLButtonElement && event.currentTarget.contains(focused)
          ? focused.dataset.promptMarkerId
          : undefined);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPreviewId(undefined);
      }}
    >
      {/* The column the ticks centre in; the find button hangs above it, so the ticks do not move. */}
      <div className="chat-prompt-column">
      {onFind && <FindRailButton onOpen={onFind} />}
      <nav className="chat-prompt-ticks" aria-label="Conversation turns">
      {markers.map((marker, index) => (
        <button
          key={marker.id}
          type="button"
          aria-label={`Jump to prompt ${index + 1}: ${marker.preview}`}
          aria-current={marker.id === activeId ? "location" : undefined}
          data-visible={visiblePromptIds.has(marker.id) ? "true" : undefined}
          data-prompt-marker-id={marker.id}
          onClick={() => scrollToPrompt(marker.id)}
          onMouseEnter={() => { onActive(); setPreviewId(marker.id); }}
          onFocus={() => { onActive(); setPreviewId(marker.id); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setPreviewId(undefined);
          }}
          className="chat-prompt-tick"
        >
          <span style={{ width: `${highlightedIndex < 0 ? 12 : Math.max(12, 36 - Math.abs(index - highlightedIndex) * 8)}px` }} />
        </button>
      ))}
      </nav>
      </div>
      {previewMarker && (
        <div className="chat-prompt-preview" aria-hidden="true">
          <strong>{previewMarker.preview}</strong>
          <p>{previewMarker.responsePreview}</p>
        </div>
      )}
    </div>
  );
});

export const MessageList = memo(function MessageList({
  messages,
  status,
  className,
  showCopyToolbar = true,
  lastTurnNotice,
  afterTurns,
  onAtBottomChange,
  onComposerCompactChange,
  suppressQuestionTool = false,
  initialScrollBehavior = "bottom",
  enableImagePreview = true,
  enableFind = false,
  slots,
  classNames,
  toolRenderers,
}: MessageListProps) {
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const contentWrapperRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const chatContainerObserverRef = useRef<ResizeObserver | null>(null);
  // Follow the end of the thread, or leave it alone. Changed only by what the
  // user does (see `virtual/follow-mode.ts`), never by a scroll position.
  const followModeRef = useRef<FollowMode>(
    initialScrollBehavior === "top" ? "free" : "following-end",
  );
  const [activeCopyId, setActiveCopyId] = useState<string | null>(null);
  /** The prompt open for editing, by message id. */
  const [editingPromptId, setEditingPromptId] = useState<string | null>(null);
  const turnActionsForEdit = useTurnActions();
  const [isMounted, setIsMounted] = useState(false);
  const [isPinned, setIsPinned] = useState(initialScrollBehavior !== "top");
  useEffect(() => { onAtBottomChange?.(isPinned) }, [isPinned, onAtBottomChange]);

  const [scrollbarActive, setScrollbarActive] = useState(false);
  const scrollActiveTimerRef = useRef<number | null>(null);
  // Shared with PromptMarkersOverlay: the parent cancels an in-flight
  // marker glide on manual scroll (wheel/touch/pointer), the overlay drives
  // it. Marker position state itself lives in the overlay so recomputes
  // never re-render the message list.
  const promptScrollAnimRef = useRef(0);
  const workClockRef = useRef<{
    turnId: string;
    startedAt: number;
    endedAt: number | null;
  } | null>(null);
  const [settledWork, setSettledWork] = useState<Record<string, number>>({});
  // The optimistic send id is replaced by the saved id a moment later. Keep
  // one React key so the bubble does not unmount and land again.
  const turnKeyAliasRef = useRef<Map<string, string>>(new Map());
  const replyHoldRef = useRef<{ sawStreaming: boolean } | null>(null);
  const liveOptimisticKeyRef = useRef<string | null>(null);

  const CustomUserMessage = slots?.UserMessage || UserMessage;
  const CustomToolRenderer = slots?.ToolRenderer || DefaultToolRenderer;
  // Tool calls drawn as subagent cards: they stay out of the collapsed activity groups.
  const subagentCards = useSubagentCards();
  const subagentCardIds = useMemo(
    () => new Set(subagentCards.keys()),
    [subagentCards],
  );
  // Subagents (by task and by thread) whose state a card in the thread shows.
  const cardedSubagents = useMemo(() => {
    const ids = new Set<string>();
    for (const card of subagentCards.values()) {
      if (card.delegationId) ids.add(card.delegationId);
      if (card.childThreadId) ids.add(card.childThreadId);
      if (card.native?.taskId) ids.add(card.native.taskId);
    }
    return ids;
  }, [subagentCards]);

  const markCopied = useCallback((id: string) => {
    setActiveCopyId(id);
  }, []);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    const handlePointerDown = () => {
      setActiveCopyId(null);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const isStreaming = status === "streaming" || status === "submitted";

  // Folded or not, recomputed with every follow event; reported only on change.
  const composerCompactRef = useRef(false);
  const onComposerCompactChangeRef = useRef(onComposerCompactChange);
  onComposerCompactChangeRef.current = onComposerCompactChange;

  const dispatchFollow = useCallback((event: FollowEvent) => {
    const next = reduceFollow(followModeRef.current, event);
    followModeRef.current = next;
    setIsPinned(next === "following-end");
    const container = chatContainerRef.current;
    container?.toggleAttribute("data-following-end", next === "following-end");
    const compact = nextComposerCompact(composerCompactRef.current, {
      mode: next,
      distanceFromEnd: container
        ? container.scrollHeight - container.scrollTop - container.clientHeight
        : 0,
    });
    if (compact !== composerCompactRef.current) {
      composerCompactRef.current = compact;
      onComposerCompactChangeRef.current?.(compact);
    }
  }, []);

  // What the user just did to the scroll position. Assigned on every render so
  // the listeners attached once with the element always see current callbacks.
  const handleIntentRef = useRef<(intent: Intent) => void>(() => {});
  const containerCleanupRef = useRef<(() => void) | null>(null);

  const containerRefCallback = useCallback((el: HTMLDivElement | null) => {
    (
      chatContainerRef as React.MutableRefObject<HTMLDivElement | null>
    ).current = el;

    containerCleanupRef.current?.();
    containerCleanupRef.current = null;
    if (chatContainerObserverRef.current) {
      chatContainerObserverRef.current.disconnect();
      chatContainerObserverRef.current = null;
    }
    if (el) {
      el.style.setProperty("--chat-container-height", `${el.clientHeight}px`);
      const observer = new ResizeObserver((entries) => {
        const height = entries[0]?.contentRect.height ?? 0;
        el.style.setProperty("--chat-container-height", `${height}px`);
      });
      observer.observe(el);
      chatContainerObserverRef.current = observer;

      // Attached when the element mounts: no timers, no retries.
      const overflowing = () => el.scrollHeight > el.clientHeight;
      const onWheel = (event: WheelEvent) =>
        handleIntentRef.current(
          classifyIntent({
            type: "wheel",
            deltaY: event.deltaY,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            overflowing: overflowing(),
          }),
        );
      const onPointerDown = (event: PointerEvent) =>
        handleIntentRef.current(
          classifyIntent({
            type: "pointerdown",
            onContainer: event.target === el,
            offsetX: event.offsetX,
            clientWidth: el.clientWidth,
            overflowing: overflowing(),
          }),
        );
      const onTouchMove = () =>
        handleIntentRef.current(
          classifyIntent({
            type: "touchmove",
            atBottom:
              el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD,
            overflowing: overflowing(),
          }),
        );
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented) return;
        const active = document.activeElement;
        let focus: KeyFocus = "other";
        if (
          active instanceof HTMLElement &&
          (active.isContentEditable ||
            active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement ||
            active instanceof HTMLSelectElement)
        ) {
          focus = "editable";
        } else if (
          !active ||
          active === document.body ||
          active === document.documentElement
        ) {
          focus = "body";
        } else if (el.contains(active)) {
          focus = "container";
        }
        handleIntentRef.current(
          classifyIntent({
            type: "keydown",
            key: event.key,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            focus,
            overflowing: overflowing(),
          }),
        );
      };
      el.addEventListener("wheel", onWheel, { passive: true });
      el.addEventListener("pointerdown", onPointerDown);
      el.addEventListener("touchmove", onTouchMove, { passive: true });
      document.addEventListener("keydown", onKeyDown);
      containerCleanupRef.current = () => {
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("pointerdown", onPointerDown);
        el.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("keydown", onKeyDown);
      };
    }
  }, []);

  useEffect(() => {
    return () => {
      if (chatContainerObserverRef.current)
        chatContainerObserverRef.current.disconnect();
    };
  }, []);

  // Timestamp of the last programmatic scrollTop write (streaming follow,
  // mount pin, marker glide). Scroll events within the window after one are
  // auto-scroll noise — only human scrolling should reveal the markers.
  const programmaticScrollAtRef = useRef(0);
  const markProgrammaticScroll = useCallback(() => {
    programmaticScrollAtRef.current = performance.now();
  }, []);
  // Holds a just-sent prompt near the top and glides after the reply (virtual/end-follower.ts).
  const followerRef = useRef<EndFollower | null>(null);
  followerRef.current ??= createEndFollower({
    container: () => chatContainerRef.current,
    rows: () => rowsRef.current,
    mode: () => followModeRef.current,
    onProgrammaticScroll: () => {
      programmaticScrollAtRef.current = performance.now();
    },
  });
  const follower = followerRef.current;
  useEffect(() => () => followerRef.current?.dispose(), []);

  const isAtBottom = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) return true;
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <
      SCROLL_THRESHOLD
    );
  }, []);

  const flashScrollbarActive = useCallback(() => {
    setScrollbarActive(true);
    if (scrollActiveTimerRef.current) {
      window.clearTimeout(scrollActiveTimerRef.current);
    }
    scrollActiveTimerRef.current = window.setTimeout(() => {
      setScrollbarActive(false);
      scrollActiveTimerRef.current = null;
    }, 1200);
  }, []);

  const cancelPromptScroll = useCallback(() => {
    if (promptScrollAnimRef.current) {
      cancelAnimationFrame(promptScrollAnimRef.current);
      promptScrollAnimRef.current = 0;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (scrollActiveTimerRef.current) {
        window.clearTimeout(scrollActiveTimerRef.current);
      }
      if (promptScrollAnimRef.current) {
        cancelAnimationFrame(promptScrollAnimRef.current);
      }
    };
  }, []);

  // True while the thread is long enough to be windowed.
  const windowedRef = useRef(false);
  // Set after `useTurnWindow` below; the callbacks that need it run later.
  const virtualizationRef = useRef<ReturnType<typeof useTurnWindow> | null>(null);

  // A scroll caused by our own writes (streaming follow, landings, marker
  // glide) is not the user moving.
  const isProgrammaticScroll = useCallback(
    () =>
      Boolean(virtualizationRef.current?.isNavigating()) ||
      promptScrollAnimRef.current !== 0 ||
      performance.now() - programmaticScrollAtRef.current <= 150,
    [],
  );

  handleIntentRef.current = (intent: Intent) => {
    if (intent === null) return;
    // Any user motion ends a landing in progress, whatever the follow mode.
    virtualizationRef.current?.cancelNavigation();
    cancelPromptScroll();
    follower.cancel();
    dispatchFollow({ type: "intent", intent });
    follower.settle();
  };

  const handleScroll = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const programmatic = isProgrammaticScroll();
    dispatchFollow({ type: "scroll", atBottom: isAtBottom(), programmatic });
    followerRef.current?.settle();
    // Skip auto-scroll noise (streaming follow, mount pin, marker glide) —
    // only a human moving the scrollbar reveals the markers.
    if (!programmatic) flashScrollbarActive();
  }, [isAtBottom, flashScrollbarActive, isProgrammaticScroll, dispatchFollow]);

  // A marker-dot jump hands control to the user: stop following the stream
  // and hide the jump-to-latest button. The glide itself is driven by the
  // overlay (shared `promptScrollAnimRef`).
  const handleMarkerNavigateStart = useCallback(() => {
    dispatchFollow({ type: "navigate" });
  }, [dispatchFollow]);

  // Reveal markers when the cursor drifts to the scrollbar edge. Attached to
  // the wrap (bubbles up) so no overlay ever sits between the pointer and
  // the native scrollbar to steal the grab.
  const handleGutterHover = useCallback(
    (event: React.MouseEvent) => {
      const wrap = event.currentTarget as HTMLElement;
      if (event.clientX >= wrap.getBoundingClientRect().right - 28) {
        flashScrollbarActive();
      }
    },
    [flashScrollbarActive],
  );

  useLayoutEffect(() => {
    const container = chatContainerRef.current;
    const contentWrapper = contentWrapperRef.current;
    if (!container || !contentWrapper) return;

    const initial = initialScrollBehavior === "top" ? "top" : "bottom";
    programmaticScrollAtRef.current = performance.now();
    container.scrollTop = initial === "top" ? 0 : container.scrollHeight;
    followModeRef.current = reduceFollow(followModeRef.current, {
      type: "thread-open",
      initial,
    });
    container.toggleAttribute("data-following-end", followModeRef.current === "following-end");

    // The one writer that follows the end: the transcript grew (a streamed
    // delta, an image, a tool card opening, the reply gap) or the viewport
    // changed, and the observer runs after layout and before paint. The
    // follower resizes the space under a pinned prompt, then lands on the end,
    // or glides to it while a turn runs (virtual/end-follower.ts).
    // When reading history (free) nothing is written: streamed text appends
    // below the viewport, and growth above it is held by native scroll
    // anchoring (or by `useTurnWindow` in a windowed list).
    const resizeObserver = new ResizeObserver(() => followerRef.current?.follow());

    // The border box: the content's end padding is the composer's height, and the composer
    // unfolding grows only the padding.
    resizeObserver.observe(contentWrapper, { box: "border-box" });
    resizeObserver.observe(container);
    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const normalizedMessages = useMemo(
    () => normalizeMessages(messages),
    [messages],
  );
  const previousTurnsRef = useRef<Turn[]>([]);
  const turns = useMemo(() => {
    const next = reuseTurns(previousTurnsRef.current, groupMessagesIntoTurns(normalizedMessages));
    previousTurnsRef.current = next;
    return next;
  }, [normalizedMessages]);
  // The message that started the reply in progress. Subagent results that
  // join that reply do not start a new one.
  const lastUserMessageId = turns[turns.length - 1]?.userMsg?.id ?? null;
  // The last reply launched subagents that are still working: their results
  // continue it, so it is still in progress while the thread waits for them.
  const awaitingSubagents = useMemo(() => {
    const last = turns[turns.length - 1];
    if (!last?.userMsg) return false;
    return last.assistantMsgs.some((message) =>
      (message.parts ?? []).some((part: unknown) => {
        if (!isV5ToolPart(part) || !part.toolCallId) return false;
        const card = subagentCards.get(part.toolCallId);
        // A card with no task known yet (the list has not loaded) says nothing.
        return card != null && !card.pending && isRunningSubagent(card);
      }),
    );
  }, [turns, subagentCards]);
  const replyActive = isStreaming || awaitingSubagents;

  useEffect(() => {
    const turnId = lastUserMessageId;
    if (!turnId) return;
    if (replyActive) {
      const clock = workClockRef.current;
      if (clock?.turnId !== turnId) {
        const user = normalizedMessages.find((message) => message.id === turnId);
        workClockRef.current = {
          turnId,
          startedAt: readCreatedAt(user) ?? Date.now(),
          endedAt: null,
        };
      } else if (clock.endedAt != null) {
        // The same reply goes on after a pause (an answered approval or
        // question): its time runs to where it really ends.
        clock.endedAt = null;
      }
      return;
    }
    const clock = workClockRef.current;
    if (clock && clock.turnId === turnId && clock.endedAt == null) {
      const endedAt = Date.now();
      clock.endedAt = endedAt;
      const durationMs = Math.max(0, endedAt - clock.startedAt);
      setSettledWork((current) =>
        current[turnId] === durationMs
          ? current
          : { ...current, [turnId]: durationMs },
      );
    }
  }, [replyActive, lastUserMessageId, normalizedMessages]);

  const lastUserMessageIdRef = useRef(lastUserMessageId);
  // The last row's key, set in render below; read by the effect that pins a starting turn.
  const lastTurnKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (
      lastUserMessageId &&
      lastUserMessageId !== lastUserMessageIdRef.current
    ) {
      // A prompt the person just sent here takes them to the end. A turn the queue started (a queued
      // message's turn) leaves a reader of earlier messages where they are; at the end, the end is followed.
      const sentHere =
        lastUserMessageId.startsWith("optimistic:") ||
        turnKeyAliasRef.current.has(lastUserMessageId);
      if (sentHere || followModeRef.current === "following-end") {
        dispatchFollow({ type: "new-turn" });
        // A turn that is starting (sent here, or the queue's next) is held near the top while its
        // reply fills the space below. A turn that arrives already answered is not.
        const turnKey = lastTurnKeyRef.current;
        const starting = replyActive || !turns[turns.length - 1]?.assistantMsgs.length;
        if (turnKey && starting) followerRef.current?.pin(turnKey);
        void virtualizationRef.current?.settleToEnd();
      }
      lastUserMessageIdRef.current = lastUserMessageId;
    }
  }, [lastUserMessageId, dispatchFollow]);

  const lastTurn = turns[turns.length - 1];
  const trailingUser = lastTurn?.userMsg;
  const trailingHasAssistant = (lastTurn?.assistantMsgs.length ?? 0) > 0;
  const trailingOptimistic = Boolean(
    trailingUser?.id.startsWith("optimistic:"),
  );
  if (!trailingUser || trailingHasAssistant) {
    replyHoldRef.current = null;
  } else if (
    trailingOptimistic ||
    isStreaming ||
    replyHoldRef.current
  ) {
    const sawStreaming = Boolean(
      replyHoldRef.current?.sawStreaming || isStreaming,
    );
    const settledWithoutReply =
      (status === "error" || (status === "ready" && sawStreaming)) &&
      !trailingOptimistic &&
      !isStreaming;
    replyHoldRef.current = settledWithoutReply ? null : { sawStreaming };
  }
  const showAwaitingReply = Boolean(
    trailingUser && !trailingHasAssistant && replyHoldRef.current,
  );
  follower.setLive(replyActive);
  const turnLive = replyActive || showAwaitingReply;
  // The last turn whose reply was seen running. A queued turn waiting for its run keeps its pin
  // until its reply has run and ended.
  const liveTurnRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (turnLive) {
      liveTurnRef.current = lastUserMessageId;
      return;
    }
    if (liveTurnRef.current === lastUserMessageId || trailingHasAssistant) followerRef.current?.turnEnded();
  }, [turnLive, lastUserMessageId, trailingHasAssistant]);
  if (trailingOptimistic && trailingUser) {
    liveOptimisticKeyRef.current = trailingUser.id;
    turnKeyAliasRef.current.set(trailingUser.id, trailingUser.id);
  } else if (
    trailingUser &&
    showAwaitingReply &&
    liveOptimisticKeyRef.current &&
    !turnKeyAliasRef.current.has(trailingUser.id)
  ) {
    turnKeyAliasRef.current.set(
      trailingUser.id,
      liveOptimisticKeyRef.current,
    );
    liveOptimisticKeyRef.current = null;
  }
  // Not memoized: the alias map is a ref that the block above mutates.
  const turnKeys = turns.map((turn, index) =>
    resolveTurnKey(turn, index, turnKeyAliasRef.current),
  );
  lastTurnKeyRef.current = turnKeys[turnKeys.length - 1] ?? null;
  // Long threads mount only the turns near the viewport; short ones (and any
  // render without a window) keep every row.
  const windowed =
    typeof window !== "undefined" && turns.length > RENDER_ALL_THRESHOLD;
  windowedRef.current = windowed;
  const virtualization = useTurnWindow({
    containerRef: chatContainerRef,
    rowsRef,
    keys: turnKeys,
    estimate: (_key, index) => estimateTurnHeight(turns[index]!),
    enabled: windowed,
    modeRef: followModeRef,
    onProgrammaticScroll: markProgrammaticScroll,
    followEnd: () => followerRef.current?.follow(),
  });
  virtualizationRef.current = virtualization;
  // Find reads the message data, so it covers the turns that are not mounted.
  const findTurns = useMemo(
    () =>
      turns.map((turn, index) => ({
        key: resolveTurnKey(turn, index, turnKeyAliasRef.current),
        userMsg: turn.userMsg,
        // A Steer block's messages are found as themselves, in the order they were sent.
        assistantMsgs: turn.assistantMsgs.flatMap((message) => readSteerGroup(message) ?? [message]),
      })),
    [turns],
  );
  const find = useThreadFind({
    enabled: enableFind && typeof window !== "undefined",
    turns: findTurns,
    isStreaming,
    containerRef: chatContainerRef,
    rowsRef,
    virtualization,
    onNavigate: () => dispatchFollow({ type: "navigate" }),
    onProgrammaticScroll: markProgrammaticScroll,
  });
  // Find searches the reply's whole text, so while its bar is open nothing is held back.
  useEffect(() => (find.open ? holdReplyPacing() : undefined), [find.open]);
  const rowItems: RowItem[] = windowed
    ? windowRowItems(turns.length, virtualization.window)
    : turns.map((_, index) => ({ kind: "row", index }));
  const markerLayout = useMemo(
    () =>
      windowed
        ? {
            offsetOf: (id: string) =>
              virtualizationRef.current?.offsetOf(
                turnKeyAliasRef.current.get(id) ?? id,
              ),
            scrollTo: (id: string) =>
              void virtualizationRef.current?.scrollToKey(
                turnKeyAliasRef.current.get(id) ?? id,
                { align: "start", offset: 16 },
              ),
            subscribe: (listener: () => void) =>
              virtualizationRef.current?.subscribe(listener) ?? (() => {}),
          }
        : undefined,
    [windowed],
  );

  // `scrollToMessage` from elsewhere (search, the composer's approval cue): the transcript that has
  // the message takes the request, lands its turn, centres it and highlights it for a moment.
  const messageRequest = useChatNavigationStore((state) => state.message);
  useEffect(() => {
    if (!messageRequest) return;
    const { settleMessage } = useChatNavigationStore.getState();
    if (isStale(messageRequest)) {
      settleMessage(messageRequest.seq);
      return;
    }
    const { messageId } = messageRequest;
    const index = turns.findIndex(
      (turn) =>
        turn.userMsg?.id === messageId ||
        turn.assistantMsgs.some(
          (message) => message.id === messageId || Boolean(readSteerGroup(message)?.some((steered) => steered.id === messageId)),
        ),
    );
    const container = chatContainerRef.current;
    const rows = rowsRef.current;
    const virtualization = virtualizationRef.current;
    if (index < 0 || !container || !rows || !virtualization) return;
    settleMessage(messageRequest.seq);
    dispatchFollow({ type: "navigate" });
    const navigation = virtualization.beginNavigation();
    void revealMessage(
      { turnKey: resolveTurnKey(turns[index]!, index, turnKeyAliasRef.current), messageId },
      navigation,
      {
        container,
        rows,
        scrollToKey: windowed ? (key, target) => virtualization.scrollToKey(key, target, navigation) : undefined,
        onProgrammaticScroll: markProgrammaticScroll,
      },
    ).then((element) => {
      if (element) flashLocated(element);
    });
  }, [messageRequest, turns, windowed, dispatchFollow, markProgrammaticScroll]);

  const showPlanning = useMemo(() => {
    if (!isStreaming) return false;
    const lastMessage = normalizedMessages[normalizedMessages.length - 1];
    if (!lastMessage) return false;
    const lastTurn = turns[turns.length - 1];
    const hasAssistant = Boolean(lastTurn && lastTurn.assistantMsgs.length > 0);
    if (lastMessage.role === "user" && !hasAssistant) return true;
    return isStreaming && !getLastAssistantHasContent(normalizedMessages);
  }, [isStreaming, normalizedMessages, turns]);
  // A small, fixed gap under the reply in progress (REPLY_GAP_CLASS), so the
  // newest text sits about three lines above the composer, never a share of the
  // viewport. The last turn's toolbar takes its place when the reply ends; a
  // last turn without one (only tool calls, or stopped before any text) keeps
  // the gap, so the end of the reply moves nothing.
  const lastTurnHasToolbar = useMemo(() => {
    const last = turns[turns.length - 1];
    return Boolean(last && last.assistantMsgs.length > 0 && finishedTurnHasToolbar(last.assistantMsgs, showCopyToolbar));
  }, [turns, showCopyToolbar]);
  const showReplyGap =
    replyActive || showAwaitingReply || showPlanning || (turns.length > 0 && !lastTurnHasToolbar);

  // Instant, and corrected against the real DOM until it holds: a smooth
  // scroll outlives the programmatic window and fights the settle loop.
  const handleJumpToLatest = useCallback(() => {
    dispatchFollow({ type: "jump-to-latest" });
    void virtualizationRef.current?.settleToEnd();
  }, [dispatchFollow]);

  const showJumpButton = !isPinned && normalizedMessages.length > 0;
  // When the reply in progress started, as the work clock saw it (the clock is set in an effect).
  const liveStartedAt =
    lastUserMessageId != null && workClockRef.current?.turnId === lastUserMessageId
      ? workClockRef.current.startedAt
      : null;
  // Tick position and active-turn state live in PromptMarkersOverlay so
  // scrolling never re-renders the conversation to update the rail.

  return (
    <div
      className="an-message-list-wrap relative flex-1 min-h-0 flex flex-col"
      onMouseMove={handleGutterHover}
    >
    <div
      ref={containerRefCallback}
      onScroll={handleScroll}
      onWheel={cancelPromptScroll}
      onTouchMove={cancelPromptScroll}
      onPointerDown={cancelPromptScroll}
      data-windowed={windowed || undefined}
      className={cn(
        "an-message-list flex-1 min-h-0 overflow-y-auto overscroll-contain",
        className,
      )}
    >
      <div ref={contentWrapperRef} className="mx-auto px-6 py-6 max-w-an">
        <div ref={rowsRef} className="flex flex-col gap-6">
          {rowItems.map((item) => {
            // Spacers stand in for the turns outside the window. They are not
            // rendered at all when empty: in a `gap-6` column even a
            // zero-height element would add two gaps.
            if (item.kind !== "row") {
              return (
                <div
                  key={item.kind}
                  ref={
                    item.kind === "top-spacer"
                      ? virtualization.topSpacerRef
                      : virtualization.bottomSpacerRef
                  }
                  aria-hidden="true"
                  data-spacer
                />
              );
            }
            const turnIndex = item.index;
            const turn = turns[turnIndex]!;
            const isLastTurn = turnIndex === turns.length - 1;
            const turnKey = turnKeys[turnIndex]!;

            const userCopyKey = turn.userMsg ? `user-${turn.userMsg.id}` : null;
            const copyKey = `assistant-${turnKey}-all`;
            return (
              <TurnRow
                key={turnKey}
                turn={turn}
                turnKey={turnKey}
                rowRef={windowed ? virtualization.rowRef(turnKey) : undefined}
                isLastTurn={isLastTurn}
                replyActive={isLastTurn && replyActive}
                isStreaming={isLastTurn && isStreaming}
                showPlanning={isLastTurn && showPlanning}
                showAwaitingReply={isLastTurn && showAwaitingReply}
                lastTurnNotice={isLastTurn ? lastTurnNotice : undefined}
                liveStartedAt={isLastTurn ? liveStartedAt : null}
                settledMs={turn.userMsg ? settledWork[turn.userMsg.id] : undefined}
                copyActive={activeCopyId !== null && (activeCopyId === userCopyKey || activeCopyId === copyKey) ? activeCopyId : null}
                editingPromptId={turn.userMsg && editingPromptId === turn.userMsg.id ? editingPromptId : null}
                setEditingPromptId={setEditingPromptId}
                markCopied={markCopied}
                isMounted={isMounted}
                showCopyToolbar={showCopyToolbar}
                enableImagePreview={enableImagePreview}
                userMessageClassName={classNames?.userMessage}
                CustomUserMessage={CustomUserMessage}
                CustomToolRenderer={CustomToolRenderer}
                toolRenderers={toolRenderers}
                suppressQuestionTool={suppressQuestionTool}
                cardedSubagents={cardedSubagents}
                subagentCardIds={subagentCardIds}
              />
            );
          })}
        </div>
        {afterTurns != null && (
          // Clear of the last turn's toolbar, which reaches into the space below the rows.
          <div data-after-turns className="[&:not(:empty)]:mt-5">
            {afterTurns}
          </div>
        )}
        {showReplyGap && (
          <div aria-hidden="true" data-reply-gap className={cn(REPLY_GAP_CLASS, "w-full")} />
        )}
      </div>
      {/* The space a just-sent prompt's reply grows into; sized by the follower, 0 otherwise. */}
      <div ref={follower.reserveRef} aria-hidden="true" data-pin-reserve />
    </div>
    <PromptMarkersOverlay
      turns={turns}
      containerRef={chatContainerRef}
      contentRef={contentWrapperRef}
      visible={scrollbarActive}
      onActive={flashScrollbarActive}
      onUserNavigate={handleMarkerNavigateStart}
      markProgrammatic={markProgrammaticScroll}
      scrollAnimRef={promptScrollAnimRef}
      layout={markerLayout}
      onFind={find.openFind}
    />
    {find.barProps && placeFindBar(<FindInThreadBar {...find.barProps} />, findBarHost(chatContainerRef.current))}
    {/* Mounted while the thread has messages, so it fades both ways; hidden (and inert) while the view
        follows the end of the thread. */}
    {normalizedMessages.length > 0 && (
      <button
        type="button"
        onClick={handleJumpToLatest}
        data-find-ignore
        data-hidden={showJumpButton ? undefined : "true"}
        inert={!showJumpButton}
        aria-hidden={!showJumpButton || undefined}
        className="chat-jump absolute left-1/2 z-10 -translate-x-1/2"
      >
        {isStreaming && <span aria-hidden="true" className="chat-jump-live" />}
        <IconChevronDown className="chat-jump-icon" aria-hidden="true" />
        <span>Go to latest</span>
      </button>
    )}
    </div>
  );
});

type TurnRowProps = {
  turn: Turn;
  turnKey: string;
  rowRef?: (el: HTMLDivElement | null) => void;
  isLastTurn: boolean;
  /** The flags below describe the reply in progress; they are false on every turn but the last. */
  replyActive: boolean;
  isStreaming: boolean;
  showPlanning: boolean;
  showAwaitingReply: boolean;
  lastTurnNotice?: React.ReactNode;
  /** When the reply in progress started, as the work clock saw it; null when it did not see it start. */
  liveStartedAt: number | null;
  /** How long the turn worked, measured in this view when it ended here. */
  settledMs?: number;
  /** The copy key of this turn that was just copied, or null. */
  copyActive: string | null;
  /** This turn's prompt when it is open for editing, or null. */
  editingPromptId: string | null;
  setEditingPromptId: (id: string | null) => void;
  markCopied: (id: string) => void;
  isMounted: boolean;
  showCopyToolbar: boolean;
  enableImagePreview: boolean;
  userMessageClassName?: string;
  CustomUserMessage: React.ComponentType<React.ComponentProps<typeof UserMessage>>;
  CustomToolRenderer: React.ComponentType<ToolRendererProps>;
  toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
  suppressQuestionTool: boolean;
  cardedSubagents: Set<string>;
  subagentCardIds: Set<string>;
};

/**
 * One turn of the transcript. Memoised: a streamed delta changes only the last turn's messages, so
 * every other turn keeps its props and is not rendered again.
 */
const TurnRow = memo(function TurnRow({
  turn,
  turnKey,
  rowRef,
  isLastTurn,
  replyActive,
  isStreaming,
  showPlanning,
  showAwaitingReply,
  lastTurnNotice,
  liveStartedAt,
  settledMs,
  copyActive,
  editingPromptId,
  setEditingPromptId,
  markCopied,
  isMounted,
  showCopyToolbar,
  enableImagePreview,
  userMessageClassName,
  CustomUserMessage,
  CustomToolRenderer,
  toolRenderers,
  suppressQuestionTool,
  cardedSubagents,
  subagentCardIds,
}: TurnRowProps) {
  countRender("TurnRow");
  const turnActionsForEdit = useTurnActions();
  return (
    <div
      ref={rowRef}
      data-turn-key={turnKey}
      className="relative space-y-2"
    >
      {turn.userMsg &&
        (() => {
          // Subagent results delivered to this thread (a wake turn or a steer).
          const notice = readSubagentNotice(turn.userMsg);
          if (notice) {
            return (
              <div data-notice-id={turn.userMsg.id}>
                <SubagentNotice items={notice} />
              </div>
            );
          }
          const background = readBackgroundNotice(turn.userMsg);
          if (background) {
            return (
              <div data-notice-id={turn.userMsg.id}>
                <BackgroundNotice items={background} />
              </div>
            );
          }
          const text = getTextFromParts(
            turn.userMsg!.parts ?? [],
            "",
          );
          const hasParts = (turn.userMsg!.parts ?? []).length > 0;
          if (!text && !hasParts) return null;
          const userCreatedAt = (
            turn.userMsg as { createdAt?: Date | string }
          )?.createdAt;
          const userCopyKey = `user-${turn.userMsg.id}`;
          const userCopyVisible = copyActive === userCopyKey;
          const userTimestamp =
            isMounted && userCreatedAt
              ? formatTimestamp(new Date(userCreatedAt))
              : undefined;
          // Keep unavailable Undo visible with an explanation for this prompt.
          const showUserToolbar = true;
          // Edit and versions act on the prompt's turn; a fork's copies of its source name none.
          const promptTurnId = (turn.userMsg as { turnId?: string }).turnId;
          const editPrompt = turnActionsForEdit?.editPrompt;
          return (
            <div
              className="group/user-message"
              data-prompt-id={turn.userMsg.id}
            >
              {editingPromptId === turn.userMsg.id && promptTurnId && editPrompt ? (
                <PromptEditor
                  initial={text}
                  onCancel={() => setEditingPromptId(null)}
                  onSend={async (edited) => {
                    await editPrompt(turn.userMsg!.id, promptTurnId, edited);
                    setEditingPromptId(null);
                  }}
                />
              ) : (
              <CustomUserMessage
                message={turn.userMsg}
                className={userMessageClassName}
                enableImagePreview={enableImagePreview}
              />
              )}
              {/* An edited prompt says so, with its versions, whether or not the pointer is over it. */}
              {promptTurnId && editingPromptId !== turn.userMsg.id && (
                <PromptVersionSwitcher turnId={promptTurnId} />
              )}
              {showUserToolbar && editingPromptId !== turn.userMsg.id && (
                <MessageToolbar
                  text={showCopyToolbar ? text : ""}
                  timestamp={userTimestamp}
                  heightClass="h-[28px]"
                  hoverClass="group-hover/user-message:opacity-100 group-hover/user-message:pointer-events-auto"
                  isVisible={userCopyVisible}
                  alignClass="justify-end"
                  onCopied={() => markCopied(userCopyKey)}
                  undoMessageId={turn.userMsg.id}
                  promptTurnId={promptTurnId}
                  onEdit={promptTurnId && editPrompt ? () => setEditingPromptId(turn.userMsg!.id) : undefined}
                  speechKey={userCopyKey}
                  repeatText={text}
                />
              )}
            </div>
          );
        })()}

      {turn.userMsg && lastTurnNotice}

      {turn.assistantMsgs.length > 0 &&
        !(isLastTurn && showPlanning) &&
        (() => {
          const assistantText = getTextFromParts(
            turn.assistantMsgs.flatMap((msg) => msg.parts ?? []),
            "\n\n",
          );
          const isTurnStreaming = replyActive && isLastTurn;
          // A turn can span several assistant rows (text + tool
          // results); surface the latest completed-response
          // metadata so the popup reflects the visible reply.
          const turnMetadata = (() => {
            for (let m = turn.assistantMsgs.length - 1; m >= 0; m -= 1) {
              const meta = getResponseMetadata(turn.assistantMsgs[m]!);
              if (meta) return meta;
            }
            return undefined;
          })();
          // Only reserve toolbar height when there's actually
          // something to show in it. With showCopyToolbar=false the
          // toolbar would otherwise render as a 48px-tall empty box,
          // creating large gaps between assistant turns.
          const showToolbar =
            !isTurnStreaming &&
            finishedTurnHasToolbar(turn.assistantMsgs, showCopyToolbar);
          const copyKey = `assistant-${turnKey}-all`;
          const toolbarText = showCopyToolbar ? assistantText : "";
          // Read aloud reads the answer, not the notes the agent wrote while it worked.
          const speechText = turnAnswerText(turn.assistantMsgs);
          // A finished turn of this thread can be forked from; a fork's copies of its source name no turn.
          const forkTurnId = isTurnStreaming ? undefined : (turn.userMsg as { turnId?: string } | undefined)?.turnId;

          const workedMs = isTurnStreaming
            ? null
            : settledMs ?? turnDurationMs(turn.userMsg, turn.assistantMsgs);
          const liveStart = liveStartedAt ?? readCreatedAt(turn.userMsg);

          return (
            <div className="group/assistant-turn">
              <TurnWorkStatus
                active={isTurnStreaming}
                startedAt={isTurnStreaming ? liveStart : null}
                durationMs={workedMs}
                waitingLabel={
                  isTurnStreaming &&
                  turn.assistantMsgs.some(isWaitingPermissionRequest)
                    ? "Waiting for approval"
                    : undefined
                }
              />
              <div className="turn-answer flex flex-col gap-3">
                <TurnIdContext.Provider value={(turn.userMsg as { turnId?: string } | undefined)?.turnId}>
                {(() => {
                  // Consecutive thoughts and tool calls collapse into one
                  // group titled with the latest thought. A run with
                  // no thought falls back to "Tool calls N".
                  // Subagent results whose subagents have a card in
                  // the thread show there, as the card's state: the
                  // results add no line of their own.
                  // A thought with anything after it in the turn is done (the provider closes it only later).
                  const turnMsgs = settleEarlierThoughts(turn.assistantMsgs.flatMap((msg) => {
                    const background = readBackgroundNotice(msg);
                    if (background) {
                      const rest = background.filter((item) => !cardedSubagents.has(item.taskId));
                      if (rest.length === 0) return [];
                      return [{ ...msg, metadata: { ...(msg.metadata as object | undefined), backgroundNotice: rest } }];
                    }
                    const notice = readSubagentNotice(msg);
                    if (!notice) return [msg];
                    const rest = notice.filter(
                      (item) => !cardedSubagents.has(item.delegationId) && !cardedSubagents.has(item.childThreadId),
                    );
                    if (rest.length === 0) return [];
                    return [{ ...msg, metadata: { ...(msg.metadata as object | undefined), subagentNotice: rest } }];
                  }));
                  const turnAnalyses = turnMsgs.map((msg) =>
                    analyzeAssistantMessage(
                      msg.parts ?? [],
                      suppressQuestionTool,
                      subagentCardIds,
                    ),
                  );
                  // A finished turn ends on its answer: the notes and
                  // activity that led to it collapse above it.
                  const settled = isTurnStreaming
                    ? { order: turnMsgs.map((_, index) => index), analyses: turnAnalyses }
                    : settleFinishedTurn(turnMsgs, turnAnalyses);
                  const answerMsgs = settled.order.map((index) => turnMsgs[index]!);
                  const analyses = settled.order.map((index) => settled.analyses[index]!);
                  const segments = partitionTurnSegments(
                    analyses.map((a) => a.toolsOnly),
                    analyses.map((a) => a.cardsOnly),
                  );
                  return segments.map((segment) => {
                    if (segment.kind === "cards") {
                      const cardParts = segment.msgIndices.flatMap(
                        (msgIndex) => analyses[msgIndex]!.cardParts,
                      );
                      const cardNested = new Map(
                        segment.msgIndices.flatMap((msgIndex) => [
                          ...(analyses[msgIndex]!.cardNestedTools ?? new Map()),
                        ]),
                      );
                      const chatStreamingStatus = isLastTurn && isStreaming
                        ? "streaming"
                        : undefined;
                      return (
                        <SubagentCardGroup
                          key={`${answerMsgs[segment.msgIndices[0]!]!.id}-subagents`}
                          toolCallIds={cardParts.map(
                            (part) => part.toolCallId!,
                          )}
                        >
                          {cardParts.map((part) => (
                            <CustomToolRenderer
                              key={part.toolCallId}
                              part={part}
                              nestedTools={cardNested.get(part.toolCallId!)}
                              chatStatus={chatStreamingStatus}
                              toolRenderers={toolRenderers}
                            />
                          ))}
                        </SubagentCardGroup>
                      );
                    }
                    if (segment.kind === "message") {
                      const msg =
                        answerMsgs[segment.msgIndex]!;
                      const steeredGroup = readSteerGroup(msg);
                      if (steeredGroup) {
                        return (
                          <SteerGroup
                            key={msg.id}
                            messages={steeredGroup}
                            UserMessageComponent={CustomUserMessage}
                            className={userMessageClassName}
                            enableImagePreview={enableImagePreview}
                          />
                        );
                      }
                      const notice = readSubagentNotice(msg);
                      if (notice) {
                        return (
                          <div key={msg.id} data-notice-id={msg.id}>
                            <SubagentNotice items={notice} />
                          </div>
                        );
                      }
                      const background = readBackgroundNotice(msg);
                      if (background) {
                        return (
                          <div key={msg.id} data-notice-id={msg.id}>
                            <BackgroundNotice items={background} />
                          </div>
                        );
                      }
                      const isLastMsg =
                        isLastTurn &&
                        segment.msgIndex ===
                          answerMsgs.length - 1;
                      return (
                        <AssistantParts
                          key={msg.id}
                          msg={msg}
                          isLast={isLastMsg}
                          isStreaming={isLastMsg && isStreaming}
                          retryPromptId={
                            isLastTurn && !isStreaming
                              ? turn.userMsg?.id
                              : undefined
                          }
                          suppressQuestionTool={suppressQuestionTool}
                          ToolRendererComponent={CustomToolRenderer}
                          toolRenderers={toolRenderers}
                        />
                      );
                    }
                    const items = segment.msgIndices.flatMap(
                      (msgIndex) =>
                        analyses[msgIndex]!.toolItems,
                    );
                    // A thought still being written ends the group: its header is the turn's live line.
                    const liveThought = isLastTurn && isStreaming ? liveGroupThought(items) : undefined;
                    const groupLabel = liveThought !== undefined ? "Thinking" : activityGroupLabel(items);
                    const firstId =
                      answerMsgs[
                        segment.msgIndices[0]!
                      ]!.id;
                    const chatStreamingStatus = isLastTurn && isStreaming
                      ? "streaming"
                      : undefined;
                    // Only shimmer the group header while a child
                    // tool is still running — not for the whole
                    // remaining turn stream (text after tools).
                    const anyToolPending = items.some((item) => {
                      const state = item.part.state;
                      return (
                        state !== "output-available" &&
                        state !== "output-error"
                      );
                    });
                    return (
                      <ToolCallsGroup
                        key={`${firstId}-toolcalls`}
                        count={items.length}
                        icon={
                          groupLabel ? (
                            <ThinkingIcon size={18} active={anyToolPending && isLastTurn && isStreaming} />
                          ) : (
                            <Wrench size={18} />
                          )
                        }
                        label={groupLabel}
                        liveThought={liveThought}
                        autoOpen={anyToolPending}
                        failed={
                          items.filter(
                            (item) =>
                              getToolStatus(item.part).isError,
                          ).length
                        }
                        live={isLastTurn && isStreaming}
                      >
                        {items.map((item, k) => (
                          <CustomToolRenderer
                            key={
                              item.part.toolCallId ??
                              `${firstId}-tool-${k}`
                            }
                            part={item.part}
                            nestedTools={item.nestedTools}
                            chatStatus={chatStreamingStatus}
                            toolRenderers={toolRenderers}
                          />
                        ))}
                      </ToolCallsGroup>
                    );
                  });
                })()}
                </TurnIdContext.Provider>
                {isTurnStreaming && (
                  <TurnProgressRow messages={turn.assistantMsgs} awaitingSubagents={!isStreaming} />
                )}
              </div>
              {!isTurnStreaming && (
                <TurnEditSummary messages={turn.assistantMsgs} turnId={(turn.userMsg as { turnId?: string } | undefined)?.turnId} />
              )}
              {showToolbar ? (
                <MessageToolbar
                  text={toolbarText}
                  heightClass={isLastTurn ? LAST_TURN_TOOLBAR_CLASS : TURN_TOOLBAR_CLASS}
                  hoverClass="group-hover/assistant-turn:opacity-100 group-hover/assistant-turn:pointer-events-auto"
                  isVisible={copyActive === copyKey}
                  alignClass="justify-start"
                  onCopied={() => markCopied(copyKey)}
                  metadata={turnMetadata}
                  speechKey={copyKey}
                  speechText={speechText}
                  forkTurnId={forkTurnId}
                />
              ) : copyActive === copyKey ? (
                <MessageToolbar
                  text={toolbarText}
                  heightClass={isLastTurn ? LAST_TURN_TOOLBAR_CLASS : TURN_TOOLBAR_CLASS}
                  hoverClass="group-hover/assistant-turn:opacity-100 group-hover/assistant-turn:pointer-events-auto"
                  isVisible={true}
                  alignClass="justify-start"
                  onCopied={() => markCopied(copyKey)}
                  metadata={turnMetadata}
                  speechKey={copyKey}
                  speechText={speechText}
                  forkTurnId={forkTurnId}
                />
              ) : null}
            </div>
          );
        })()}

      {isLastTurn && (showAwaitingReply || showPlanning) && (
        // Laid out like the turn's answer below, so its first row
        // takes the live row's place without moving.
        <div className="group/assistant-turn">
          <TurnWorkStatus
            active
            startedAt={liveStartedAt ?? readCreatedAt(turn.userMsg)}
            durationMs={null}
          />
          <div className="turn-answer flex flex-col gap-3">
            <TurnProgressRow messages={turn.assistantMsgs} standalone />
          </div>
        </div>
      )}
    </div>
  );
});

type HandoffSelection = { provider: string; model: string };
type HandoffMarker = {
  from: HandoffSelection;
  to: HandoffSelection;
  strategy?: string;
  transfer?: "fork" | "merge_back";
};

/**
 * What a handoff marker says happened: a thread transfer names its source ("Forked from Draft"),
 * a switch that rebuilt the context for the new model is a context handoff, any other switch a
 * plain model change.
 */
function handoffStatus(handoff: HandoffMarker, text: string): string {
  if (handoff.transfer) return text || (handoff.transfer === "fork" ? "Forked" : "Merged back");
  return handoff.strategy && handoff.strategy !== "native_resume" ? "Context handoff" : "Model changed";
}

/**
 * "Model changed / Claude Opus 4.5 · High → GPT-5": a model switch in the transcript, by the names
 * the instances list, under a line saying what happened.
 */
/** Where `/clear` started the model context again: a quiet rule across the thread with its label. */
function ContextClearedDivider({ text }: { text: string }) {
  return <div role="separator" aria-label={text} className="context-cleared">
    <span aria-hidden="true" className="context-cleared-rule" />
    <span>{text}</span>
    <span aria-hidden="true" className="context-cleared-rule" />
  </div>;
}

function ContextHandoffMarker({ handoff, text }: { handoff: HandoffMarker; text: string }) {
  // Names come from the provider snapshots: show them once those arrive.
  useProviderSnapshotsStore((state) => state.scopes);
  const iconId = (selection: HandoffSelection) => {
    const brand = inferModelBrand(selection.model, undefined, selection.provider).brandId;
    // An unknown model falls back to its provider's id, which ProviderIcon maps to the vendor logo.
    return brand === 'anthropic' ? 'claude' : brand;
  };
  const status = handoffStatus(handoff, text);
  const from = modelLabel(resolveModelChoice(handoff.from));
  const to = modelLabel(resolveModelChoice(handoff.to));
  // A transfer that kept the model names it once.
  const sameModel = handoff.from.provider === handoff.to.provider && handoff.from.model === handoff.to.model;
  return <div role="status" aria-label={sameModel ? `${status}: ${to}` : `${status}: ${from} to ${to}`}
    className="flex w-full flex-col items-center gap-1 py-1.5 text-xs text-muted-foreground">
    <span className="text-[11px] opacity-70">{status}</span>
    <span className="flex items-center gap-2">
      {!sameModel && <>
        <span className="inline-flex items-center gap-1.5" title={handoff.from.model}><ProviderIcon providerId={iconId(handoff.from)} size={14} />{from}</span>
        <span aria-hidden="true">→</span>
      </>}
      <span className="inline-flex items-center gap-1.5" title={handoff.to.model}><ProviderIcon providerId={iconId(handoff.to)} size={14} />{to}</span>
    </span>
  </div>;
}

type CompactionMetadata = { compaction?: boolean; compacting?: boolean; compactionManual?: boolean; compactionKept?: "stopped" | "failed" | "interrupted" };

/**
 * A compaction in the transcript: a spinner while it runs (with Stop when a person started it), then what it
 * did ("Context compacted · 182K → 9K"), or that it ended with the full history kept.
 */
function CompactionRow({ text, metadata }: { text: string; metadata: CompactionMetadata }) {
  const actions = useTurnActions();
  const compacting = metadata.compacting === true;
  const stop = compacting && metadata.compactionManual ? actions?.stopCompaction : undefined;
  return <div role="status"><ToolRowBase
    icon={compacting ? <SpiralLoader size={12} /> : metadata.compactionKept ? <History size={14} /> : <ArrowShrink size={14} />}
    shimmerLabel="Compacting context…"
    completeLabel={text || "Context compacted"}
    isAnimating={compacting}
    trailingContent={stop ? (
      <button type="button" className="an-compaction-stop" title="Stop compacting" aria-label="Stop compacting" onClick={stop}>
        <Square size={10} strokeWidth={2} fill="currentColor" />
      </button>
    ) : undefined}
  /></div>;
}

const AssistantParts = memo(function AssistantParts({
  msg,
  isLast,
  isStreaming,
  retryPromptId,
  suppressQuestionTool,
  ToolRendererComponent,
  toolRenderers,
}: {
  msg: UIMessage;
  isLast: boolean;
  isStreaming: boolean;
  /** The last turn's prompt, offered for Retry beside an error. Absent on earlier turns. */
  retryPromptId?: string;
  suppressQuestionTool: boolean;
  ToolRendererComponent: React.ComponentType<ToolRendererProps>;
  toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
}) {
  countRender("AssistantParts");
  const parts = useMemo(
    () => normalizeAssistantToolParts(msg.parts ?? []) as unknown[],
    [msg.parts],
  );
  const turnActions = useTurnActions();
  const retryTitle =
    retryPromptId && turnActions ? turnActions.retryTitle(retryPromptId) : null;
  const retry = retryPromptId && turnActions ? turnActions.retry : undefined;

  const { elements } = useMemo(() => {
    const elems: React.ReactNode[] = [];
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

    let i = 0;
    while (i < parts.length) {
      const part = parts[i]!;

      if (isV5ToolPart(part) && part.type === "tool-TaskOutput") {
        i++;
        continue;
      }

      if (isRecord(part) && part.type === "data-applet-pending") {
        elems.push(<section className="mousse-applet mousse-applet-pending" key={`${msg.id}-applet-pending-${i}`} role="status" aria-label="Generating applet"><span className="mousse-applet-name">Generating applet…</span></section>);
        i++;
        continue;
      }
      if (isAppletPart(part)) {
        elems.push(<AppletCard key={`${msg.id}-applet-${part.data.revisionId}`} reference={part.data} />);
        i++;
        continue;
      }
      if (isPermissionRequestPart(part)) {
        elems.push(<PermissionRequestRow key={`${msg.id}-permission`} data={part.data} />);
        i++;
        continue;
      }

      if (isTextPart(part)) {
        const text = part.text;
        if (text) {
          elems.push(
            <div
              key={`${msg.id}-text-${i}`}
              className="group/assistant-text text-[16px]"
              data-find-text
              data-message-id={msg.id}
              data-part-index={i}
            >
              <PacedMarkdown
                content={text}
                className="leading-relaxed [&_p]:leading-relaxed"
                streaming={isLast && isStreaming}
                // Text followed by a tool call or more text is finished: it shows whole.
                paced={isLast && isStreaming && !parts.slice(i + 1).some((later) => isTextPart(later) || isV5ToolPart(later))}
              />
            </div>,
          );
        }
        i++;
        continue;
      }

      if (isErrorPart(part)) {
        elems.push(
          <ErrorMessage
            key={`${msg.id}-error-${i}`}
            title={part.title}
            message={part.message}
            onRetry={
              retry && retryPromptId && retryTitle !== null
                ? () => retry(retryPromptId)
                : undefined
            }
            retryTitle={retryTitle ?? undefined}
          />,
        );
        i++;
        continue;
      }

      if (isV5ToolPart(part)) {
        if (suppressQuestionTool && part.type === "tool-Question") {
          i++;
          continue;
        }
        if (part.toolCallId && nestedToolIds.has(part.toolCallId)) {
          i++;
          continue;
        }

        const chatStreamingStatus =
          isLast && isStreaming ? "streaming" : undefined;
        const toolCallId = part.toolCallId;
        const nestedTools =
          (part.type === "tool-Task" || part.type === "tool-Agent") &&
          toolCallId
            ? nestedToolsMap.get(toolCallId) || []
            : undefined;
        elems.push(
          <ToolRendererComponent
            key={part.toolCallId ?? `${msg.id}-tool-${i}`}
            part={part}
            nestedTools={nestedTools}
            chatStatus={chatStreamingStatus}
            toolRenderers={toolRenderers}
          />,
        );
        i++;
        continue;
      }

      i++;
    }

    return { elements: elems };
  }, [
    parts,
    msg.id,
    isLast,
    isStreaming,
    retryPromptId,
    retry,
    retryTitle,
    suppressQuestionTool,
    ToolRendererComponent,
    toolRenderers,
  ]);

  if (isThreadNotice(msg)) return <ThreadNotice text={parts.filter(isTextPart).map((part) => part.text).join('')} />;
  const handoff = (msg.metadata as { contextHandoff?: HandoffMarker } | undefined)?.contextHandoff;
  if (handoff) return <ContextHandoffMarker handoff={handoff} text={parts.filter(isTextPart).map((part) => part.text).join('')} />;
  if ((msg.metadata as { contextCleared?: boolean } | undefined)?.contextCleared)
    return <ContextClearedDivider text={parts.filter(isTextPart).map((part) => part.text).join('') || 'Context cleared'} />;
  const compactionMetadata = msg.metadata as CompactionMetadata | undefined;
  if (compactionMetadata?.compaction) {
    const text = parts.filter(isTextPart).map((part) => part.text).join('');
    return <CompactionRow text={text} metadata={compactionMetadata} />;
  }
  // A scheduled job's result appended here links to the thread where its turn ran.
  const scheduledRun = (msg.metadata as { scheduledRun?: { threadId?: unknown } } | undefined)?.scheduledRun;
  if (typeof scheduledRun?.threadId === "string") {
    const runThreadId = scheduledRun.threadId;
    return (
      <div className="group/assistant-turn flex flex-col gap-3">
        {elements}
        <button
          type="button"
          className="an-md-link self-start text-sm hover:underline underline-offset-2 text-an-primary-color"
          onClick={() => void openThread(runThreadId)}
        >
          Open the scheduled run
        </button>
      </div>
    );
  }
  if (elements.length > 1) {
    return (
      <div className="group/assistant-turn flex flex-col gap-3">{elements}</div>
    );
  }

  return <div className="group/assistant-turn">{elements}</div>;
});
