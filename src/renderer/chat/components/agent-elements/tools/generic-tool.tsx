import React, { memo } from "react";
import type { TimelineStep, StepState } from "../types/timeline";
import { useToolComplete } from "../hooks/use-tool-complete";
import { ToolRowBase } from "./tool-row-base";
import { IconX } from "../../../../lib/icons";

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
  isPending: boolean;
  isError?: boolean;
};

export const GenericTool = memo(function GenericTool({
  icon,
  title,
  failedTitle,
  subtitle,
  isPending,
  isError = false,
}: GenericToolProps) {
  const Icon = icon;
  const failed = isError && !isPending;
  const label = failed ? (failedTitle ?? title) : title;

  return (
    <ToolRowBase
      icon={
        failed ? (
          <IconX size={16} strokeWidth={2.5} className="shrink-0 text-[var(--danger)]" />
        ) : Icon ? (
          <Icon size={18} className="shrink-0 text-muted-foreground" />
        ) : undefined
      }
      shimmerLabel={title}
      completeLabel={label}
      isAnimating={isPending}
      failed={failed}
      detail={subtitle}
    />
  );
});

