import { memo, useState } from "react";
import { Streamdown } from "streamdown";
import { createCodePlugin } from "@streamdown/code";
import {
  IconCheck,
  IconChevronsDown,
  IconChevronsUp,
  IconMessagePlus,
  IconSend,
  IconTerminal2,
  IconX,
} from "@tabler/icons-react";
import { Markdown } from "../markdown";
import { IconSpinner } from "../icons";
import { areToolPropsEqual, getToolStatus } from "../utils/format-tool";
import { useQuickActionApproval } from "./quick-action-approval";

const code = createCodePlugin({
  themes: ["github-light", "github-dark"],
});

export type QuickActionToolProps = {
  part: {
    type: string;
    toolCallId?: string;
    state?: string;
    input?: {
      label?: string;
      kind?: string;
      payload?: string;
      onApprove?: () => void;
      onReject?: () => void;
      approveLabel?: string;
      rejectLabel?: string;
      approved?: boolean;
    };
    output?: unknown;
    result?: unknown;
  };
  chatStatus?: string;
};

/**
 * What pressing the created action will do, stated plainly under the payload
 * so the effect is clear at a glance. Mirrors the backend kinds in
 * QuickActionTools (`send-current` / `send-new-chat` / `bash`).
 */
function actionMeta(kind: unknown): {
  effect: string;
  Icon: typeof IconSend;
} {
  if (kind === "bash")
    return { effect: "is run in a new terminal tab", Icon: IconTerminal2 };
  if (kind === "send-new-chat")
    return { effect: "is sent in new chat", Icon: IconMessagePlus };
  return { effect: "is sent in active chat", Icon: IconSend };
}

function outcomeOf(output: unknown, isError: boolean): {
  tone: "pending" | "created" | "rejected" | "error";
  text: string;
} {
  if (isError) return { tone: "error", text: "Failed" };
  const text = typeof output === "string" ? output : "";
  if (text.startsWith("Quick action created:")) return { tone: "created", text };
  if (!text) return { tone: "pending", text: "" };
  // Every other non-empty result (rejections, dismissals, validation and
  // thread errors) means the action was NOT created — never label it created.
  return { tone: "rejected", text };
}

/**
 * Modified PlanTool for quick-action creation.
 * Header names the card ("New quick action"), the body shows the action name
 * once plus the action payload with its effect ("is sent in ..."), with
 * expand/collapse. Set input.approved to hide approval controls.
 * Kept expanded by default so the approval payload stays visible.
 *
 * Display-only: the real approve/reject gate is the pending approval
 * bridged via QuickActionApprovalContext (answered inline on this card).
 * Approval controls render only when a real decision path exists —
 * injected input.onApprove/onReject callbacks or a matching context
 * approval — so the card can never show a local decision the backend
 * later contradicts.
 */
