import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Collapse } from "../../../../components/ui/Collapse";
import { TextShimmer } from "../text-shimmer";
import { IconChevronRight } from "../../../../lib/icons";
import { cn } from "../utils/cn";
import { NO_ROW_INFO, RecoveredFailureMark, ToolRowContext, ToolRowTime, ToolStateIcon, useToolRowInfo } from "./tool-icon";
import { useToolOpen } from "./tool-open-state";

/**
 * Seconds per sweep of a running row's label shimmer: one pulse of its icon (`an-tool-icon-pulse`, tool-icon.css), so
 * the band crosses the label as the icon dims after each peak. Both start as the row starts running.
 */
export const SHIMMER_DURATION_S = 1.6;

export type ToolRowBaseProps = {
  icon?: ReactNode;
  shimmerLabel?: string;
  completeLabel: string;
  isAnimating: boolean;
  /**
   * A failed call. When the agent got past it (`ToolRowContext.recovered`), only the icon dims toward the danger
   * colour and a small × follows the label; otherwise the label reads in the danger colour.
   */
  failed?: boolean;
  detail?: string;
  /** The detail's full text, for its tooltip. */
  detailTitle?: string;
  /** The label's tooltip: its whole text when the row may cut it (a group headed by a thought). */
  labelTitle?: string;
  /** Classes for the detail (a command shows in mono). */
  detailClassName?: string;
  /**
   * Whether a running row's label shimmers (it paints every frame). A thinking row pulses its own icon instead. A row
   * that shimmers also shows its icon's state: a gentle pulse while it runs, dimmed once done, the danger colour on
   * failure.
   */
  shimmer?: boolean;
  /** Short status after the detail (a failure count); never truncated. */
  badge?: ReactNode;
  trailingContent?: ReactNode;
  expandable?: boolean;
  expanded?: boolean;
  defaultOpen?: boolean;
  onToggleExpand?: () => void;
  /**
   * Called each time the row goes from closed to open, after its panel is in the document: whether the panel mounted
   * again or was still there, closing, when it reopened.
   */
  onOpen?: () => void;
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
  detailTitle,
  labelTitle,
  detailClassName,
  shimmer = true,
  badge,
  trailingContent,
  expandable = false,
  expanded,
  defaultOpen = false,
  onToggleExpand,
  onOpen,
  itemCount,
  children,
}: ToolRowBaseProps) {
  const isComplete = !isAnimating;
  const { at, recovered = false, openKey } = useToolRowInfo();
  // Uncontrolled rows (no `expanded`) keep their open state, seeded by `defaultOpen`: under the call's id when they
  // have one (tool-open-state.ts), so a row the list rebuilds stays as the person left it.
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const kept = useToolOpen(expanded === undefined ? openKey : undefined, defaultOpen);
  const isExpanded = expanded ?? (kept ? kept[0] : ownOpen);
  const wasExpanded = useRef(isExpanded);
  useLayoutEffect(() => {
    if (isExpanded && !wasExpanded.current) onOpen?.();
    wasExpanded.current = isExpanded;
  }, [isExpanded, onOpen]);
  const canToggle = expandable && (isComplete || isExpanded || isAnimating);
  const loudFailure = failed && !isAnimating && !recovered;
  const quietFailure = failed && !isAnimating && recovered;

  const row = (
    <div
      className={cn(
        "an-tool-row-line flex w-full max-w-full select-none gap-1 rounded-an-tool-border-radius items-center",
        canToggle ? "cursor-pointer" : "cursor-default",
      )}
    >
      <div
        className="flex items-center gap-2 min-w-0 text-[14px] leading-[22px] text-an-foreground-muted"
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
          title={labelTitle}
          className={cn(
            "font-normal whitespace-nowrap",
            loudFailure && "text-[var(--danger)]",
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
        {detail && (
          <span className={cn("font-normal truncate min-w-0 flex-1 text-an-foreground-muted/60", detailClassName)} title={detailTitle}>
            {detail}
          </span>
        )}
        {quietFailure && <RecoveredFailureMark />}
        {badge && <span className="shrink-0 whitespace-nowrap font-normal">{badge}</span>}
        {trailingContent}
      </div>
      {expandable && (isComplete || isExpanded || isAnimating) && (
        <span className="an-row-chevron-box" aria-hidden="true">
          <IconChevronRight className="ui-collapse-chevron an-row-chevron" data-open={isExpanded || undefined} />
        </span>
      )}
      <ToolRowTime at={at} />
    </div>
  );

  if (!expandable) {
    return <div className="an-tool-chrome flex flex-col gap-1">{row}</div>;
  }

  const toggle = () => {
    if (expanded === undefined) {
      if (kept) kept[1](!kept[0]);
      else setOwnOpen((open) => !open);
    }
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
      {/* The shared Collapse animates a grid row, so the panel content is laid out once at full size and
          only its clip changes per frame (an animated `height` re-measured the diffs, markdown and nested
          tools every frame). The gap sits inside it as padding so it opens and closes with the panel. */}
      <Collapse open={isExpanded} className="overflow-hidden pt-2" itemCount={itemCount}>
        {/* Rows inside the panel are other calls: they read their own time and failure, not this row's. */}
        <ToolRowContext.Provider value={NO_ROW_INFO}>{children}</ToolRowContext.Provider>
      </Collapse>
    </div>
  );
}
