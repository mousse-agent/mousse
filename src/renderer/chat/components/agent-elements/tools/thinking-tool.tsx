import { memo, useCallback, useContext, useLayoutEffect, useRef } from "react";
import { LiveRunBodyContext } from "./tool-open-state";
import type { TimelineStep, StepState } from "../types/timeline";
import { useToolComplete } from "../hooks/use-tool-complete";
import { ToolRowBase } from "./tool-row-base";
import { Markdown } from "../markdown";
import { ThinkingIcon } from "../../../../lib/icons";
import { useLiveThought } from "../../../../stores/liveTextStore";
import { thoughtSourceOf } from "../utils/assistant-blocks";
import { countRender } from "../render-counts";
import { liveThoughtText, thoughtHeadline } from "../utils/format-tool";
import {
  mapPartStateToInvocationState,
  mapToolInvocationToStep,
  mapToolStateToStepState,
} from "../utils/tool-adapters";

export type ThinkingCollapsedProps = {
  step: Extract<TimelineStep, { type: "tool-call" }>;
  state: StepState;
  onComplete: () => void;
  defaultOpen?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
};

export function ThinkingCollapsed({
  step,
  state,
  onComplete,
  defaultOpen,
  expanded,
  onToggleExpand,
}: ThinkingCollapsedProps) {
  useToolComplete(state === "animating", step.duration, onComplete);

  // One still line: the thought's headline, the same line the live row and a group show.
  const heading = thoughtHeadline(step.thoughtContent);
  const isAnimating = state === "animating";
  // In an opened live row the thought being written shows open, so it can be read in full as it grows.
  const inLiveRun = useContext(LiveRunBodyContext);
  const startsOpen = defaultOpen ?? (inLiveRun && isAnimating);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const atEndRef = useRef(true);
  // Each time it opens while it is written (by hand, or as the live row opens), its box goes to its newest words and
  // follows them again: also when it reopens before its close has finished, so its box is still there, scrolled up.
  // A finished thought opens where it was.
  const onOpen = useCallback(() => {
    const box = boxRef.current;
    if (!box || !isAnimating) return;
    atEndRef.current = true;
    box.scrollTop = box.scrollHeight;
  }, [isAnimating]);
  // While it is written, its box keeps its newest words in view, unless the person scrolled up in it. This also puts a
  // box that mounts open (the row itself mounting open) at its end.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box && isAnimating && atEndRef.current) box.scrollTop = box.scrollHeight;
  }, [isAnimating, step.thoughtContent]);

  return (
    <ToolRowBase
      icon={<ThinkingIcon size={18} active={isAnimating} />}
      completeLabel={heading || "Thinking"}
      labelTitle={liveThoughtText(step.thoughtContent) || undefined}
      // The icon pulses; a shimmering label would paint every frame.
      shimmer={false}
      isAnimating={isAnimating}
      expandable={!!step.thoughtContent}
      defaultOpen={startsOpen}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
      onOpen={onOpen}
    >
      <div
        ref={boxRef}
        className="max-h-[175px] overflow-y-auto"
        onScroll={(event) => {
          const box = event.currentTarget;
          atEndRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 4;
        }}
      >
        <Markdown
          content={step.thoughtContent ?? ""}
          // A thought still being written changes on every update: its splits are not kept.
          streaming={isAnimating}
          className="text-base text-muted-foreground leading-relaxed [&_p]:leading-relaxed"
        />
      </div>
    </ToolRowBase>
  );
}

export type ThinkingToolProps = {
  part?: any;
  step?: Extract<TimelineStep, { type: "tool-call" }>;
  state?: StepState;
  onComplete?: () => void;
  defaultOpen?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
};

export const ThinkingTool = memo(function ThinkingTool({
  part,
  step: externalStep,
  state: externalState,
  onComplete: externalOnComplete,
  defaultOpen,
  expanded,
  onToggleExpand,
}: ThinkingToolProps) {
  countRender("ThinkingTool");
  // The thought as it is written (see liveTextStore): a streamed delta renders this row alone.
  const source = part && !externalStep ? thoughtSourceOf(part) : undefined;
  const thought = useLiveThought(source);
  let step: Extract<TimelineStep, { type: "tool-call" }>;
  let stepState: StepState;
  let onComplete: () => void;

  if (externalStep && externalState && externalOnComplete) {
    step = externalStep;
    stepState = externalState;
    onComplete = externalOnComplete;
  } else if (part) {
    const args = part.input ?? part.args ?? {};
    step = mapToolInvocationToStep(part.toolCallId ?? part.id ?? "thinking", {
      toolName: "Thinking",
      args: source && thought !== source.thought ? { ...args, thought } : args,
      state: mapPartStateToInvocationState(part.state),
      result: part.output ?? part.result,
    });
    stepState = mapToolStateToStepState(
      mapPartStateToInvocationState(part.state),
    );
    onComplete = () => {};
  } else {
    return null;
  }

  return (
    <ThinkingCollapsed
      step={step}
      state={stepState}
      onComplete={onComplete}
      defaultOpen={defaultOpen}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
    />
  );
});