export const QuickActionTool = memo(function QuickActionTool({
  part,
  chatStatus,
}: QuickActionToolProps) {
  const { isPending, isError } = getToolStatus(part, chatStatus);
  const input = part.input ?? {};
  // Kept expanded for approval — the payload is the decision context.
  const [isExpanded, setIsExpanded] = useState(true);

  const label =
    typeof input.label === "string" && input.label.trim()
      ? input.label.trim()
      : "Quick action";
  const { effect, Icon: KindIcon } = actionMeta(input.kind);
  const payload = typeof input.payload === "string" ? input.payload.trim() : "";
  const hasPayload = payload.length > 0;
  const isBash = input.kind === "bash";

  // Backend truth only: outcome derives from the tool result text.
  // No local optimistic decision — a card-level click must never disagree
  // with the modal approval that actually gates creation.
  const outcome = outcomeOf(
    part.output ?? part.result,
    part.state === "output-error" || isError,
  );
  const decided = outcome.tone !== "pending";

  const approveLabel = input.approveLabel ?? "Approve and create";
  const rejectLabel = input.rejectLabel ?? "Reject";
  // Inline approval bridged from the pending question (see
  // QuickActionApprovalContext) — this card is the approval UI.
  const inlineApproval = useQuickActionApproval();
  const matchesInlineApproval =
    inlineApproval !== null &&
    part.toolCallId != null &&
    inlineApproval.toolCallId === part.toolCallId &&
    !decided;
  const canApprove =
    typeof input.onApprove === "function" || matchesInlineApproval;
  const canReject =
    typeof input.onReject === "function" || matchesInlineApproval;
  // Mirrors PlanTool: input.approved hides the approval controls.
  // Controls also require a real decision path and an undecided backend.
  const showApprovalControls =
    (canApprove || canReject) && input.approved !== true && !decided;

  const handleApprove = () => {
    if (!showApprovalControls) return;
    if (typeof input.onApprove === "function") {
      input.onApprove();
    } else {
      inlineApproval?.onApprove();
    }
  };

  const handleReject = () => {
    if (!showApprovalControls) return;
    if (typeof input.onReject === "function") {
      input.onReject();
    } else {
      inlineApproval?.onReject();
    }
  };

  const approvalControls = showApprovalControls && (
    <div className="inline-flex items-center gap-1.5">
      {canReject && (
        <button
          type="button"
          onClick={handleReject}
          className="-mx-1 h-5 px-1.5 rounded-[4px] text-sm text-an-tool-color-muted hover:text-an-tool-color hover:bg-an-background-secondary"
        >
          {rejectLabel}
        </button>
      )}
      {canApprove && (
        <button
          type="button"
          onClick={handleApprove}
          className="an-approve-fill h-5 px-1.5 rounded-[4px] text-sm font-medium active:scale-[0.98] transition-[filter,transform] duration-150"
        >
          {approveLabel}
        </button>
      )}
    </div>
  );

  return (
    <div
      className="an-tool-chrome rounded-an-tool-border-radius border border-an-tool-border-color bg-an-tool-background overflow-hidden"
      data-awaiting-approval={showApprovalControls ? "true" : undefined}
    >
      <div className="h-7 pl-3 pr-2.5 flex items-center justify-between">
        <div className="min-w-0 flex items-center gap-1">
          {isPending ? (
            <IconSpinner className="w-3 h-3 text-an-tool-color-muted animate-spin shrink-0" />
          ) : outcome.tone === "created" ? (
            <IconCheck
              className="w-3.5 h-3.5 text-an-diff-added-text shrink-0"
              strokeWidth={2.5}
            />
          ) : outcome.tone === "error" ? (
            <IconX
              className="w-3.5 h-3.5 text-an-diff-removed-text shrink-0"
              strokeWidth={2.5}
            />
          ) : outcome.tone === "rejected" ? (
            <IconX
              className="w-3.5 h-3.5 text-an-warning-text shrink-0"
              strokeWidth={2.5}
            />
          ) : (
            <KindIcon className="w-3.5 h-3.5 text-an-tool-color-muted shrink-0" />
          )}
          <span className="text-sm text-an-tool-color-muted truncate">
            {isExpanded ? "New quick action" : `New quick action: ${label}`}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setIsExpanded((prev) => !prev)}
            aria-label={isExpanded ? "Collapse quick action" : "Expand quick action"}
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
          <div className="space-y-1.5">
            <div className="px-3">
              <div className="text-[10px] font-medium uppercase tracking-wider text-an-tool-color-muted">
                Name
              </div>
              <div className="text-base text-an-tool-color">{label}</div>
            </div>

            {hasPayload ? (
              <div>
                <div className="px-3 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-an-tool-color-muted">
                  {isBash && <KindIcon className="h-3 w-3 shrink-0" />}
                  Action
                </div>
                <div>
                  <div className="px-3 text-base text-an-tool-color-muted">
                  {isBash ? (
                    <div className="an-markdown an-code-no-header">
                      <Streamdown plugins={{ code }} controls={{ code: false }}>
                        {"```bash\n" +
                          (payload.length > 4000
                            ? `${payload.slice(0, 4000)}…`
                            : payload) +
                          "\n```"}
                      </Streamdown>
                    </div>
                  ) : (
                    <Markdown content={payload} className="text-base" />
                  )}
                  </div>
                </div>
                <div className="px-3 text-xs text-an-tool-color-muted">
                  {effect}
                </div>
              </div>
            ) : (
              <div className="text-sm text-an-tool-color-muted px-3">
                No content provided.
              </div>
            )}

          </div>

          <div className="mt-2 flex items-center justify-between pt-1.5 pb-2 pl-3.5 pr-2 border-t border-an-tool-border-color bg-an-tool-background">
            <button
              type="button"
              onClick={() => setIsExpanded(false)}
              className="-mx-2 h-5 px-1.5 rounded-[4px] text-sm text-an-tool-color-muted hover:text-an-tool-color"
            >
              Hide details
            </button>
            {approvalControls}
          </div>
        </div>
      )}
      {!isExpanded && (
        <div className="flex items-center justify-between py-1.5 pl-3.5 pr-2 border-t border-an-tool-border-color bg-an-tool-background">
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="-mx-2 h-5 px-1.5 rounded-[4px] text-sm text-an-tool-color-muted hover:text-an-tool-color"
          >
            Read details
          </button>
          {approvalControls}
        </div>
      )}
    </div>
  );
}, areToolPropsEqual);
