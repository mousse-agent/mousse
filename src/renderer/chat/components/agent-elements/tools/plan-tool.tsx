import React, { memo, useState } from "react";
import {
  IconChevronsDown,
  IconChevronsUp,
  IconFileDescription,
} from "../../../../lib/icons";
import { Markdown } from "../markdown";
import { IconSpinner } from "../icons";
import { areToolPropsEqual } from "../utils/format-tool";

type Plan = {
  id?: string;
  title: string;
  summary?: string;
};

type PlanToolPart = {
  state?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
};

export type PlanToolProps = {
  part: PlanToolPart;
  chatStatus?: string;
};

/** Extract displayable markdown from tool output/result when input.plan.summary is empty. */
function outputMarkdown(part: PlanToolPart): string {
  const raw = part.output ?? part.result;
  if (typeof raw === "string") return raw;
  if (raw != null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const nested = obj.plan ?? obj.markdown ?? obj.summary ?? obj.text;
    if (typeof nested === "string") return nested;
  }
  return "";
}

/** Resolve the full plan markdown, preferring input but falling back to output. */
function resolvePlanMarkdown(plan: Plan, part: PlanToolPart): string {
  const fromInput = (plan.summary ?? "").trim();
  if (fromInput) return plan.summary ?? "";
  return outputMarkdown(part);
}

/**
 * A runtime's own plan or progress list (Codex's checklist, a plan item it writes), shown read-only in the
 * transcript with the same chrome as other tool cards. It asks nothing of the user.
 */
export const PlanTool = memo(function PlanTool({
  part,
}: PlanToolProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const input = (part.input ?? {}) as { plan?: Plan };
  const plan = input.plan ?? { title: "To-dos" };
  const markdown = resolvePlanMarkdown(plan, part);
  const hasPlan = Boolean(markdown.trim());

  const isPending =
    part.state !== "output-available" && part.state !== "output-error";
  const title = plan.title || "To-dos";

  return (
    <div
      className="an-tool-chrome rounded-an-tool-border-radius border border-an-tool-border-color bg-an-tool-background overflow-hidden"
      data-tool="plan"
    >
      <div className="h-7 pl-3 pr-2.5 flex items-center justify-between">
        <div className="min-w-0 flex items-center gap-1">
          {isPending ? (
            <IconSpinner className="w-4 h-4 text-an-tool-color-muted animate-spin shrink-0" />
          ) : (
            <IconFileDescription className="w-3.5 h-3.5 text-an-tool-color-muted shrink-0" />
          )}
          <span className="text-sm text-an-tool-color-muted truncate">{title}</span>
        </div>
        {hasPlan && (
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-label={isExpanded ? "Collapse plan" : "Expand plan"}
            className="size-5 inline-flex items-center justify-center text-an-tool-color-muted"
          >
            {isExpanded ? (
              <IconChevronsUp className="w-3.5 h-3.5" />
            ) : (
              <IconChevronsDown className="w-3.5 h-3.5" />
            )}
          </button>
        )}
      </div>
      <div className="border-t border-an-tool-border-color bg-an-background py-2">
        <div
          className={
            isExpanded
              ? "px-3 text-sm text-an-tool-color"
              : "px-3 text-sm text-an-tool-color-muted max-h-96 overflow-y-auto"
          }
        >
          {hasPlan ? (
            <Markdown content={markdown} className="text-sm" />
          ) : (
            <div className="text-sm text-an-tool-color-muted">No to-dos yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}, areToolPropsEqual);
