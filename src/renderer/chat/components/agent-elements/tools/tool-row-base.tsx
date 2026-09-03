import type { ReactNode } from "react";
import { Collapsible } from "@base-ui/react/collapsible";
import { TextShimmer } from "../text-shimmer";
import { IconChevronRight } from "@tabler/icons-react";
import { cn } from "../utils/cn";

export type ToolRowBaseProps = {
  icon?: ReactNode;
  shimmerLabel?: string;
  completeLabel: string;
  isAnimating: boolean;
  detail?: string;
  trailingContent?: ReactNode;
  expandable?: boolean;
  expanded?: boolean;
  defaultOpen?: boolean;
  onToggleExpand?: () => void;
  children?: ReactNode;
};

export function ToolRowBase({
  icon,
  shimmerLabel,
  completeLabel,
  isAnimating,
  detail,
  trailingContent,
  expandable = false,
  expanded,
  defaultOpen = false,
  onToggleExpand,
  children,
}: ToolRowBaseProps) {
  const isComplete = !isAnimating;
  const isExpanded = expanded ?? false;
  const canToggle = expandable && (isComplete || isExpanded || isAnimating);

  const row = (
    <div
      className={cn(
        "flex items-center max-w-full select-none gap-1 rounded-an-tool-border-radius",
        canToggle ? "cursor-pointer" : "cursor-default",
      )}
    >
      <div className="flex items-center gap-2 min-w-0 text-base text-muted-foreground">
        {icon && (
          <span className="flex items-center justify-center size-3 shrink-0">
            {icon}
          </span>
        )}
        <span className="font-[450] whitespace-nowrap shrink-0">
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
        {trailingContent}
      </div>
      {expandable && (isComplete || isExpanded || isAnimating) && (
        <div>
          <IconChevronRight
            className={cn(
              "shrink-0 text-muted-foreground transition-transform duration-150 ease-out",
              "size-3",
              "rotate-0 group-data-panel-open:rotate-90",
            )}
          />
        </div>
      )}
    </div>
  );

  if (!expandable) {
    return <div className="an-tool-chrome flex flex-col gap-1">{row}</div>;
  }

  const rootProps =
    expanded === undefined
      ? { defaultOpen }
      : { open: expanded, onOpenChange: onToggleExpand };

  return (
    <Collapsible.Root
      className="an-tool-chrome flex flex-col gap-2 w-full"
      {...rootProps}
    >
      <Collapsible.Trigger
        className="group flex"
        disabled={!canToggle}
        aria-disabled={!canToggle}
      >
        {row}
      </Collapsible.Trigger>
      <Collapsible.Panel
        // NOTE: intentionally no height animation here. Animating
        // `h-[var(--collapsible-panel-height)]` with `transition-all`
        // forces a layout per frame while measuring heavy panel content
        // (diffs, markdown, nested tools) and fights the message-list
        // ResizeObserver scroll-follow — that's the expand/collapse
        // stutter. Instant open/close = single layout pass. The chevron
        // rotation above is transform-only and stays cheap.
        className={cn(
          "overflow-hidden",
          "[&[hidden]:not([hidden='until-found'])]:hidden",
        )}
      >
        {children}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
