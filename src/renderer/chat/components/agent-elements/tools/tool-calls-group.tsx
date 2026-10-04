import { memo, useState } from "react";
import type { ReactNode } from "react";
import { ToolRowBase } from "./tool-row-base";

export type ToolCallsGroupProps = {
  count: number;
  /** Thinking icon when the title is a thought; a tool icon otherwise. */
  icon?: ReactNode;
  /**
   * Latest thought in the run. When absent, the header falls back to
   * "Tool calls" plus the count. Other tool calls do not change this title.
   */
  label?: string;
  /**
   * True while any tool inside the group is still running. Drives the group
   * header shimmer only — completed groups stay static even if the turn is
   * still streaming text. The group stays collapsed unless toggled.
   */
  autoOpen?: boolean;
  children: ReactNode;
};

/**
 * Collapsible wrapper for consecutive tool calls:
 * "Tool calls <num> >" (chevron), collapsed by default — even while
 * streaming. A manual toggle opens it.
 */
export const ToolCallsGroup = memo(function ToolCallsGroup({
  count,
  icon,
  label,
  autoOpen = false,
  children,
}: ToolCallsGroupProps) {
  const [expanded, setExpanded] = useState(false);
  const title = label?.trim() ? label : "Tool calls";

  return (
    <ToolRowBase
      icon={icon}
      completeLabel={title}
      shimmerLabel={title}
      detail={title === "Tool calls" ? `${count}` : undefined}
      isAnimating={autoOpen}
      expandable
      expanded={expanded}
      onToggleExpand={() => {
        setExpanded((prev) => !prev);
      }}
    >
      <div className="flex flex-col gap-0.5 ml-1.5 border-l border-an-border-color pl-3">
        {children}
      </div>
    </ToolRowBase>
  );
});
