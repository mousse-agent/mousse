import { memo, useState } from "react";
import type { ReactNode } from "react";
import { ToolRowBase } from "./tool-row-base";

export type ToolCallsGroupProps = {
  count: number;
  /** True while the turn is streaming (drives the shimmer); the group stays collapsed unless toggled. */
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
  autoOpen = false,
  children,
}: ToolCallsGroupProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <ToolRowBase
      completeLabel="Tool calls"
      shimmerLabel="Tool calls"
      detail={`${count}`}
      isAnimating={autoOpen}
      expandable
      expanded={expanded}
      onToggleExpand={() => {
        setExpanded((prev) => !prev);
      }}
    >
      <div className="flex flex-col gap-3 ml-1.5 border-l border-an-border-color pl-3">
        {children}
      </div>
    </ToolRowBase>
  );
});
