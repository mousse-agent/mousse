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
import { ProviderIcon } from "../../../lib/providerIcons";
import { inferModelBrand } from "../../../../shared/modelVariants";
import { modelDisplayName, useProviderSnapshotsStore } from "../../../lib/providerSnapshots";

import { UserMessage } from "./user-message";
import { AppletCard, isAppletPart } from "../../../components/applets/AppletCard";
import { Markdown } from "./markdown";
import { ErrorMessage } from "./error-message";
import type { CustomToolRendererProps } from "./types";
import { ToolRowBase } from "./tools/tool-row-base";
import { Brain, IconArrowDown, IconCopy, IconCheck, IconInfoCircle, IconX, Wrench } from "../../../lib/icons";
import {
  formatResponseTime,
  formatTokens,
  formatTokensPerSecond,
} from "../../../utils/assistantMessageActions";
import { ToolRenderer as DefaultToolRenderer } from "./tools/tool-renderer";
import { ToolCallsGroup } from "./tools/tool-calls-group";
import { SubagentCardGroup } from "./tools/SubagentCard";
import { SubagentNotice } from "./tools/SubagentNotice";
import { useSubagentCards } from "./tools/subagent-cards-context";
import { readSubagentNotice } from "../../adapters/subagentNotice";
import { openThread } from "../../../lib/openThread";
import { normalizeAssistantToolParts } from "./utils/tool-part-normalizer";
import {
  activityGroupLabel,
  analyzeAssistantMessage,
  isErrorPart,
  isRecord,
  isTextPart,
  isV5ToolPart,
  partitionTurnSegments,
  type ToolPartBase,
} from "./utils/assistant-blocks";
import { PromptUndoButton } from "../../../components/PromptUndoControls";
import { TurnEditSummary } from "./turn-edit-summary";
import { SpiralLoader } from "./spiral-loader";
import { ReadAloudButton, useIsReadingAloud } from "../../../readAloud/ReadAloudButton";
import { useVisiblePromptIds } from "./use-visible-prompt-ids";
import {
  classifyIntent,
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
import { FindInThreadBar } from "./find/FindInThreadBar";
import { useThreadFind } from "./find/use-thread-find";
import "../../../styles/prompt-visibility.css";

export type MessageListProps = {
  messages: UIMessage[];
  status: ChatStatus;
  className?: string;
  onAtBottomChange?: (atBottom: boolean) => void;
  lastTurnNotice?: React.ReactNode;
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
      return isV5ToolPart(part) || isAppletPart(part);
    });
  }
  return false;
}

function getLastUserMessageId(messages: UIMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg?.role === "user") return msg.id;
  }
  return null;
}

