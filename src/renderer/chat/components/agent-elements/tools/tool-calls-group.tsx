import { memo, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ToolRowBase } from "./tool-row-base";
import { countRender } from "../render-counts";
import "./tool-calls-group.css";

export type ToolCallsGroupProps = {
  count: number;
  /** The icon of the calls' kind, or a wrench for a mix. */
  icon?: ReactNode;
  /** What the calls did ("Read 3 files and ran 2 commands"), from `workGroupTitle`. */
  title: string;
  /** Failed calls inside the group: named in the header. */
  failed?: number;
  /** True while the turn runs: an open group keeps its newest row in view as rows arrive. */
  live?: boolean;
  children: ReactNode;
};

/**
 * One still line for consecutive tool calls, titled with what they did, closed until clicked. A running turn keeps
 * its calls folded here; the turn's live line under them says what runs now. Open, the rows sit in a box capped at
 * about 18rem that scrolls on its own, with soft edges where more rows are (tool-calls-group.css).
 */
export const ToolCallsGroup = memo(function ToolCallsGroup({
  count,
  icon,
  title,
  failed = 0,
  live = false,
  children,
}: ToolCallsGroupProps) {
  countRender("ToolCallsGroup");
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the open box shows its last row: rows that arrive then keep it in view.
  const atEndRef = useRef(true);
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || !live || !atEndRef.current) return;
    box.scrollTop = box.scrollHeight;
  }, [count, live, expanded]);

  return (
    <ToolRowBase
      icon={icon}
      completeLabel={title}
      shimmer={false}
      badge={
        failed > 0 ? (
          <span className="text-[var(--danger)]">· {failed} failed</span>
        ) : undefined
      }
      isAnimating={false}
      expandable
      expanded={expanded}
      onToggleExpand={() => {
        setExpanded((prev) => !prev);
      }}
      itemCount={count}
    >
      <div
        ref={scrollRef}
        className="an-tool-group-scroll"
        data-tool-group-scroll
        onScroll={(event) => {
          const box = event.currentTarget;
          atEndRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
        }}
      >
        <div className="an-tool-group-rows ui-collapse-items flex flex-col gap-1.5 ml-1.5 pl-3">
          {children}
        </div>
      </div>
    </ToolRowBase>
  );
});
