import { createContext, useContext } from "react";
import type { UIMessage } from "ai";
import type { PendingUserQuestions } from "../../../../../shared/types";

/**
 * Inline approval for agent-created quick actions.
 *
 * The daemon gates `create_quick_action` on `userQuestionService`, which the
 * renderer would otherwise show as a generic question modal. For quick
 * actions the modified PlanTool card (`QuickActionTool`) is the approval UI
 * instead, so this context bridges the pending question (requestId) to the
 * matching inline card (toolCallId).
 */
export type QuickActionApproval = {
  requestId: string;
  toolCallId: string;
  label: string;
  onApprove: () => void;
  onReject: () => void;
};

export const QuickActionApprovalContext =
  createContext<QuickActionApproval | null>(null);

export function useQuickActionApproval(): QuickActionApproval | null {
  return useContext(QuickActionApprovalContext);
}

/** Backend prompt shape: `Create quick action "<label>" (<kind>)? ...` */
export function parseQuickActionApprovalPrompt(prompt: unknown): string | null {
  if (typeof prompt !== "string") return null;
  const match = prompt.match(/^Create quick action "(.*)" \(/s);
  return match ? match[1] : null;
}

export function isQuickActionApproval(
  pending: PendingUserQuestions | null | undefined,
): boolean {
  if (!pending || pending.questions.length !== 1) return false;
  const question = pending.questions[0];
  return (
    question.id === "approval" &&
    parseQuickActionApprovalPrompt(question.prompt) !== null
  );
}

type QuickActionPartLike = {
  type?: unknown;
  toolCallId?: unknown;
  input?: { label?: unknown };
  output?: unknown;
  result?: unknown;
};

function asQuickActionPart(message: UIMessage): {
  part: QuickActionPartLike;
  toolCallId: string;
  label: string;
  decided: boolean;
} | null {
  const parts = (message as unknown as { parts?: unknown }).parts;
  if (!Array.isArray(parts) || parts.length === 0) return null;
  // Approval belongs to the latest quick-action part in the message.
  for (let p = parts.length - 1; p >= 0; p -= 1) {
    const part = parts[p] as QuickActionPartLike;
    if (!part || part.type !== "tool-QuickAction") continue;
    const toolCallId =
      typeof part.toolCallId === "string" && part.toolCallId
        ? part.toolCallId
        : (message as unknown as { id?: unknown }).id;
    if (typeof toolCallId !== "string" || !toolCallId) continue;
    const label =
      typeof part.input?.label === "string" ? part.input.label.trim() : "";
    const decided = part.output != null || part.result != null;
    return { part, toolCallId, label, decided };
  }
  return null;
}

/**
 * Find the inline card awaiting this approval: latest undecided
 * tool-QuickAction part, preferring a label match with the approval prompt.
 * Returns null when no card is waiting (caller should keep the generic
 * question UI so the approval is never stranded with no UI at all).
 */
export function findQuickActionCardForApproval(
  messages: UIMessage[],
  pending: PendingUserQuestions | null | undefined,
): { toolCallId: string; label: string } | null {
  if (!isQuickActionApproval(pending) || messages.length === 0) return null;
  const expectedLabel = parseQuickActionApprovalPrompt(
    (pending as PendingUserQuestions).questions[0].prompt,
  );
  let fallback: { toolCallId: string; label: string } | null = null;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const found = asQuickActionPart(messages[i]);
    if (!found || found.decided) continue;
    const candidate = { toolCallId: found.toolCallId, label: found.label };
    if (expectedLabel !== null && found.label === expectedLabel) {
      return candidate;
    }
    // Keep scanning for a label match, but remember the newest undecided
    // card in case labels diverge (truncation, renames).
    fallback ??= candidate;
  }
  return fallback;
}
