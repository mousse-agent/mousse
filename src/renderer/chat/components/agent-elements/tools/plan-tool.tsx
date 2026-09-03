import React, { memo, useState } from "react";
import {
  IconChevronsDown,
  IconChevronsUp,
  IconFileDescription,
} from "@tabler/icons-react";
import { useAppStore } from "../../../../stores/appStore";
import { Markdown } from "../markdown";
import { IconSpinner } from "../icons";
import { areToolPropsEqual } from "../utils/format-tool";

type Plan = {
  id?: string;
  title: string;
  summary?: string;
};

type PlanToolInput = {
  plan: Plan;
  onApprove?: () => void | Promise<void>;
  onPreview?: () => void | Promise<void>;
  approveLabel?: string;
  previewLabel?: string;
  approved?: boolean;
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
  const raw = (part as { output?: unknown; result?: unknown }).output ??
    (part as { result?: unknown }).result;
  if (typeof raw === "string") return raw;
  if (raw != null) {
    try {
      const obj = raw as Record<string, unknown>;
      const nested = obj.plan ?? obj.markdown ?? obj.summary ?? obj.text;
      if (typeof nested === "string") return nested;
    } catch {
      // fall through to empty
    }
  }
  return "";
}

/** Resolve the full plan markdown, preferring input but falling back to output. */
function resolvePlanMarkdown(plan: Plan, part: PlanToolPart): string {
  const fromInput = (plan.summary ?? "").trim();
  if (fromInput) return plan.summary ?? "";
  return outputMarkdown(part);
}

/** Open the plan in the sidebar document preview on demand (never automatic). */
function defaultPreview(plan: Plan, markdown: string): void {
  useAppStore
    .getState()
    .openDocument(plan.title || "Implementation plan", markdown);
}

/**
 * Approve the plan and start implementation: switch to build mode and send
 * the approved plan back through the orchestrator as a build request.
 */
async function defaultApprove(plan: Plan, markdown: string): Promise<void> {
  const store = useAppStore.getState();
  const trimmed = (markdown ?? "").trim();
  const content = trimmed
    ? `The implementation plan is approved. Implement it now, following the plan:\n\n${markdown}`
    : "The implementation plan is approved. Implement it now.";
  const request = { content, mode: "build" as const };
  store.setChatMode("build");
  store.setLoading(true);
  try {
    const activeThreadId = store.activeThreadId;
    const result = activeThreadId
      ? await window.mousse.orchestrator.sendToThread(activeThreadId, request)
      : await window.mousse.orchestrator.send(request);
    void result;
    const stillActive = await window.mousse.orchestrator.isTurnActive(
      activeThreadId ?? undefined,
    );
    store.setLoading(stillActive);
  } catch {
    store.setLoading(false);
  }
}

function planFileName(plan: Plan): string {
  if (!plan.id) return "plan.md";
  const slug = plan.id
    .split("/")
    .pop()
    ?.replace(/\.md$/, "");
  return slug ? `${slug}.md` : "plan.md";
}

/**
 * Inline plan approval card.
 *
 * Plans render in the transcript with the same chrome as other tool cards.
 * The full text stays collapsed until expanded; the sidebar document preview
 * is opt-in via Preview, and Approve switches to build mode and starts
 * implementation.
 */
