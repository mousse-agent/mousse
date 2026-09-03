import { memo, useState } from "react";
import { IconChevronRight } from "@tabler/icons-react";
import { TextShimmer } from "../text-shimmer";
import type { TimelineStep, StepState } from "../types/timeline";
import { useToolComplete } from "../hooks/use-tool-complete";
import {
  mapToolInvocationToStep,
  mapToolStateToStepState,
} from "../utils/tool-adapters";
import { ToolApprovalFooter, type ToolApproval } from "./tool-approval-footer";

function extractCommandSummary(cmd: string): string {
  return cmd
    .split("|")
    .map((s) => s.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean)
    .slice(0, 4)
    .join(", ");
}

export type BashToolTerminalCardProps = {
  step: Extract<TimelineStep, { type: "tool-call" }>;
  state: StepState;
  onComplete: () => void;
  approval?: ToolApproval;
};

export function BashToolTerminalCard({
  step,
  state,
  onComplete,
  approval,
}: BashToolTerminalCardProps) {
  useToolComplete(state === "animating", step.duration, onComplete);
  const [expanded, setExpanded] = useState(false);
  const isPending = state === "animating";
  const command = step.bashCommand ?? step.toolDetail;
  const summary = extractCommandSummary(command);

  return (
    <div className="rounded-an-tool-border-radius border border-border bg-an-tool-background overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse command details" : "Expand command details"}
        title={expanded ? "Collapse command details" : "Expand command details"}
        className="flex items-center justify-between pl-2.5 pr-2 h-7 w-full text-left cursor-pointer"
      >
        <div className="flex items-center gap-1.5 min-w-0 overflow-hidden flex-1">
          {isPending ? (
            <TextShimmer
              as="span"
              duration={1.2}
              className="flex items-center text-xs m-0 truncate"
            >
              Running command: {summary}
            </TextShimmer>
          ) : (
            <span className="text-xs text-muted-foreground truncate">
              Ran command: {summary}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isPending && (
            <svg
              className="w-3 h-3 text-muted-foreground animate-spin shrink-0"
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
          )}
          <IconChevronRight
            className={`w-3 h-3 shrink-0 text-muted-foreground transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
          />
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border px-2.5 py-1.5 font-mono text-[12px] leading-[16px] overflow-hidden bg-background">
          <div className="break-all">
            <span className="text-amber-600 dark:text-amber-400 select-none">
              ${" "}
            </span>
            <span className="text-foreground">{command}</span>
          </div>
          {!isPending && step.bashOutput && (
            <div className="mt-1 text-muted-foreground whitespace-pre-line max-h-[80px] overflow-hidden">
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
    state:
      part.state === "output-available"
        ? "result"
        : part.state === "input-streaming"
          ? "partial-call"
          : "call",
    result: part.output ?? part.result,
  });
  const stepState = mapToolStateToStepState(
    part.state === "output-available"
      ? "result"
      : part.state === "input-streaming"
        ? "partial-call"
        : "call",
  );
  const noop = () => {};

  return (
    <BashToolTerminalCard
      step={step}
      state={stepState}
      onComplete={noop}
      approval={approval}
    />
  );
});