function readCreatedAt(message: UIMessage | undefined): number | null {
  const raw = (message as { createdAt?: Date | string } | undefined)?.createdAt;
  if (!raw) return null;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

function durationParts(milliseconds: number): {
  hours: number;
  minutes: number;
  seconds: number;
} {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return {
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** Live label while a turn is still running. Seconds tick every second. */
function formatWorkingFor(milliseconds: number): string {
  const { hours, minutes, seconds } = durationParts(milliseconds);
  if (hours > 0) {
    return `Working for ${countLabel(hours, "hour")}, ${countLabel(minutes, "minute")}, and ${countLabel(seconds, "second")}`;
  }
  if (minutes > 0) {
    return `Working for ${countLabel(minutes, "minute")} and ${countLabel(seconds, "second")}`;
  }
  return `Working for ${countLabel(seconds, "second")}`;
}

/** Compact "Worked for 2m 6s" from a finished turn. Under a minute stays in seconds. */
function formatWorkedFor(milliseconds: number): string {
  const { hours, minutes, seconds } = durationParts(milliseconds);
  if (hours > 0) {
    const parts = [`${hours}h`];
    if (minutes) parts.push(`${minutes}m`);
    if (seconds) parts.push(`${seconds}s`);
    return `Worked for ${parts.join(" ")}`;
  }
  if (minutes > 0) {
    return seconds
      ? `Worked for ${minutes}m ${seconds}s`
      : `Worked for ${minutes}m`;
  }
  return `Worked for ${seconds}s`;
}

function turnDurationMs(
  user: UIMessage | undefined,
  assistants: UIMessage[],
): number | null {
  const start = readCreatedAt(user);
  if (start == null) return null;
  let end = start;
  for (const message of assistants) {
    const at = readCreatedAt(message);
    if (at != null && at > end) end = at;
  }
  return Math.max(0, end - start);
}

function TurnWorkStatus({
  active,
  startedAt,
  durationMs,
}: {
  active: boolean;
  startedAt?: number | null;
  durationMs: number | null;
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
    elapsedMs == null
      ? null
      : active
        ? formatWorkingFor(elapsedMs)
        : formatWorkedFor(elapsedMs);
  if (!label) return null;
  return (
    <div className="turn-work" data-find-ignore>
      <div className="turn-work-label">{label}</div>
      <div className="turn-work-rule" aria-hidden="true" />
    </div>
  );
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
    navigator.clipboard.writeText(text);
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
    <button
      type="button"
      tabIndex={-1}
      onClick={handleCopy}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onMouseDown={(event) => event.stopPropagation()}
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
  );
}

/** LLM details carried on UIMessage.metadata via mousseToUIMessages(). */
export type ResponseMetadata = {
  modelName?: string;
  totalResponseTimeMs?: number;
  tokensUsed?: number;
  tokensPerSecond?: number;
};

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
        tabIndex={-1}
        onClick={() => setOpen((value) => !value)}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        title="Response metadata"
        aria-label="Response metadata"
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
              tabIndex={-1}
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
                {metadata.modelName ?? "Unavailable"}
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
  metadata,
  speechKey,
}: {
  text?: string;
  timestamp?: string;
  heightClass: string;
  hoverClass: string;
  isVisible: boolean;
  alignClass: string;
  onCopied?: () => void;
  undoMessageId?: string;
  metadata?: ResponseMetadata;
  /** Identifies the message for read aloud; the button shows only with text. */
  speechKey?: string;
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
        "relative flex items-center gap-1 pt-1 text-sm text-an-foreground-muted/70 opacity-0 transition-opacity duration-100 pointer-events-none",
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
      {text && speechKey && <ReadAloudButton speechKey={speechKey} markdown={text} />}
      {text && <CopyButton text={text} onCopied={onCopied} />}
      {metadata && (
        <span onPointerDown={(event) => event.stopPropagation()}>
          <MetadataButton metadata={metadata} onOpenChange={setMetadataOpen} />
        </span>
      )}
    </div>
  );
}

/** Group flat messages into turns (user message + following assistant messages) */
function groupMessagesIntoTurns(messages: UIMessage[]) {  const turns: { userMsg?: UIMessage; assistantMsgs: UIMessage[] }[] = [];
  let current: { userMsg?: UIMessage; assistantMsgs: UIMessage[] } | null =
    null;

  for (const msg of messages) {
    if (msg.role === "user") {
      if (current) turns.push(current);
      current = { userMsg: msg, assistantMsgs: [] };
    } else if (msg.role === "assistant") {
      if (!current) current = { assistantMsgs: [] };
      current.assistantMsgs.push(msg);
    }
  }
  if (current) turns.push(current);
  return turns;
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

function cappedWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, limit).join(" ") + (words.length > limit ? "…" : "");
}

/**
 * Conversation ticks. Deliberately isolated with its own state: position
 * recomputes (ResizeObserver + streaming + expand/collapse) must never
 * re-render the message list — that was the expand/collapse stutter whenever
 * the markers were visible. Marker updates only re-render this tiny overlay.
 */