export const PlanTool = memo(function PlanTool({
  part,
}: PlanToolProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isApproved, setIsApproved] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const input = (part.input ?? {}) as PlanToolInput;
  const plan = input.plan ?? { title: "Plan" };
  const onApprove = input.onApprove;
  const onPreview = input.onPreview;
  const approveText = input.approveLabel ?? "Approve";
  const previewText = input.previewLabel ?? "Preview";
  const isAlreadyApproved = input.approved === true || isApproved;

  // The full plan markdown lives in input, falling back to output/result
  // for real tool calls. Both collapsed and expanded states render this full
  // content — never a truncated summary excerpt.
  const markdown = resolvePlanMarkdown(plan, part);
  const hasPlan = Boolean(markdown.trim());
  const fileName = planFileName(plan);

  const isPending =
    part.state !== "output-available" && part.state !== "output-error";
  const title = isPending ? "Planning" : (plan.title ?? "Plan");

  const handleApprove = async () => {
    if (isAlreadyApproved || isSending) return;
    setIsSending(true);
    try {
      if (onApprove) {
        await onApprove();
      } else {
        await defaultApprove(plan, markdown);
      }
      setIsApproved(true);
    } finally {
      setIsSending(false);
    }
  };

  const handlePreview = () => {
    if (!hasPlan) return;
    if (onPreview) {
      void onPreview();
    } else {
      defaultPreview(plan, markdown);
    }
  };

  const previewButtonClass =
    "-mx-1 h-5 px-1.5 rounded-[4px] text-sm text-an-tool-color-muted hover:text-an-tool-color hover:bg-an-background-secondary";
  const approveButtonClass =
    "an-approve-fill h-5 px-1.5 rounded-[4px] text-sm font-medium active:scale-[0.98] transition-[filter,transform] duration-150 disabled:opacity-60";
  const toggleButtonClass =
    "-mx-2 h-5 px-1.5 rounded-[4px] text-sm text-an-tool-color-muted hover:text-an-tool-color";

  return (
    <div
      className="an-tool-chrome rounded-an-tool-border-radius border border-an-tool-border-color bg-an-tool-background overflow-hidden"
      data-tool="plan"
      data-awaiting-approval={!isAlreadyApproved ? "true" : undefined}
    >
      <div className="h-7 pl-3 pr-2.5 flex items-center justify-between">
        <div className="min-w-0 flex items-center gap-1">
          {isPending ? (
            <IconSpinner className="w-3 h-3 text-an-tool-color-muted animate-spin shrink-0" />
          ) : (
            <IconFileDescription className="w-3.5 h-3.5 text-an-tool-color-muted shrink-0" />
          )}
          <span className="text-sm text-an-tool-color-muted truncate">
            {isExpanded ? title : `${title}: ${fileName}`}
          </span>
          {!isPending && (
            <span className="shrink-0 text-sm text-an-tool-color-muted">
              · {isAlreadyApproved ? "Approved" : "Awaiting approval"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
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
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-an-tool-border-color bg-an-background pt-2">
          <div className="px-3 text-sm text-an-tool-color">
            {hasPlan ? (
              <Markdown content={markdown} />
            ) : (
              <div className="text-sm text-an-tool-color-muted">
                No plan provided.
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between pt-1.5 pb-2 pl-3.5 pr-2 border-t border-an-tool-border-color bg-an-tool-background">
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className={toggleButtonClass}
            >
              Hide detailed plan
            </button>
            <span className="inline-flex items-center gap-1.5">
              {hasPlan && (
                <button
                  type="button"
                  onClick={handlePreview}
                  title="Open the full plan in the Documents panel"
                  className={previewButtonClass}
                >
                  {previewText}
                </button>
              )}
              {!isAlreadyApproved && (
                <button
                  type="button"
                  onClick={() => void handleApprove()}
                  disabled={isSending}
                  className={approveButtonClass}
                >
                  {isSending ? "Implementing…" : approveText}
                </button>
              )}
            </span>
          </div>
        </div>
      )}
      {!isExpanded && (
        <div className="border-t border-an-tool-border-color bg-an-background pt-2">
          <div className="px-3 text-sm text-an-tool-color-muted max-h-96 overflow-y-auto">
            {hasPlan ? (
              <Markdown content={markdown} className="text-sm" />
            ) : (
              <div className="text-sm text-an-tool-color-muted">
                No plan provided.
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between pt-1.5 pb-2 pl-3.5 pr-2 border-t border-an-tool-border-color bg-an-tool-background">
            <button
              type="button"
              onClick={() => setIsExpanded(true)}
              className={toggleButtonClass}
            >
              Read detailed plan
            </button>
            <span className="inline-flex items-center gap-1.5">
              {hasPlan && (
                <button
                  type="button"
                  onClick={handlePreview}
                  title="Open the full plan in the Documents panel"
                  className={previewButtonClass}
                >
                  {previewText}
                </button>
              )}
              {!isAlreadyApproved && (
                <button
                  type="button"
                  onClick={() => void handleApprove()}
                  disabled={isSending}
                  className={approveButtonClass}
                >
                  {isSending ? "Implementing…" : approveText}
                </button>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}, areToolPropsEqual);
