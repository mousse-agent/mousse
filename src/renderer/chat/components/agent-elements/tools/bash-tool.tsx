import { memo, useState } from "react";
import { IconCheck, IconChevronRight, IconX } from "@tabler/icons-react";
import { TextShimmer } from "../text-shimmer";
import type { TimelineStep, StepState } from "../types/timeline";
import { useToolComplete } from "../hooks/use-tool-complete";
import { cn } from "../utils/cn";
import {
  mapPartStateToInvocationState,
  mapToolInvocationToStep,
  mapToolStateToStepState,
} from "../utils/tool-adapters";
import { extractCommandSummary } from "../utils/format-tool";
import { ToolApprovalFooter, type ToolApproval } from "./tool-approval-footer";

export type BashToolTerminalCardProps = {
  step: Extract<TimelineStep, { type: "tool-call" }>;
  state: StepState;
  onComplete: () => void;
  approval?: ToolApproval;
  /** Failed command: red hue on the card. */
  isError?: boolean;
};

export function BashToolTerminalCard({
  step,
  state,
  onComplete,
  approval,
  isError = false,
}: BashToolTerminalCardProps) {
  useToolComplete(state === "animating", step.duration, onComplete);
  const [expanded, setExpanded] = useState(false);
  const isPending = state === "animating";
  const command = step.bashCommand ?? step.toolDetail;
  const summary = extractCommandSummary(command);

  return (
    <div
      className={cn(
        "an-tool-chrome rounded-an-tool-border-radius border border-an-border-color bg-an-tool-background overflow-hidden",
        isError && "border-red-500/50",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse command details" : "Expand command details"}
        title={expanded ? "Collapse command details" : "Expand command details"}
        className="flex items-center gap-1.5 pl-2.5 pr-2 h-7 min-w-0 w-full text-left cursor-pointer"
      >
        {isPending ? (
          <>
            <svg
              className="w-3 h-3 text-an-tool-color-muted animate-spin shrink-0"
              viewBox="0 0 16 16"
              fill="none"
            >
              <circle
                cx="8"
                cy="8"
                r="6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray="28"
                strokeDashoffset="7"
                strokeLinecap="round"
              />
            </svg>
            <TextShimmer
              as="span"
              duration={1.2}
              className="inline-flex items-center text-xs leading-none h-full m-0 truncate flex-1 min-w-0"
            >
              {summary ? `Running ${summary}` : "Running command"}
            </TextShimmer>
          </>
        ) : (
          <>
            {isError ? (
              <IconX className="w-3 h-3 text-red-400 shrink-0" strokeWidth={2.5} />
            ) : (
              <IconCheck
                className="w-3 h-3 text-green-500/70 shrink-0"
                strokeWidth={2.5}
              />
            )}
            <span
              className={cn(
                "text-xs truncate flex-1 min-w-0",
                isError ? "text-red-400" : "text-an-tool-color-muted",
              )}
            >
              {summary
                ? isError
                  ? `Failed ${summary}`
                  : summary
                : isError
                  ? "Failed command"
                  : "Ran command"}
            </span>
          </>
        )}
        <IconChevronRight
          className={cn(
            "w-3 h-3 shrink-0 text-an-tool-color-muted transition-transform duration-150 ease-out",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div className="border-t border-an-border-color px-2.5 py-1.5 font-mono text-[12px] leading-[16px] overflow-hidden bg-an-background">
          {command && (
            <div className="break-all">
              <span className="text-amber-600 dark:text-amber-400 select-none">
                ${" "}
              </span>
              <span className="text-an-tool-color">{command}</span>
            </div>
          )}
          {!isPending && step.bashOutput && (
            <div
              className={cn(
                "text-an-tool-color-muted whitespace-pre-line max-h-[120px] overflow-y-auto",
                command && "mt-1",
              )}
            >
              {step.bashOutput}
            </div>
          )}
        </div>
      )}
      {approval && <ToolApprovalFooter isPending={isPending} {...approval} />}
    </div>
  );
}

export type BashToolProps = {
  part: any;
};

export const BashTool = memo(function BashTool({ part }: BashToolProps) {
  const approval = (part.input?.approval ?? part.args?.approval) as
    | ToolApproval
    | undefined;
  const step = mapToolInvocationToStep(part.toolCallId ?? part.id ?? "bash", {
    toolName: "Bash",
    args: part.input ?? part.args ?? {},
    state: mapPartStateToInvocationState(part.state),
    result: part.output ?? part.result,
  });
  const stepState = mapToolStateToStepState(
    mapPartStateToInvocationState(part.state),
  );
  const noop = () => {};

  return (
    <BashToolTerminalCard
      step={step}
      state={stepState}
      onComplete={noop}
      approval={approval}
      isError={part.state === "output-error"}
    />
  );
});
