import { memo, useEffect, useRef, useState } from "react";
import { commandLabel } from "../../../../../shared/agentActivity";
import { IconCheck, IconChevronRight, IconTerminal2, IconX } from "../../../../lib/icons";
import { TextShimmer } from "../text-shimmer";
import { Collapse } from "../../../../components/ui/Collapse";
import type { TimelineStep, StepState } from "../types/timeline";
import { useToolComplete } from "../hooks/use-tool-complete";
import { cn } from "../utils/cn";
import {
  mapPartStateToInvocationState,
  mapToolInvocationToStep,
  mapToolStateToStepState,
} from "../utils/tool-adapters";
import { ToolApprovalFooter, type ToolApproval } from "./tool-approval-footer";
import { bashOutputLines } from "../utils/bash-output";

export type BashToolTerminalCardProps = {
  step: Extract<TimelineStep, { type: "tool-call" }>;
  state: StepState;
  onComplete: () => void;
  approval?: ToolApproval;
  /** Failed command: red hue on the card. */
  isError?: boolean;
};

/** How close to the bottom (px) still counts as following the tail. */
const FOLLOW_SLACK_PX = 8;

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Geist Mono's ligatures draw "--" as one dash over the space before it ("test.ts --sequence" reads
// "test.ts--sequence"), so the command shows its characters as typed.
const COMMAND_TEXT = "font-mono text-[12.5px] [font-variant-ligatures:none]";

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
  const isInterrupted = step.bashInterrupted === true;
  const command = step.bashCommand ?? step.toolDetail;
  // The command (without its shell wrapper) fills the row in mono, cut by the row's width rather than a character count.
  // Derived from the command as run, with its spacing: a tool's label can differ from it.
  const summary = command
    ? commandLabel(command)
    : (step.bashLabel ?? "").replace(/\s+/g, " ").trim();
  // Expanded, the body shows the full `$ command`, so the header does not repeat it.
  const hideSummary = expanded && Boolean(command);
  const hasExitCode = typeof step.bashExitCode === "number";
  const exitFailed = hasExitCode && step.bashExitCode !== 0;

  // While the command runs the output follows its tail, unless the user scrolled up.
  const outputRef = useRef<HTMLDivElement | null>(null);
  const followTailRef = useRef(true);
  useEffect(() => {
    const element = outputRef.current;
    if (!element || !isPending || !followTailRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [step.bashOutput, isPending, expanded]);
  const handleOutputScroll = () => {
    const element = outputRef.current;
    if (!element) return;
    followTailRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <= FOLLOW_SLACK_PX;
  };

  const meta: string[] = [];
  if (hasExitCode) meta.push(`exit ${step.bashExitCode}`);
  if (typeof step.bashDurationMs === "number") meta.push(formatDuration(step.bashDurationMs));

  return (
    <div
      className={cn(
        "an-tool-chrome an-bash-card rounded-an-tool-border-radius border border-an-border-color bg-an-tool-background overflow-hidden",
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
              className="w-4 h-4 text-an-tool-color-muted animate-spin shrink-0"
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
              className={cn(
                "flex items-center m-0 truncate flex-1 min-w-0",
                summary ? COMMAND_TEXT : "text-xs",
              )}
            >
              {hideSummary ? "" : summary ? `Running ${summary}` : "Running command"}
            </TextShimmer>
          </>
        ) : (
          <>
            <IconTerminal2 size={18} className="text-an-tool-color-muted shrink-0" />
            {isInterrupted ? null : isError ? (
              <IconX className="w-4 h-4 text-red-400 shrink-0" strokeWidth={2.5} />
            ) : (
              <IconCheck
                className="w-4 h-4 text-green-500/70 shrink-0"
                strokeWidth={2.5}
              />
            )}
            <span
              className={cn(
                "truncate flex-1 min-w-0",
                summary ? COMMAND_TEXT : "text-xs",
                isError && !isInterrupted ? "text-red-400" : "text-an-tool-color-muted",
              )}
              title={hideSummary ? undefined : summary || undefined}
            >
              {hideSummary ? null : isInterrupted
                ? `${step.bashSummary ?? "Interrupted"}${summary ? `: ${summary}` : ""}`
                : summary
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
          className="ui-collapse-chevron w-4 h-4 shrink-0 text-an-tool-color-muted"
          data-open={expanded || undefined}
        />
      </button>
      <Collapse open={expanded} className="border-t border-an-border-color px-2.5 py-1.5 font-sans text-[12px] leading-[16px] overflow-hidden bg-an-background">
          {command && (
            <div className="max-h-[160px] overflow-y-auto break-words whitespace-pre-wrap">
              <span className="text-amber-600 dark:text-amber-400 select-none">
                ${" "}
              </span>
              <span className="text-an-tool-color">{command}</span>
            </div>
          )}
          {step.bashCwd && (
            <div className="mt-0.5 text-an-tool-color-muted truncate" title={step.bashCwd}>
              in {step.bashCwd}
            </div>
          )}
          {step.bashTruncated && (
            <div className="mt-1 text-an-tool-color-muted italic">
              Earlier output not shown
              {typeof step.bashBytes === "number"
                ? ` (${formatBytes(step.bashBytes)} total)`
                : ""}
            </div>
          )}
          {step.bashOutput && (
            <div
              ref={outputRef}
              onScroll={handleOutputScroll}
              className={cn(
                "text-an-tool-color-muted whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto",
                (command || step.bashTruncated) && "mt-1",
              )}
            >
              {bashOutputLines(step.bashOutput).map((line, index) => (
                <span key={index} className={cn(line.failed && "text-[var(--danger)]")}>
                  {index > 0 ? "\n" : ""}
                  {line.text}
                </span>
              ))}
            </div>
          )}
          {(meta.length > 0 || isInterrupted) && (
            <div className="mt-1 flex gap-2 text-[11px] text-an-tool-color-muted">
              {hasExitCode && (
                <span className={cn(exitFailed && "text-red-400")}>exit {step.bashExitCode}</span>
              )}
              {typeof step.bashDurationMs === "number" && (
                <span>{formatDuration(step.bashDurationMs)}</span>
              )}
              {isInterrupted && <span>{step.bashSummary ?? "Interrupted"}</span>}
            </div>
          )}
      </Collapse>
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
