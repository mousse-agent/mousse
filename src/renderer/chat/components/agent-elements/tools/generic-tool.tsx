import React, { memo } from "react";
import type { TimelineStep, StepState } from "../types/timeline";
import { useToolComplete } from "../hooks/use-tool-complete";
import { ToolRowBase } from "./tool-row-base";
import { Wrench } from "../../../../lib/icons";

export type GenericToolRowProps = {
  step: Extract<TimelineStep, { type: "tool-call" }>;
  state: StepState;
  onComplete: () => void;
};

export function GenericToolRow({
  step,
  state,
  onComplete,
}: GenericToolRowProps) {
  useToolComplete(state === "animating", step.duration, onComplete);
  const isPending = state === "animating";

  return (
    <ToolRowBase
      shimmerLabel={step.toolName}
      completeLabel={step.toolName}
      isAnimating={isPending}
      detail={step.toolDetail}
    />
  );
}

export type GenericToolProps = {
  icon?: React.ComponentType<{ className?: string; size?: number }>;
  title: string;
  /** Label once the call failed; the title when absent. */
  failedTitle?: string;
  subtitle?: string;
  /** The full detail when the subtitle shortens it, for the tooltip. */
  detailTitle?: string;
  isPending: boolean;
  isError?: boolean;
};

export const GenericTool = memo(function GenericTool({
  icon,
  title,
  failedTitle,
  subtitle,
  detailTitle,
  isPending,
  isError = false,
}: GenericToolProps) {
  const Icon = icon ?? Wrench;
  const failed = isError && !isPending;
  const label = failed ? (failedTitle ?? title) : title;

  return (
    <ToolRowBase
      // The tool's own icon in every state; a failed call tints it (ToolRowBase).
      icon={<Icon size={18} className="shrink-0" />}
      shimmerLabel={title}
      completeLabel={label}
      isAnimating={isPending}
      failed={failed}
      detail={subtitle}
      detailTitle={detailTitle || undefined}
    />
  );
});

