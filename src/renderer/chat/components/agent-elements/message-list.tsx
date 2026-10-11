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
import { useVisiblePromptIds } from "./use-visible-prompt-ids";
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
    <div className="turn-work">
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
}) {
  const [metadataOpen, setMetadataOpen] = useState(false);
  // Keep the toolbar interactive while the popup is open — otherwise the
  // hover-gated opacity hides the popup the moment the cursor leaves.
  const visible = isVisible || metadataOpen;
  return (
    <div
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
}: {
  messages: UIMessage[];
  containerRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  onActive: () => void;
  onUserNavigate: () => void;
  markProgrammatic: () => void;
  scrollAnimRef: React.MutableRefObject<number>;
}) {
  const [markers, setMarkers] = useState<PromptMarker[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [previewId, setPreviewId] = useState<string>();
  const markerPositionsRef = useRef<PromptMarker[]>([]);
  const rafRef = useRef(0);
  const loggedCountRef = useRef(-1);

  const updateActiveMarker = useCallback(() => {
    const container = containerRef.current;
    const positions = markerPositionsRef.current.filter((marker) => Number.isFinite(marker.offset));
    if (!container || !positions.length) return;
    const atBottom = container.scrollHeight > container.clientHeight &&
      container.scrollTop + container.clientHeight >= container.scrollHeight - 2;
    let current = positions[0];
    for (const marker of positions) {
      if (atBottom || marker.offset <= container.scrollTop + 24) current = marker;
      else break;
    }
    setActiveId(current?.id);
  }, [containerRef]);

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
        if (!userMsg) continue;
        const target: Element | null = content.querySelector(
          `[data-prompt-id="${escapeId(userMsg.id)}"]`,
        );
        // Rect-based so nested `relative` wrappers / transforms can't skew it.
        const y = target instanceof HTMLElement
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
  }, [messages, containerRef, contentRef, updateActiveMarker]);
  const visiblePromptIds = useVisiblePromptIds(containerRef, contentRef, updateMarkers);

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
        : markerPositionsRef.current.find((marker) => marker.id === id)?.offset;
      if (y === undefined || !Number.isFinite(y)) return;
      onUserNavigate();
      onActive();
      const targetTop = Math.max(0, y - 16);
      const start = container.scrollTop;
      const distance = targetTop - start;
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
    ],
  );

  if (markers.length === 0) return null;
  const previewMarker = markers.find((marker) => marker.id === previewId);
  const highlightedIndex = markers.findIndex((marker) => marker.id === previewId);

  return (
    <div
      data-testid="prompt-markers"
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
  slots,
  classNames,
  toolRenderers,
}: MessageListProps) {
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const contentWrapperRef = useRef<HTMLDivElement>(null);
  const chatContainerObserverRef = useRef<ResizeObserver | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const prevScrollTopRef = useRef(0);
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

  const containerRefCallback = useCallback((el: HTMLDivElement | null) => {
    (
      chatContainerRef as React.MutableRefObject<HTMLDivElement | null>
    ).current = el;

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

  const scrollToBottomSmooth = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    markProgrammaticScroll();
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      container.scrollTop = container.scrollHeight;
      return;
    }
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [markProgrammaticScroll]);

  const scrollToBottomSettled = useCallback(
    (smooth = false) => {
      let rafOne = 0;
      let rafTwo = 0;
      if (smooth) scrollToBottomSmooth();
      else scrollToBottomInstant();
      rafOne = requestAnimationFrame(() => {
        if (smooth) scrollToBottomSmooth();
        else scrollToBottomInstant();
        rafTwo = requestAnimationFrame(() => {
          if (smooth) scrollToBottomSmooth();
          else scrollToBottomInstant();
        });
      });
      return () => {
        cancelAnimationFrame(rafOne);
        cancelAnimationFrame(rafTwo);
      };
    },
    [scrollToBottomInstant, scrollToBottomSmooth],
  );

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

  const handleScroll = useCallback(() => {
    const container = chatContainerRef.current;
    if (!container) return;

    const currentScrollTop = container.scrollTop;
    const prevScrollTop = prevScrollTopRef.current;
    prevScrollTopRef.current = currentScrollTop;

    if (currentScrollTop < prevScrollTop) {
      shouldAutoScrollRef.current = false;
    } else {
      shouldAutoScrollRef.current = isAtBottom();
    }
    const pinned = shouldAutoScrollRef.current;
    setIsPinned((prev) => (prev === pinned ? prev : pinned));
    // Skip auto-scroll noise (streaming follow, mount pin, marker glide) —
    // only a human moving the scrollbar reveals the markers.
    if (performance.now() - programmaticScrollAtRef.current > 150) {
      flashScrollbarActive();
    }
  }, [isAtBottom, flashScrollbarActive]);

  // A marker-dot jump hands control to the user: stop following the stream
  // and hide the jump-to-latest button. The glide itself is driven by the
  // overlay (shared `promptScrollAnimRef`).
  const handleMarkerNavigateStart = useCallback(() => {
    shouldAutoScrollRef.current = false;
    setIsPinned(false);
  }, []);

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

    if (initialScrollBehavior === "top") {
      programmaticScrollAtRef.current = performance.now();
      container.scrollTop = 0;
      shouldAutoScrollRef.current = false;
    } else {
      programmaticScrollAtRef.current = performance.now();
      container.scrollTop = container.scrollHeight;
      shouldAutoScrollRef.current = true;
    }

    let lastContentHeight = contentWrapper.getBoundingClientRect().height;
    let raf = 0;

    const resizeObserver = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const newContentHeight = contentWrapper.getBoundingClientRect().height;
        if (newContentHeight === lastContentHeight) {
          return;
        }
        lastContentHeight = newContentHeight;

        if (shouldAutoScrollRef.current) {
          // Pinned: follow streaming text / images / expanding tool cards.
          programmaticScrollAtRef.current = performance.now();
          container.scrollTop = container.scrollHeight;
        }
        // When reading history (unpinned): leave scrollTop untouched.
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
      shouldAutoScrollRef.current = true;
      setIsPinned(true);
      const cancel = scrollToBottomSettled();
      lastUserMessageIdRef.current = lastUserMessageId;
      return cancel;
    }
  }, [lastUserMessageId, scrollToBottomSettled]);

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

  // Follow live output while pinned: every streamed token / tool update
  // produces new `messages`, so snap to the bottom. Instant (not smooth)
  // so it keeps up with fast streams; the ResizeObserver above covers
  // late layout (images, markdown, expanding tool cards).
  useLayoutEffect(() => {
    if (shouldAutoScrollRef.current) scrollToBottomInstant();
  }, [
    normalizedMessages,
    isStreaming,
    showPlanning,
    showAssistantBreathingSpace,
    scrollToBottomInstant,
  ]);

  const handleJumpToLatest = useCallback(() => {
    shouldAutoScrollRef.current = true;
    setIsPinned(true);
    scrollToBottomSettled(true);
  }, [scrollToBottomSettled]);

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
      className={cn(
        "an-message-list flex-1 min-h-0 overflow-y-auto overscroll-contain",
        className,
      )}
    >
      <div ref={contentWrapperRef} className="mx-auto px-6 py-6 max-w-an">
        <div className="space-y-6">
          {turns.map((turn, turnIndex) => {
            const isLastTurn = turnIndex === turns.length - 1;
            const turnKey = turn.userMsg
              ? (turnKeyAliasRef.current.get(turn.userMsg.id) ??
                turn.userMsg.id)
              : `turn-${turnIndex}`;

            return (
              <div key={turnKey} className="relative space-y-2">
                {turn.userMsg &&
                  (() => {
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
                              ),
                            );
                            const segments = partitionTurnSegments(
                              analyses.map((a) => a.toolsOnly),
                            );
                            return segments.map((segment) => {
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
                          <TurnEditSummary messages={turn.assistantMsgs} />
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
    />
    {showJumpButton && (
      <button
        type="button"
        onClick={handleJumpToLatest}
        aria-label="Go to latest"
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

  const handoff = (msg.metadata as { contextHandoff?: { from: { provider: string; model: string }; to: { provider: string; model: string } } } | undefined)?.contextHandoff;
  if (handoff) {
    const iconId = (selection: { provider: string; model: string }) => {
      const brand = inferModelBrand(selection.model, undefined, selection.provider).brandId;
      return brand === 'anthropic' || selection.provider === 'claude-subscription' ? 'claude' : brand;
    };
    return <div role="status" aria-label={`Context handoff: ${handoff.from.model} to ${handoff.to.model}`}
      className="flex w-full items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5" title={handoff.from.provider}><ProviderIcon providerId={iconId(handoff.from)} size={14} />{handoff.from.model}</span>
      <span aria-hidden="true">→</span>
      <span className="inline-flex items-center gap-1.5" title={handoff.to.provider}><ProviderIcon providerId={iconId(handoff.to)} size={14} />{handoff.to.model}</span>
    </div>;
  }
  const compactionMetadata = msg.metadata as { compaction?: boolean; compacting?: boolean } | undefined;
  if (compactionMetadata?.compaction) {
    const text = parts.filter(isTextPart).map((part) => part.text).join('');
    return <div role="status"><ToolRowBase icon={compactionMetadata.compacting ? <SpiralLoader size={12} /> : undefined}
      shimmerLabel="Compacting context…" completeLabel={text || 'Context compacted'} isAnimating={compactionMetadata.compacting === true} /></div>;
  }
  if (elements.length > 1) {
    return (
      <div className="group/assistant-turn flex flex-col gap-3">{elements}</div>
    );
  }

  return <div className="group/assistant-turn">{elements}</div>;
}
