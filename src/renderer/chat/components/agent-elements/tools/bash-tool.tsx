import { memo, useEffect, useRef, useState } from "react";
import { commandLabel } from "../../../../../shared/agentActivity";
import { IconTerminal2 } from "../../../../lib/icons";
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
import { CopyIconButton } from "./copy-icon-button";
import { ToolRowBase } from "./tool-row-base";
import { useToolRowInfo } from "./tool-icon";

export type BashToolRowProps = {
  step: Extract<TimelineStep, { type: "tool-call" }>;
  state: StepState;
  onComplete: () => void;
  approval?: ToolApproval;
  /** Failed command: the row's icon and label in the danger colour. */
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
// "test.ts--sequence"), so a command shows its characters as typed.
const MONO = "font-mono [font-variant-ligatures:none]";

/**
 * A command the agent ran, as one quiet line like the other tool rows: the terminal icon, "Ran" and the command on
 * one line (cut by the row's width, the whole command in its tooltip). It opens to the full command, the folder it ran
 * in and its output, in a plain block. A command waiting for approval keeps its approval footer.
 */
export function BashToolRow({
  step,
  state,
  onComplete,
  approval,
  isError = false,
}: BashToolRowProps) {
  useToolComplete(state === "animating", step.duration, onComplete);
  const [expanded, setExpanded] = useState(false);
  const isPending = state === "animating";
  const isInterrupted = step.bashInterrupted === true;
  const command = step.bashCommand ?? step.toolDetail;
  // The command without its shell wrapper, with its spacing; derived from the command as run, since a tool's label
  // can differ from it.
  const summary = command
    ? commandLabel(command)
    : (step.bashLabel ?? "").replace(/\s+/g, " ").trim();
  const hasExitCode = typeof step.bashExitCode === "number";
  const exitFailed = hasExitCode && step.bashExitCode !== 0;
  const failed = isError && !isInterrupted;
  // A failure the agent got past is quiet on the collapsed row (a dim icon and ×, ToolRowBase): no red exit code there.
  const { recovered = false } = useToolRowInfo();

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

  const verb = isPending
    ? "Running"
    : isInterrupted
      ? (step.bashSummary ?? "Interrupted")
      : failed
        ? "Failed"
        : "Ran";
  const label = summary ? verb : `${verb} command`;
  const hasBody = Boolean(command || step.bashOutput || step.bashCwd || step.bashTruncated || hasExitCode);

  const row = (
    <div className="an-bash-row" data-status={isPending ? "running" : failed ? "failed" : isInterrupted ? "interrupted" : "done"}>
      <ToolRowBase
        icon={<IconTerminal2 size={18} />}
        shimmerLabel={label}
        completeLabel={label}
        isAnimating={isPending}
        failed={failed}
        detail={summary || undefined}
        detailTitle={summary || undefined}
        detailClassName={cn("an-bash-row-command text-[13px]", MONO)}
        badge={exitFailed && !expanded && !recovered ? (
          <span className="text-[12.5px] text-[var(--danger)]">exit {step.bashExitCode}</span>
        ) : undefined}
        expandable={hasBody}
        expanded={expanded}
        onToggleExpand={() => setExpanded((open) => !open)}
      >
        <div className={cn("an-bash-body rounded-md bg-an-tool-background px-2.5 py-2 text-[13px] leading-[20px]", MONO)}>
          {command && (
            <div className="flex items-start gap-1">
              <div className="flex-1 min-w-0 max-h-[160px] overflow-y-auto break-words whitespace-pre-wrap">
                <span className="text-an-tool-color-muted select-none">${" "}</span>
                <span className="text-an-tool-color">{command}</span>
              </div>
              <CopyIconButton text={command} label="Copy command" />
            </div>
          )}
          {step.bashCwd && (
            <div className="mt-0.5 font-sans text-an-tool-color-muted truncate" title={step.bashCwd}>
              in {step.bashCwd}
            </div>
          )}
          {step.bashTruncated && (
            <div className="mt-1.5 font-sans text-an-tool-color-muted italic">
              Earlier output not shown
              {typeof step.bashBytes === "number" ? ` (${formatBytes(step.bashBytes)} total)` : ""}
            </div>
          )}
          {step.bashOutput && (
            <div className={cn("flex items-start gap-1", (command || step.bashTruncated) && "mt-1.5")}>
              <div
                ref={outputRef}
                onScroll={handleOutputScroll}
                className={cn(
                  "an-bash-output flex-1 min-w-0 text-an-tool-color-muted whitespace-pre-wrap break-words max-h-[320px] overflow-y-auto",
                  MONO,
                )}
              >
                {bashOutputLines(step.bashOutput).map((line, index) => (
                  <span key={index} className={cn(line.failed && "text-[var(--danger)]")}>
                    {index > 0 ? "\n" : ""}
                    {line.text}
                  </span>
                ))}
              </div>
              {!isPending && <CopyIconButton text={step.bashOutput} label="Copy output" />}
            </div>
          )}
          {(hasExitCode || typeof step.bashDurationMs === "number" || isInterrupted) && (
            <div className="an-bash-exit mt-1.5 flex gap-3 text-an-tool-color-muted">
              {hasExitCode && (
                <span className={cn(exitFailed && "text-[var(--danger)]")}>exit {step.bashExitCode}</span>
              )}
              {typeof step.bashDurationMs === "number" && <span>{formatDuration(step.bashDurationMs)}</span>}
              {isInterrupted && <span className="font-sans">{step.bashSummary ?? "Interrupted"}</span>}
            </div>
          )}
        </div>
      </ToolRowBase>
    </div>
  );

  // A command waiting for approval keeps its approval footer, boxed with the row it answers.
  if (!approval) return row;
  return (
    <div className="an-bash-approval rounded-an-tool-border-radius border border-an-border-color overflow-hidden">
      <div className="px-2.5 py-1">{row}</div>
      <ToolApprovalFooter isPending={isPending} {...approval} />
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
    <BashToolRow
      step={step}
      state={stepState}
      onComplete={noop}
      approval={approval}
      isError={part.state === "output-error"}
    />
  );
});
