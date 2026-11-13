import { memo } from "react";
import type { TimelineStep, StepState } from "../types/timeline";
import { useToolComplete } from "../hooks/use-tool-complete";
import { ToolRowBase } from "./tool-row-base";
import { Markdown } from "../markdown";
import { ThinkingIcon } from "../../../../lib/icons";
import { useLiveThought } from "../../../../stores/liveTextStore";
import { thoughtSourceOf } from "../utils/assistant-blocks";
import { countRender } from "../render-counts";
import { liveThoughtLine, liveThoughtText, thoughtLine } from "../utils/format-tool";
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

  const heading = thoughtLine(step.thoughtContent);
  const isAnimating = state === "animating";

  return (
    <ToolRowBase
      icon={<ThinkingIcon size={18} active={isAnimating} />}
      shimmerLabel="Thinking"
      completeLabel={heading || "Thinking"}
      // While it streams, the thought as it is written is the row, up to four lines: its newest words ("Thinking"
      // only until its first words). Once it ends (the next step starts), the row folds to one line of its opening.
      detail={isAnimating ? liveThoughtLine(step.thoughtContent) || undefined : undefined}
      liveDetail
      detailTitle={isAnimating ? liveThoughtText(step.thoughtContent) || undefined : undefined}
      // The icon turns; a shimmering label would paint every frame.
      shimmer={false}
      isAnimating={isAnimating}
      expandable={!!step.thoughtContent}
      defaultOpen={defaultOpen}
      expanded={expanded}
      onToggleExpand={onToggleExpand}
    >
      <div className="max-h-[175px] overflow-y-auto">
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
