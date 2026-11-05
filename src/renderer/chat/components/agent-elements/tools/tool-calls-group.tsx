import { memo, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ToolRowBase } from "./tool-row-base";

export type ToolCallsGroupProps = {
  count: number;
  /** Thinking icon when the title is a thought; a tool icon otherwise. */
  icon?: ReactNode;
  /**
   * One line from the latest thought in the run. When absent (the run has no
   * thought text), the header falls back to "Tool calls" plus the count.
   * Other tool calls do not change this title.
   */
  label?: string;
  /**
   * True while any tool inside the group is still running. Drives the group
   * header shimmer only — completed groups stay static even if the turn is
   * still streaming text. The group stays collapsed unless toggled.
   */
  autoOpen?: boolean;
  /** Failed calls inside the group: named in the header, in the danger colour. */
  failed?: number;
  /**
   * True while the turn is streaming. A failure that lands then opens the
   * group once; a failure already there when an old turn loads does not.
   */
  live?: boolean;
  children: ReactNode;
};

/**
 * Collapsible wrapper for consecutive tool calls:
 * "Tool calls <num> >" (chevron), collapsed by default — even while
 * streaming. A manual toggle opens it, and so does the first failure that
 * lands while the turn runs.
 */
export const ToolCallsGroup = memo(function ToolCallsGroup({
  count,
  icon,
  label,
  autoOpen = false,
  failed = 0,
  live = false,
  children,
}: ToolCallsGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const title = label?.trim() ? label : "Tool calls";
  // Failures already seen; a live group starts from none so its first failure counts.
  const seenFailed = useRef(live ? 0 : failed);
  const openedForFailure = useRef(false);
  useEffect(() => {
    if (failed > seenFailed.current && !openedForFailure.current) {
      openedForFailure.current = true;
      setExpanded(true);
    }
    seenFailed.current = failed;
  }, [failed]);

  return (
    <ToolRowBase
      icon={icon}
      completeLabel={title}
      shimmerLabel={title}
      detail={title === "Tool calls" ? `${count}` : undefined}
      badge={
        failed > 0 ? (
          <span className="text-[var(--danger)]">· {failed} failed</span>
        ) : undefined
      }
      isAnimating={autoOpen}
      expandable
      expanded={expanded}
      onToggleExpand={() => {
        setExpanded((prev) => !prev);
      }}
      itemCount={count}
    >
      <div className="an-tool-group-rows ui-collapse-items flex flex-col gap-1.5 ml-1.5 border-l border-an-border-color pl-3">
        {children}
      </div>
    </ToolRowBase>
  );
});
