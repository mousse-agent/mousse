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

import { UserMessage } from "./user-message";
import { Markdown } from "./markdown";
import { ErrorMessage } from "./error-message";
import type { CustomToolRendererProps } from "./types";
import { ToolRowBase } from "./tools/tool-row-base";
import { IconArrowBackUp, IconArrowDown, IconCopy, IconCheck, IconInfoCircle, IconX } from "@tabler/icons-react";
import {
  formatResponseTime,
  formatTokens,
  formatTokensPerSecond,
} from "../../../utils/assistantMessageActions";
import { ToolRenderer as DefaultToolRenderer } from "./tools/tool-renderer";
import { ToolCallsGroup } from "./tools/tool-calls-group";
import { normalizeAssistantToolParts } from "./utils/tool-part-normalizer";
import {
  analyzeAssistantMessage,
  isErrorPart,
  isRecord,
  isTextPart,
  isV5ToolPart,
  partitionTurnSegments,
  type ToolPartBase,
} from "./utils/assistant-blocks";
import { SpiralLoader } from "./spiral-loader";

export type MessageListProps = {
  messages: UIMessage[];
  status: ChatStatus;
  className?: string;
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
      return isV5ToolPart(part);
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

function UndoButton() {
  return (
    <button
      type="button"
      tabIndex={-1}
      // TODO: wire up undo action — UI only for now.
      onClick={() => {}}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      title="Undo"
      aria-label="Undo"
      className={cn(
        "size-6 flex items-center justify-center rounded-md active:scale-[0.97] transition-[background-color,opacity,transform] duration-150 ease-out",
        "opacity-50 bg-transparent hover:opacity-100 hover:bg-an-foreground/10",
      )}
    >
      <IconArrowBackUp className="w-3.5 h-3.5 text-an-foreground-muted" />
    </button>
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
  showUndo,
  metadata,
}: {
  text?: string;
  timestamp?: string;
  heightClass: string;
  hoverClass: string;
  isVisible: boolean;
  alignClass: string;
  onCopied?: () => void;
  showUndo?: boolean;
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
      {showUndo && <UndoButton />}
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

type PromptMarker = { id: string; topRatio: number; preview: string };

/**
 * Scrollbar prompt dots. Deliberately isolated with its own state: position
 * recomputes (ResizeObserver + streaming + expand/collapse) must never
 * re-render the message list — that was the expand/collapse stutter whenever
 * the dots were visible. Marker updates now only re-render this tiny overlay.
 */
const PromptMarkersOverlay = memo(function PromptMarkersOverlay({
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
  const rafRef = useRef(0);
  const visibleRef = useRef(visible);
  const loggedCountRef = useRef(-1);

  const updateMarkers = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      // Skip while hidden (opacity-0 at rest): an expand/collapse resize
      // must not do layout reads for invisible dots. Positions refresh when
      // the overlay becomes visible (effect below).
      if (!visibleRef.current) return;
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
        if (!(target instanceof HTMLElement)) continue;
        // Rect-based so nested `relative` wrappers / transforms can't skew it.
        const y =
          target.getBoundingClientRect().top -
          containerRect.top +
          container.scrollTop;
        const ratio = Math.min(0.995, Math.max(0, y / scrollHeight));
        const preview = getTextFromParts(userMsg.parts ?? [], " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
        next.push({
          id: userMsg.id,
          topRatio: ratio,
          preview: preview || "Your prompt",
        });
      }
      if (loggedCountRef.current !== next.length) {
        loggedCountRef.current = next.length;
        // eslint-disable-next-line no-console
        console.debug(`[prompt-markers] tracking ${next.length} prompts`);
      }
      setMarkers((prev) => {
        if (
          prev.length === next.length &&
          prev.every(
            (m, i) =>
              m.id === next[i]!.id &&
              Math.abs(m.topRatio - next[i]!.topRatio) < 0.002,
          )
        ) {
          return prev;
        }
        return next;
      });
    });
  }, [messages, containerRef, contentRef]);

  useEffect(() => {
    visibleRef.current = visible;
    if (visible) updateMarkers();
  }, [visible, updateMarkers]);

  // Keep dots in sync with layout (streaming text, images, expanding tool
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
      if (!(el instanceof HTMLElement)) return;
      const y =
        el.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
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

  return (
    <div
      aria-hidden={!visible}
      data-testid="prompt-markers"
      className={cn(
        "pointer-events-none absolute top-2 bottom-2 right-[14px] z-10 w-5",
        "transition-opacity duration-200 ease-out",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      {markers.map((marker, index) => (
        <button
          key={marker.id}
          type="button"
          tabIndex={-1}
          title={`${index + 1}. ${marker.preview}`}
          aria-label={`Jump to prompt ${index + 1}: ${marker.preview}`}
          onClick={() => scrollToPrompt(marker.id)}
          onMouseEnter={onActive}
          style={{
            top: `${marker.topRatio * 100}%`,
            backgroundColor: "var(--an-primary-color, #60a5fa)",
            boxShadow: "0 0 8px rgba(96,165,250,0.8)",
          }}
          className={cn(
            "pointer-events-auto absolute right-[3px] -translate-y-1/2 rounded-full",
            "h-[14px] w-[5px] opacity-55",
            "transition-[transform,filter,opacity] duration-150 ease-out",
            "hover:w-[7px] hover:opacity-100 hover:brightness-125 active:scale-95",
          )}
        />
      ))}
    </div>
  );
});

export const MessageList = memo(function MessageList({
  messages,
  status,
  className,
  showCopyToolbar = true,
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
  const [scrollbarActive, setScrollbarActive] = useState(false);
  const scrollActiveTimerRef = useRef<number | null>(null);
  // Shared with PromptMarkersOverlay: the parent cancels an in-flight
  // marker glide on manual scroll (wheel/touch/pointer), the overlay drives
  // it. Marker position state itself lives in the overlay so recomputes
  // never re-render the message list.
  const promptScrollAnimRef = useRef(0);

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
    let prevScrollHeight = container.scrollHeight;
    let raf = 0;

    const resizeObserver = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const newContentHeight = contentWrapper.getBoundingClientRect().height;
        if (newContentHeight === lastContentHeight) {
          prevScrollHeight = container.scrollHeight;
          return;
        }
        lastContentHeight = newContentHeight;

        if (shouldAutoScrollRef.current) {
          // Pinned: follow streaming text / images / expanding tool cards.
          programmaticScrollAtRef.current = performance.now();
          container.scrollTop = container.scrollHeight;
        } else {
          // Reading history: anchor the viewport so new content above
          // doesn't yank what the user is looking at.
          const newScrollHeight = container.scrollHeight;
          if (newScrollHeight !== prevScrollHeight && prevScrollHeight > 0) {
            const delta = newScrollHeight - prevScrollHeight;
            programmaticScrollAtRef.current = performance.now();
            container.scrollTop = container.scrollTop + delta;
          }
        }
        prevScrollHeight = container.scrollHeight;
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

  const lastUserMessageIdRef = useRef(lastUserMessageId);
  const pendingPlanningScrollUserIdRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (
      lastUserMessageId &&
      lastUserMessageId !== lastUserMessageIdRef.current
    ) {
      shouldAutoScrollRef.current = true;
      setIsPinned(true);
      pendingPlanningScrollUserIdRef.current = lastUserMessageId;
      const cancel = scrollToBottomSettled();
      lastUserMessageIdRef.current = lastUserMessageId;
      return cancel;
    }
  }, [lastUserMessageId, scrollToBottomSettled]);

  const planningLabel = "Processing...";
  const turns = useMemo(
    () => groupMessagesIntoTurns(normalizedMessages),
    [normalizedMessages],
  );
  const showPlanning = useMemo(() => {
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
    showPlanning || assistantSpaceActiveRef.current || isNewAssistantMessage;

  useEffect(() => {
    if (lastMessageRole === "assistant") {
      if (lastMessageId && lastMessageId !== lastMessageIdRef.current) {
        assistantSpaceActiveRef.current = true;
      }
    }
    if (lastMessageRole === "user") {
      assistantSpaceActiveRef.current = false;
    }
    lastMessageIdRef.current = lastMessageId;
  }, [lastMessageId, lastMessageRole]);

  useLayoutEffect(() => {
    if (!showPlanning || !lastUserMessageId) return;
    if (pendingPlanningScrollUserIdRef.current !== lastUserMessageId) return;
    const cancel = scrollToBottomSettled();
    pendingPlanningScrollUserIdRef.current = null;
    return cancel;
  }, [lastUserMessageId, showPlanning, scrollToBottomSettled]);

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
  // Marker dots show only while the scrollbar is actively used (scrolling,
  // dragging, or hovering its edge) — nothing at rest. Position state lives
  // in PromptMarkersOverlay, so its updates never re-render this list.

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
            const turnKey = turn.userMsg?.id ?? `turn-${turnIndex}`;

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
                    // The user toolbar always renders — the undo button is
                    // always present (UI-only for now), plus the copy
                    // button (gated by showCopyToolbar) or a timestamp.
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
                            showUndo
                          />
                        )}
                      </div>
                    );
                  })()}

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

                    return (
                      <div className="group/assistant-turn">
                        <div className="flex flex-col gap-3">
                          {(() => {
                            // Consecutive tools-only messages collapse into one
                            // "Tool calls N" group; everything else renders as-is.
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
                              const firstId =
                                turn.assistantMsgs[
                                  segment.msgIndices[0]!
                                ]!.id;
                              const chatStreamingStatus = isTurnStreaming
                                ? "streaming"
                                : undefined;
                              return (
                                <ToolCallsGroup
                                  key={`${firstId}-toolcalls`}
                                  count={items.length}
                                  autoOpen={isTurnStreaming}
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

                {isLastTurn && showPlanning && (
                  <ToolRowBase
                    icon={<SpiralLoader size={12} />}
                    shimmerLabel={planningLabel}
                    completeLabel="Done"
                    isAnimating={true}
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
        aria-label={isStreaming ? "Streaming — jump to latest" : "Jump to latest"}
        className={cn(
          "absolute bottom-4 left-1/2 -translate-x-1/2 z-10",
          "flex items-center gap-1.5 rounded-full pl-3 pr-3.5 py-1.5 text-xs font-medium",
          "bg-an-foreground text-an-background shadow-lg",
          "hover:brightness-110 active:scale-[0.97]",
          "transition-[opacity,transform] duration-150 ease-out",
        )}
      >
        {isStreaming && (
          <span
            aria-hidden="true"
            className="size-1.5 rounded-full bg-current animate-pulse"
          />
        )}
        <IconArrowDown className="size-3.5" aria-hidden="true" />
        {isStreaming ? "Streaming — latest" : "Latest"}
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

  if (elements.length > 1) {
    return (
      <div className="group/assistant-turn flex flex-col gap-3">{elements}</div>
    );
  }

  return <div className="group/assistant-turn">{elements}</div>;
}
