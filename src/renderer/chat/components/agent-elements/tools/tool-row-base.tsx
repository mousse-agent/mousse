import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Collapse } from "../../../../components/ui/Collapse";
import { TextShimmer } from "../text-shimmer";
import { IconChevronRight } from "../../../../lib/icons";
import { cn } from "../utils/cn";
import { ToolStateIcon } from "./tool-icon";

/** How often a thought being written is read out to a screen reader. */
const ANNOUNCE_MS = 5000;

/** `text`, changing at most every `ms` (the latest value once the wait ends); "" at once. */
function useThrottledText(text: string, ms: number): string {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (!text) {
      setShown("");
      return;
    }
    const wait = last.current + ms - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setShown(text);
      return;
    }
    const timer = window.setTimeout(() => {
      last.current = Date.now();
      setShown(text);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [text, ms]);
  return shown;
}

/** Seconds per sweep of a running row's label shimmer. */
export const SHIMMER_DURATION_S = 1.2;

export type ToolRowBaseProps = {
  icon?: ReactNode;
  shimmerLabel?: string;
  completeLabel: string;
  isAnimating: boolean;
  /** A failed call: the label reads in the danger colour. */
  failed?: boolean;
  detail?: string;
  /**
   * The detail is a thought being written: its newest words matter, so a detail too long for the row is cut at its
   * start, not its end (`an-live-thought`). `detailTitle` is the full text, for the tooltip and screen readers.
   */
  liveDetail?: boolean;
  detailTitle?: string;
  /** Classes for the detail (a command shows in mono). */
  detailClassName?: string;
  /**
   * Whether a running row's label shimmers (it paints every frame). A thinking row turns its icon instead. A row that
   * shimmers also shows its icon's state: a gentle pulse while it runs, dimmed once done, the danger colour on failure.
   */
  shimmer?: boolean;
  /** Short status after the detail (a failure count); never truncated. */
  badge?: ReactNode;
  trailingContent?: ReactNode;
  expandable?: boolean;
  expanded?: boolean;
  defaultOpen?: boolean;
  onToggleExpand?: () => void;
  /** Rows in the panel when it is a list; a long one opens without the per-row stagger. */
  itemCount?: number;
  children?: ReactNode;
};

export function ToolRowBase({
  icon,
  shimmerLabel,
  completeLabel,
  isAnimating,
  failed = false,
  detail,
  liveDetail = false,
  detailTitle,
  detailClassName,
  shimmer = true,
  badge,
  trailingContent,
  expandable = false,
  expanded,
  defaultOpen = false,
  onToggleExpand,
  itemCount,
  children,
}: ToolRowBaseProps) {
  const isComplete = !isAnimating;
  // Uncontrolled rows (no `expanded`) keep their own open state, seeded by `defaultOpen`.
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const isExpanded = expanded ?? ownOpen;
  const canToggle = expandable && (isComplete || isExpanded || isAnimating);

  const row = (
    <div
      className={cn(
        "flex items-center max-w-full select-none gap-1 rounded-an-tool-border-radius",
        canToggle ? "cursor-pointer" : "cursor-default",
      )}
    >
      <div
        className="flex items-center gap-2 min-w-0 text-base leading-[22px] text-muted-foreground"
        // One sweep period for the label's shimmer.
        style={{ "--an-shimmer-duration": `${SHIMMER_DURATION_S}s` } as CSSProperties}
      >
        {icon && (shimmer ? (
          <ToolStateIcon state={failed && !isAnimating ? "failed" : isAnimating ? "running" : "done"}>
            {icon}
          </ToolStateIcon>
        ) : (
          <span className="flex items-center justify-center size-[18px] shrink-0">
            {icon}
          </span>
        ))}
        <span
          className={cn(
            "font-[450] whitespace-nowrap",
            failed && !isAnimating && "text-[var(--danger)]",
            // A label with nothing after it (a thought) keeps to one line.
            detail || trailingContent ? "shrink-0" : "min-w-0 truncate",
          )}
        >
          {isAnimating && shimmerLabel && shimmer ? (
            <TextShimmer
              as="span"
              duration={SHIMMER_DURATION_S}
              className="flex items-center m-0"
            >
              {shimmerLabel}
            </TextShimmer>
          ) : (
            isAnimating && shimmerLabel ? shimmerLabel : completeLabel
          )}
        </span>
        {detail && liveDetail ? (
          <span className="an-live-thought font-normal min-w-0 flex-1 text-an-foreground-muted/60" title={detailTitle ?? detail} aria-label={detailTitle ?? detail}>
            <bdi>{detail}</bdi>
          </span>
        ) : detail && (
          <span className={cn("font-normal truncate min-w-0 flex-1 text-an-foreground-muted/60", detailClassName)} title={detailTitle}>
            {detail}
          </span>
        )}
        {badge && <span className="shrink-0 whitespace-nowrap font-normal">{badge}</span>}
        {trailingContent}
      </div>
      {expandable && (isComplete || isExpanded || isAnimating) && (
        <div>
          <IconChevronRight
            className="ui-collapse-chevron shrink-0 text-muted-foreground size-[18px]"
            data-open={isExpanded || undefined}
          />
        </div>
      )}
    </div>
  );

  // A thought being written is read out now and then, not with every word.
  const announced = useThrottledText(liveDetail && isAnimating ? detailTitle ?? detail ?? "" : "", ANNOUNCE_MS);
  const announcement = liveDetail && isAnimating && announced ? (
    <span role="status" className="sr-only">{`${shimmerLabel ?? completeLabel}: ${announced}`}</span>
  ) : null;

  if (!expandable) {
    return <div className="an-tool-chrome flex flex-col gap-1">{row}{announcement}</div>;
  }

  const toggle = () => {
    if (expanded === undefined) setOwnOpen((open) => !open);
    else onToggleExpand?.();
  };

  return (
    <div className="an-tool-chrome flex flex-col w-full">
      <button
        type="button"
        className="group flex"
        aria-expanded={isExpanded}
        disabled={!canToggle}
        aria-disabled={!canToggle}
        onClick={toggle}
      >
        {row}
      </button>
      {announcement}
      {/* The shared Collapse animates a grid row, so the panel content is laid out once at full size and
          only its clip changes per frame (an animated `height` re-measured the diffs, markdown and nested
          tools every frame). The gap sits inside it as padding so it opens and closes with the panel. */}
      <Collapse open={isExpanded} className="overflow-hidden pt-2" itemCount={itemCount}>
        {children}
      </Collapse>
    </div>
  );
}