export const PromptMarkersOverlay = memo(function PromptMarkersOverlay({
  messages,
  containerRef,
  contentRef,
  visible,
  onActive,
  onUserNavigate,
  markProgrammatic,
  scrollAnimRef,
  layout,
}: {
  messages: UIMessage[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  onActive: () => void;
  onUserNavigate: () => void;
  markProgrammatic: () => void;
  scrollAnimRef: React.MutableRefObject<number>;
  /** Set while the list is windowed; without it every prompt is read from the DOM. */
  layout?: PromptMarkerLayout;
}) {
  const [markers, setMarkers] = useState<PromptMarker[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [previewId, setPreviewId] = useState<string>();
  const markerPositionsRef = useRef<PromptMarker[]>([]);
  const markerOffsetsRef = useRef<number[]>([]);
  const rafRef = useRef(0);
  const loggedCountRef = useRef(-1);

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
    rafRef.current = requestAnimationFrame(() => {
      const container = containerRef.current;
      const content = contentRef.current;
      if (!container || !content) return;
      const scrollHeight = container.scrollHeight;
      if (!scrollHeight) return;
      const escapeId =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? (id: string) => CSS.escape(id)
          : (id: string) => id.replace(/["\\]/g, "\\$&");
      const next: PromptMarker[] = [];
      const containerRect = container.getBoundingClientRect();
      for (const turn of groupMessagesIntoTurns(normalizeMessages(messages))) {
        const userMsg = turn.userMsg;
        // A message that delivers subagent results is not a prompt the user wrote.
        if (!userMsg || readSubagentNotice(userMsg)) continue;
        const target: Element | null = layout
          ? null
          : content.querySelector(`[data-prompt-id="${escapeId(userMsg.id)}"]`);
        // Rect-based so nested `relative` wrappers / transforms can't skew it.
        const y = layout
          ? layout.offsetOf(userMsg.id) ?? Infinity
          : target instanceof HTMLElement
            ? target.getBoundingClientRect().top - containerRect.top + container.scrollTop
            : markerPositionsRef.current.find((marker) => marker.id === userMsg.id)?.offset ?? Infinity;
        const preview = cappedWords(getTextFromParts(userMsg.parts ?? [], " "), 10);
        const responsePreview = cappedWords(
          turn.assistantMsgs.map((message) => getTextFromParts(message.parts ?? [], " ")).join(" "),
          24,
        );
        next.push({
          id: userMsg.id,
          offset: y,
          preview: preview || "Your prompt",
          responsePreview: responsePreview || "No response yet",
        });
      }
      if (loggedCountRef.current !== next.length) {
        loggedCountRef.current = next.length;
        // eslint-disable-next-line no-console
        console.debug(`[prompt-markers] tracking ${next.length} prompts`);
      }
      markerPositionsRef.current = next;
      markerOffsetsRef.current = next.map((marker) => marker.offset);
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
  }, [messages, containerRef, contentRef, updateActiveMarker, layout]);
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
    const observer = new ResizeObserver(() => updateMarkers());
    observer.observe(content);
    observer.observe(container);
    window.addEventListener("resize", updateMarkers);
    return () => {
      observer.disconnect();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", updateMarkers);
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
      const reduceMotion =
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) {
        container.scrollTop = targetTop;
        return;
      }
      // Custom eased glide — native smooth scroll is janky over long
      // distances. Distance-based duration keeps short hops snappy.
      const duration = Math.min(900, 320 + Math.abs(distance) * 0.22);
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

  if (markers.length === 0) return null;
  const previewMarker = markers.find((marker) => marker.id === previewId);
  const highlightedIndex = markers.findIndex((marker) => marker.id === previewId);

  return (
    <div
      data-testid="prompt-markers"
      data-find-ignore
      className={cn("chat-prompt-rail", visible && "is-active", previewId && "is-previewing")}
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
  onAtBottomChange,
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
  const lastMessageIdRef = useRef<string | null>(
    messages[messages.length - 1]?.id ?? null,
  );
  const assistantSpaceActiveRef = useRef(false);
  const [activeCopyId, setActiveCopyId] = useState<string | null>(null);
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

  const dispatchFollow = useCallback((event: FollowEvent) => {
    const next = reduceFollow(followModeRef.current, event);
    followModeRef.current = next;
    setIsPinned(next === "following-end");
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

  const scrollToBottomInstant = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    markProgrammaticScroll();
    container.scrollTop = container.scrollHeight;
  }, [markProgrammaticScroll]);

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
    dispatchFollow({ type: "intent", intent });
  };

  const handleScroll = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const programmatic = isProgrammaticScroll();
    dispatchFollow({ type: "scroll", atBottom: isAtBottom(), programmatic });
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

    let lastContentHeight = contentWrapper.getBoundingClientRect().height;
    let raf = 0;

    const resizeObserver = new ResizeObserver(() => {
      if (windowedRef.current) {
        // Windowed: the rows are anchored by `useTurnWindow`. This observer
        // only follows growth outside them (the breathing space below the
        // last turn), before paint and never by a delta.
        if (followModeRef.current === "following-end") {
          programmaticScrollAtRef.current = performance.now();
          container.scrollTop = container.scrollHeight - container.clientHeight;
        }
        return;
      }
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const newContentHeight = contentWrapper.getBoundingClientRect().height;
        if (newContentHeight === lastContentHeight) {
          return;
        }
        lastContentHeight = newContentHeight;

        if (followModeRef.current === "following-end") {
          // Following: track streaming text / images / expanding tool cards.
          programmaticScrollAtRef.current = performance.now();
          container.scrollTop = container.scrollHeight;
        }
        // When reading history (free): leave scrollTop untouched.
        // New streamed content appends below the viewport, so keeping
        // scrollTop stable keeps what the user is reading stable.
        // Growth above the viewport is handled by native CSS
        // scroll-anchoring (overflow-anchor) — a manual delta here would
        // push the viewport down on every streamed token.
      });
    });

    resizeObserver.observe(contentWrapper);
    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
    };
  }, []);

  const normalizedMessages = useMemo(
    () => normalizeMessages(messages),
    [messages],
  );
  const lastMessage = normalizedMessages[normalizedMessages.length - 1];
  const lastMessageId = lastMessage?.id ?? null;
  const lastMessageRole = lastMessage?.role ?? null;
  const lastUserMessageId = useMemo(
    () => getLastUserMessageId(normalizedMessages),
    [normalizedMessages],
  );

  useEffect(() => {
    const turnId = lastUserMessageId;
    if (!turnId) return;
    if (isStreaming) {
      if (workClockRef.current?.turnId !== turnId) {
        const user = normalizedMessages.find((message) => message.id === turnId);
        workClockRef.current = {
          turnId,
          startedAt: readCreatedAt(user) ?? Date.now(),
          endedAt: null,
        };
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
  }, [isStreaming, lastUserMessageId, normalizedMessages]);

  const lastUserMessageIdRef = useRef(lastUserMessageId);
  useLayoutEffect(() => {
    if (
      lastUserMessageId &&
      lastUserMessageId !== lastUserMessageIdRef.current
    ) {
      dispatchFollow({ type: "new-turn" });
      void virtualizationRef.current?.settleToEnd();
      lastUserMessageIdRef.current = lastUserMessageId;
    }
  }, [lastUserMessageId, dispatchFollow]);

  const turns = useMemo(
    () => groupMessagesIntoTurns(normalizedMessages),
    [normalizedMessages],
  );
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
  });
  virtualizationRef.current = virtualization;
  // Find reads the message data, so it covers the turns that are not mounted.
  const findTurns = useMemo(
    () =>
      turns.map((turn, index) => ({
        key: resolveTurnKey(turn, index, turnKeyAliasRef.current),
        userMsg: turn.userMsg,
        assistantMsgs: turn.assistantMsgs,
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
  const showPlanning = useMemo(() => {
    if (!isStreaming) return false;
    const lastMessage = normalizedMessages[normalizedMessages.length - 1];
    if (!lastMessage) return false;
    const lastTurn = turns[turns.length - 1];
    const hasAssistant = Boolean(lastTurn && lastTurn.assistantMsgs.length > 0);
    if (lastMessage.role === "user" && !hasAssistant) return true;
    return isStreaming && !getLastAssistantHasContent(normalizedMessages);
  }, [isStreaming, normalizedMessages, turns]);
  const isNewAssistantMessage =
    lastMessageRole === "assistant" &&
    Boolean(lastMessageId) &&
    lastMessageId !== lastMessageIdRef.current;
  const showAssistantBreathingSpace =
    showAwaitingReply ||
    showPlanning ||
    assistantSpaceActiveRef.current ||
    isNewAssistantMessage;

  useEffect(() => {
    if (lastMessageRole === "assistant") {
      if (lastMessageId && lastMessageId !== lastMessageIdRef.current) {
        assistantSpaceActiveRef.current = true;
      }
    }
    lastMessageIdRef.current = lastMessageId;
  }, [lastMessageId, lastMessageRole]);

  // Follow live output while following the end: every streamed token / tool
  // update produces new `messages`, so snap to the bottom. Instant (not
  // smooth) so it keeps up with fast streams; the ResizeObserver above covers
  // late layout (images, markdown, expanding tool cards).
  useLayoutEffect(() => {
    if (followModeRef.current === "following-end") scrollToBottomInstant();
  }, [
    normalizedMessages,
    isStreaming,
    showPlanning,
    showAssistantBreathingSpace,
    scrollToBottomInstant,
  ]);

  // Instant, and corrected against the real DOM until it holds: a smooth
  // scroll outlives the programmatic window and fights the settle loop.
  const handleJumpToLatest = useCallback(() => {
    dispatchFollow({ type: "jump-to-latest" });
    void virtualizationRef.current?.settleToEnd();
  }, [dispatchFollow]);

  const showJumpButton = !isPinned && normalizedMessages.length > 0;
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

            return (
              <div
                key={turnKey}
                ref={windowed ? virtualization.rowRef(turnKey) : undefined}
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
                    const userCopyVisible = activeCopyId === userCopyKey;
                    const userTimestamp =
                      isMounted && userCreatedAt
                        ? formatTimestamp(new Date(userCreatedAt))
                        : undefined;
                    // Keep unavailable Undo visible with an explanation for this prompt.
                    const showUserToolbar = true;
                    return (
                      <div
                        className="group/user-message"
                        data-prompt-id={turn.userMsg.id}
                      >
                        <CustomUserMessage
                          message={turn.userMsg}
                          className={classNames?.userMessage}
                          enableImagePreview={enableImagePreview}
                        />
                        {showUserToolbar && (
                          <MessageToolbar
                            text={showCopyToolbar ? text : ""}
                            timestamp={userTimestamp}
                            heightClass="h-[28px]"
                            hoverClass="group-hover/user-message:opacity-100 group-hover/user-message:pointer-events-auto"
                            isVisible={userCopyVisible}
                            alignClass="justify-end"
                            onCopied={() => markCopied(userCopyKey)}
                            undoMessageId={turn.userMsg.id}
                            speechKey={userCopyKey}
                          />
                        )}
                      </div>
                    );
                  })()}

                {isLastTurn && turn.userMsg && lastTurnNotice}

                {turn.assistantMsgs.length > 0 &&
                  !(isLastTurn && showPlanning) &&
                  (() => {
                    const assistantText = getTextFromParts(
                      turn.assistantMsgs.flatMap((msg) => msg.parts ?? []),
                      "\n\n",
                    );
                    const isTurnStreaming = isStreaming && isLastTurn;
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
                      ((showCopyToolbar && Boolean(assistantText.trim())) ||
                        turnMetadata !== undefined);
                    const copyKey = `assistant-${turnKey}-all`;
                    const toolbarText = showCopyToolbar ? assistantText : "";

                    const promptId = turn.userMsg?.id;
                    const workedMs = isTurnStreaming
                      ? null
                      : promptId != null && settledWork[promptId] != null
                        ? settledWork[promptId]
                        : turnDurationMs(turn.userMsg, turn.assistantMsgs);
                    const liveStart =
                      promptId != null &&
                      workClockRef.current?.turnId === promptId
                        ? workClockRef.current.startedAt
                        : readCreatedAt(turn.userMsg);

                    return (
                      <div className="group/assistant-turn">
                        <TurnWorkStatus
                          active={isTurnStreaming}
                          startedAt={isTurnStreaming ? liveStart : null}
                          durationMs={workedMs}
                        />
                        <div className="turn-answer flex flex-col gap-3">
                          {(() => {
                            // Consecutive thoughts and tool calls collapse into one
                            // group titled with the latest thought. A run with
                            // no thought falls back to "Tool calls N".
                            const analyses = turn.assistantMsgs.map((msg) =>
                              analyzeAssistantMessage(
                                msg.parts ?? [],
                                suppressQuestionTool,
                                subagentCardIds,
                              ),
                            );
                            const segments = partitionTurnSegments(
                              analyses.map((a) => a.toolsOnly),
                              analyses.map((a) => a.cardsOnly),
                            );
                            return segments.map((segment) => {
                              if (segment.kind === "cards") {
                                const cardParts = segment.msgIndices.flatMap(
                                  (msgIndex) => analyses[msgIndex]!.cardParts,
                                );
                                const chatStreamingStatus = isTurnStreaming
                                  ? "streaming"
                                  : undefined;
                                return (
                                  <SubagentCardGroup
                                    key={`${turn.assistantMsgs[segment.msgIndices[0]!]!.id}-subagents`}
                                    toolCallIds={cardParts.map(
                                      (part) => part.toolCallId!,
                                    )}
                                  >
                                    {cardParts.map((part) => (
                                      <CustomToolRenderer
                                        key={part.toolCallId}
                                        part={part}
                                        chatStatus={chatStreamingStatus}
                                        toolRenderers={toolRenderers}
                                      />
                                    ))}
                                  </SubagentCardGroup>
                                );
                              }
                              if (segment.kind === "message") {
                                const msg =
                                  turn.assistantMsgs[segment.msgIndex]!;
                                const isLastMsg =
                                  isLastTurn &&
                                  segment.msgIndex ===
                                    turn.assistantMsgs.length - 1;
                                return (
                                  <AssistantParts
                                    key={msg.id}
                                    msg={msg}
                                    isLast={isLastMsg}
                                    isStreaming={isStreaming}
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
                              const groupLabel = activityGroupLabel(items);
                              const firstId =
                                turn.assistantMsgs[
                                  segment.msgIndices[0]!
                                ]!.id;
                              const chatStreamingStatus = isTurnStreaming
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
                                      <Brain size={18} />
                                    ) : (
                                      <Wrench size={18} />
                                    )
                                  }
                                  label={groupLabel}
                                  autoOpen={anyToolPending}
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
                        </div>
                        {!isTurnStreaming && (
                          <TurnEditSummary messages={turn.assistantMsgs} turnId={(turn.userMsg as { turnId?: string } | undefined)?.turnId} />
                        )}
                        {showToolbar ? (
                          <MessageToolbar
                            text={toolbarText}
                            heightClass="h-[48px] flex items-start w-full"
                            hoverClass="group-hover/assistant-turn:opacity-100 group-hover/assistant-turn:pointer-events-auto"
                            isVisible={activeCopyId === copyKey}
                            alignClass="justify-start"
                            onCopied={() => markCopied(copyKey)}
                            metadata={turnMetadata}
                            speechKey={copyKey}
                          />
                        ) : activeCopyId === copyKey ? (
                          <MessageToolbar
                            text={toolbarText}
                            heightClass="h-[48px] flex items-start w-full"
                            hoverClass="group-hover/assistant-turn:opacity-100 group-hover/assistant-turn:pointer-events-auto"
                            isVisible={true}
                            alignClass="justify-start"
                            onCopied={() => markCopied(copyKey)}
                            metadata={turnMetadata}
                            speechKey={copyKey}
                          />
                        ) : null}
                      </div>
                    );
                  })()}

                {isLastTurn &&
                  (showAwaitingReply || (showPlanning && turn.assistantMsgs.length === 0)) && (
                  <TurnWorkStatus
                    active
                    startedAt={
                      turn.userMsg &&
                      workClockRef.current?.turnId === turn.userMsg.id
                        ? workClockRef.current.startedAt
                        : readCreatedAt(turn.userMsg)
                    }
                    durationMs={null}
                  />
                )}
              </div>
            );
          })}
        </div>
        {showAssistantBreathingSpace && (
          <div
            aria-hidden="true"
            className="min-h-[max(140px,24vh)] mx-auto max-w-an w-full"
          />
        )}
      </div>
    </div>
    <PromptMarkersOverlay
      messages={normalizedMessages}
      containerRef={chatContainerRef}
      contentRef={contentWrapperRef}
      visible={scrollbarActive}
      onActive={flashScrollbarActive}
      onUserNavigate={handleMarkerNavigateStart}
      markProgrammatic={markProgrammaticScroll}
      scrollAnimRef={promptScrollAnimRef}
      layout={markerLayout}
    />
    {find.barProps && <FindInThreadBar {...find.barProps} />}
    {showJumpButton && (
      <button
        type="button"
        onClick={handleJumpToLatest}
        aria-label="Go to latest"
        data-find-ignore
        className={cn(
          "chat-jump absolute left-1/2 z-10 -translate-x-1/2",
          "inline-flex items-center justify-center",
          "transition-[opacity,transform] duration-150 ease-out",
          "hover:brightness-110 active:scale-[0.97]",
        )}
      >
        {isStreaming && <span aria-hidden="true" className="chat-jump-live" />}
        <IconArrowDown className="size-4" aria-hidden="true" />
      </button>
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
function ContextHandoffMarker({ handoff, text }: { handoff: HandoffMarker; text: string }) {
  // Names come from the provider snapshots: show them once those arrive.
  useProviderSnapshotsStore((state) => state.scopes);
  const iconId = (selection: HandoffSelection) => {
    const brand = inferModelBrand(selection.model, undefined, selection.provider).brandId;
    // An unknown model falls back to its provider's id, which ProviderIcon maps to the vendor logo.
    return brand === 'anthropic' ? 'claude' : brand;
  };
  const status = handoffStatus(handoff, text);
  const from = modelDisplayName(handoff.from.provider, handoff.from.model);
  const to = modelDisplayName(handoff.to.provider, handoff.to.model);
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

function AssistantParts({
  msg,
  isLast,
  isStreaming,
  suppressQuestionTool,
  ToolRendererComponent,
  toolRenderers,
}: {
  msg: UIMessage;
  isLast: boolean;
  isStreaming: boolean;
  suppressQuestionTool: boolean;
  ToolRendererComponent: React.ComponentType<ToolRendererProps>;
  toolRenderers?: Record<string, React.ComponentType<CustomToolRendererProps>>;
}) {
  const parts = useMemo(
    () => normalizeAssistantToolParts(msg.parts ?? []) as unknown[],
    [msg.parts],
  );

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
        elems.push(<section className="mousse-applet mousse-applet-pending" key={`${msg.id}-applet-pending-${i}`} role="status" aria-label="Generating applet"><header className="mousse-applet-header"><strong>Generating interactive applet…</strong></header><div className="mousse-applet-preview" style={{ height: 320 }}>Preview appears when the response is complete.</div></section>);
        i++;
        continue;
      }
      if (isAppletPart(part)) {
        elems.push(<AppletCard key={`${msg.id}-applet-${part.data.revisionId}`} reference={part.data} />);
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
              <Markdown
                content={text}
                className="leading-relaxed [&_p]:leading-relaxed"
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
    suppressQuestionTool,
    ToolRendererComponent,
    toolRenderers,
  ]);

  const handoff = (msg.metadata as { contextHandoff?: HandoffMarker } | undefined)?.contextHandoff;
  if (handoff) return <ContextHandoffMarker handoff={handoff} text={parts.filter(isTextPart).map((part) => part.text).join('')} />;
  const compactionMetadata = msg.metadata as { compaction?: boolean; compacting?: boolean } | undefined;
  if (compactionMetadata?.compaction) {
    const text = parts.filter(isTextPart).map((part) => part.text).join('');
    return <div role="status"><ToolRowBase icon={compactionMetadata.compacting ? <SpiralLoader size={12} /> : undefined}
      shimmerLabel="Compacting context…" completeLabel={text || 'Context compacted'} isAnimating={compactionMetadata.compacting === true} /></div>;
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
}
