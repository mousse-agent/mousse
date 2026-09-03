import { memo, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ToolRowBase } from "./tool-row-base";

export type ToolCallsGroupProps = {
  count: number;
  /** Open while the turn is streaming; collapses when the run completes. */
  autoOpen?: boolean;
  children: ReactNode;
};

/**
 * Collapsible wrapper for consecutive tool calls:
 * "Tool calls <num> >" (chevron), collapsed once complete.
 * A manual toggle always wins over the automatic open/collapse.
 */
export const ToolCallsGroup = memo(function ToolCallsGroup({
  count,
  autoOpen = false,
  children,
}: ToolCallsGroupProps) {
  const [expanded, setExpanded] = useState(autoOpen);
  const userToggledRef = useRef(false);

  useEffect(() => {
    if (!userToggledRef.current) setExpanded(autoOpen);
  }, [autoOpen]);

  return (
    <ToolRowBase
      completeLabel="Tool calls"
      shimmerLabel="Tool calls"
      detail={`${count}`}
      isAnimating={autoOpen}
      expandable
      expanded={expanded}
      onToggleExpand={() => {
        userToggledRef.current = true;
        setExpanded((prev) => !prev);
      }}
    >
      <div className="flex flex-col gap-3 ml-1.5 border-l border-an-border-color pl-3">
        {children}
      </div>
    </ToolRowBase>
  );
});
