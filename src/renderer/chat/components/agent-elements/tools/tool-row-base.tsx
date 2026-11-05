import { useState, type ReactNode } from "react";
import { Collapse } from "../../../../components/ui/Collapse";
import { TextShimmer } from "../text-shimmer";
import { IconChevronRight } from "../../../../lib/icons";
import { cn } from "../utils/cn";

export type ToolRowBaseProps = {
  icon?: ReactNode;
  shimmerLabel?: string;
  completeLabel: string;
  isAnimating: boolean;
  /** A failed call: the label reads in the danger colour. */
  failed?: boolean;
  detail?: string;
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
      <div className="flex items-center gap-2 min-w-0 text-[15px] leading-[22px] text-muted-foreground">
        {icon && (
          <span className="flex items-center justify-center size-[18px] shrink-0">
            {icon}
          </span>
        )}
        <span
          className={cn(
            "font-[450] whitespace-nowrap",
            failed && !isAnimating && "text-[var(--danger)]",
            // A label with nothing after it (a thought) keeps to one line.
            detail || trailingContent ? "shrink-0" : "min-w-0 truncate",
          )}
        >
          {isAnimating && shimmerLabel ? (
            <TextShimmer
              as="span"
              duration={1.2}
              className="flex items-center m-0"
            >
              {shimmerLabel}
            </TextShimmer>
          ) : (
            completeLabel
          )}
        </span>
        {detail && (
          <span className="font-normal truncate min-w-0 flex-1 text-an-foreground-muted/60">
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

  if (!expandable) {
    return <div className="an-tool-chrome flex flex-col gap-1">{row}</div>;
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
      {/* The shared Collapse animates a grid row, so the panel content is laid out once at full size and
          only its clip changes per frame (an animated `height` re-measured the diffs, markdown and nested
          tools every frame). The gap sits inside it as padding so it opens and closes with the panel. */}
      <Collapse open={isExpanded} className="overflow-hidden pt-2" itemCount={itemCount}>
        {children}
      </Collapse>
    </div>
  );
}
