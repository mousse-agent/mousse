import { createContext, memo, useContext, useState } from "react";
import type { UIMessage } from "ai";
import { ChevronDown, Edit, Shield, Terminal } from "../../../../lib/icons";
import { ALWAYS_OPTION_LABEL, ALWAYS_OPTION_NOTE } from "../../../../../shared/permissionKeys";
import type {
  PendingApprovalInfo,
  PendingUserQuestions,
  ThreadApprovalRequest,
} from "../../../../../shared/types";
import { isQuickActionApproval } from "./quick-action-approval";

/**
 * Permission requests in the transcript (#416).
 *
 * A provider's, the Pi agent's or a Mousse tool's request to run a command or change files shows
 * inline in the turn, at the point the agent asked, with Approve and Deny (and "Always for this
 * thread" where the request offers it). Agent questions keep the question dialog.
 *
 * Each request is a synthetic assistant message carrying one `data-permission-request` part, placed
 * among the turn's messages by the time it was asked, so it stays inside the turn that asked it.
 */

export const PERMISSION_REQUEST_PART = "data-permission-request";

export type PermissionRequestData = {
  requestId: string;
  action: ThreadApprovalRequest["action"];
  prompt: string;
  status: ThreadApprovalRequest["status"];
  decision?: ThreadApprovalRequest["decision"];
  scope?: ThreadApprovalRequest["scope"];
  answeredBy?: ThreadApprovalRequest["answeredBy"];
  cancelReason?: string;
};

/** The option ids of a waiting request: allow once, allow always (when offered) and deny. */
export type PermissionOptions = { allow: string; always?: string; deny: string };

/** What the inline row of a waiting permission request needs to answer it. */
export type PermissionRequestControls = {
  options: PermissionOptions;
  approval?: PendingApprovalInfo;
  onAnswer: (optionId: string) => void;
};

/** The waiting permission requests this client can answer, by request id. */
export const PermissionRequestContext = createContext<
  Readonly<Record<string, PermissionRequestControls>>
>({});

export function usePermissionRequest(requestId: string): PermissionRequestControls | null {
  return useContext(PermissionRequestContext)[requestId] ?? null;
}

/** An answer given here that the saved list does not show yet. */
export type LocalPermissionAnswer = { decision: "allow" | "reject"; scope?: "once" | "always" };

/**
 * The answer options of a pending permission request, by the decision each one means; null when
 * `pending` is not one (an agent question, a quick action, or a request whose options say nothing
 * about allowing and denying), which keeps the question dialog.
 */
export function permissionRequestOptions(
  pending: PendingUserQuestions | null | undefined,
): PermissionOptions | null {
  if (!pending || pending.questions.length !== 1) return null;
  if (isQuickActionApproval(pending)) return null;
  const options = pending.questions[0]!.options;
  const allow = options.find((option) => option.decision === "allow" && option.scope !== "always");
  const always = options.find((option) => option.decision === "allow" && option.scope === "always");
  const deny = options.find((option) => option.decision === "reject");
  if (!allow || !deny) return null;
  return { allow: allow.id, ...(always ? { always: always.id } : {}), deny: deny.id };
}

function readTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function requestMessage(data: PermissionRequestData, createdAt: string | undefined): UIMessage {
  return {
    id: `permission:${data.requestId}`,
    role: "assistant",
    ...(createdAt ? { createdAt } : {}),
    parts: [{ type: PERMISSION_REQUEST_PART, data } as unknown as UIMessage["parts"][number]],
  } as unknown as UIMessage;
}

/**
 * The transcript with the thread's permission requests in it. A saved request goes after the last
 * message that came before it was asked, so it sits in the turn that asked it, under the call it is
 * about. A waiting request the saved list does not have yet goes at the end: it is being asked now.
 * `answered` holds answers given here that the saved list does not show yet.
 */
export function withPermissionRequests(
  messages: UIMessage[],
  saved: readonly ThreadApprovalRequest[],
  waiting: readonly PendingUserQuestions[] = [],
  answered: Readonly<Record<string, LocalPermissionAnswer>> = {},
): UIMessage[] {
  const withAnswer = (data: PermissionRequestData): PermissionRequestData => {
    const local = data.status === "pending" ? answered[data.requestId] : undefined;
    return local ? { ...data, status: "answered", decision: local.decision, ...(local.scope ? { scope: local.scope } : {}) } : data;
  };
  const placed: Array<{ at: number; message: UIMessage }> = [];
  const known = new Set<string>();
  for (const request of saved) {
    known.add(request.requestId);
    const at = readTime(request.createdAt);
    if (at == null) continue;
    placed.push({
      at,
      message: requestMessage(
        withAnswer({
          requestId: request.requestId,
          action: request.action,
          prompt: request.prompt,
          status: request.status,
          ...(request.decision ? { decision: request.decision } : {}),
          ...(request.scope ? { scope: request.scope } : {}),
          ...(request.answeredBy ? { answeredBy: request.answeredBy } : {}),
          ...(request.cancelReason ? { cancelReason: request.cancelReason } : {}),
        }),
        request.createdAt,
      ),
    });
  }
  const trailing = waiting
    .filter((pending) => !known.has(pending.requestId) && permissionRequestOptions(pending))
    .map((pending) =>
      requestMessage(
        withAnswer({ requestId: pending.requestId, action: "tool", prompt: pending.questions[0]!.prompt, status: "pending" }),
        undefined,
      ),
    );
  if (placed.length === 0 && trailing.length === 0) return messages;
  // A request asked before the first message shown (an older part of a long thread) is left out.
  const firstAt = messages.length ? readTime((messages[0] as { createdAt?: unknown }).createdAt) : null;
  const shown = (entry: { at: number }) => firstAt == null || entry.at >= firstAt;
  const out: UIMessage[] = [];
  let next = 0;
  for (const message of messages) {
    const at = readTime((message as { createdAt?: unknown }).createdAt);
    while (next < placed.length && at != null && placed[next]!.at < at) {
      if (shown(placed[next]!)) out.push(placed[next]!.message);
      next += 1;
    }
    out.push(message);
  }
  for (; next < placed.length; next += 1) {
    if (shown(placed[next]!)) out.push(placed[next]!.message);
  }
  return trailing.length ? [...out, ...trailing] : out;
}

export function isPermissionRequestPart(
  part: unknown,
): part is { type: typeof PERMISSION_REQUEST_PART; data: PermissionRequestData } {
  return Boolean(
    part &&
      typeof part === "object" &&
      (part as { type?: unknown }).type === PERMISSION_REQUEST_PART &&
      (part as { data?: unknown }).data,
  );
}

/** Whether the message is a permission request still waiting for an answer. */
export function isWaitingPermissionRequest(message: UIMessage | undefined): boolean {
  const part = message?.parts?.[0];
  return isPermissionRequestPart(part) && part.data.status === "pending";
}

/**
 * The request in one short line: what it would do ("Run", "Edit", "Use") and to what (the command,
 * the file), read from the saved prompt. The prompt's first line asks the question; what follows is
 * the command, a path or the tool's input.
 */
export function permissionSummary(
  prompt: string,
  action: PermissionRequestData["action"],
): { verb: string; target: string } {
  const lines = prompt.split("\n").map((line) => line.trim()).filter(Boolean);
  const questionAt = Math.max(0, lines.findIndex((line) => line.endsWith("?")));
  const question = lines[questionAt] ?? "";
  const rest = lines.slice(questionAt + 1);
  const verbOf = (kind: PermissionRequestData["action"]) =>
    kind === "command" ? "Run" : kind === "edit" ? "Edit" : "Use";
  // What the question names: "Allow Codex to edit a.ts, b.ts?", "Allow Pi to run this command?", "Allow Claude Code to run a command (Bash)?".
  const asked = question.match(/^Allow .+? to (run|edit|write|use) (.+)\?$/i);
  const kind: PermissionRequestData["action"] =
    action !== "tool"
      ? action
      : asked?.[1]?.toLowerCase() === "run"
        ? "command"
        : asked && /^(edit|write)$/i.test(asked[1]!)
          ? "edit"
          : "tool";
  const detail = rest.join("\n");
  const fromInput = detail.startsWith("{") ? inputTarget(detail) : null;
  if (fromInput) return { verb: verbOf(kind), target: fromInput };
  if (rest[0] && !detail.startsWith("{")) return { verb: verbOf(kind), target: rest[0] };
  const named = asked?.[2]?.trim();
  if (named && !/^(this command|a command|this file|files)\b/i.test(named)) {
    return { verb: verbOf(kind), target: named.replace(/^\((.*)\)$/, "$1") };
  }
  return { verb: verbOf(kind), target: question || prompt.trim() };
}

/** The command or file of a tool input written as JSON (the saved preview may be cut short). */
function inputTarget(json: string): string | null {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "notebook_path", "url", "pattern"]) {
      if (typeof value[key] === "string" && value[key]) return value[key] as string;
    }
  } catch {
    const match = json.match(/"(command|file_path|path|notebook_path|url)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (match) {
      try {
        return JSON.parse(`"${match[2]}"`) as string;
      } catch {
        return match[2]!;
      }
    }
  }
  return null;
}

/** What the request got, in one or two words; null while it waits. */
export function permissionAnswerLabel(data: PermissionRequestData): string | null {
  if (data.status === "pending") return null;
  if (data.status === "cancelled") return "Not answered";
  const byAgent = data.answeredBy?.kind === "agent";
  if (data.decision === "allow") {
    if (data.scope === "always") return "Always allowed";
    return byAgent ? "Approved by an agent" : "Approved";
  }
  return byAgent ? "Denied by an agent" : "Denied";
}

/** The lines under a waiting request: why it asks, and what answering does after a restart. */
function waitingNotes(approval: PendingApprovalInfo | undefined): string[] {
  if (!approval) return [];
  const notes: string[] = [];
  if (approval.reason) notes.push(approval.reason);
  if (approval.answerPath === "continue") {
    const tools = approval.uncertainTools?.length ? approval.uncertainTools.join(", ") : "a tool";
    notes.push(
      approval.uncertain
        ? `The agent's process ended; ${tools} may already have run. Answering continues the thread.`
        : "The agent's process ended. Answering continues the thread.",
    );
    if (approval.total && approval.total > 1) notes.push(`${approval.answered ?? 0} of ${approval.total} answered.`);
  }
  return notes;
}

const ICONS = { command: Terminal, edit: Edit, tool: Shield } as const;

/** One permission request in the turn: a short line with the answer buttons, or the answer it got. */
export const PermissionRequestRow = memo(function PermissionRequestRow({
  data,
}: {
  data: PermissionRequestData;
}) {
  const controls = usePermissionRequest(data.requestId);
  const [expanded, setExpanded] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const summary = permissionSummary(data.prompt, data.action);
  const kind = summary.verb === "Run" ? "command" : summary.verb === "Edit" ? "edit" : "tool";
  const Icon = ICONS[kind];
  const live = data.status === "pending" ? controls : null;
  const answer = permissionAnswerLabel(data);
  const tone = data.status === "answered" ? (data.decision === "allow" ? "allow" : "reject") : "none";
  const notes = live ? waitingNotes(live.approval) : [];
  const answerWith = (optionId: string) => {
    if (!live || chosen) return;
    setChosen(optionId);
    live.onAnswer(optionId);
  };
  return (
    <div
      className="permission-request"
      role="group"
      aria-label="Permission request"
      data-permission-request={data.requestId}
      data-state={live ? "waiting" : data.status}
      data-find-ignore
    >
      <div className="permission-request-row">
        <button
          type="button"
          className="permission-request-summary"
          title={data.prompt}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <Icon size={15} strokeWidth={1.8} className="permission-request-icon" aria-hidden="true" />
          <span className="permission-request-verb">{summary.verb}</span>
          <code className="permission-request-target">{summary.target}</code>
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={`permission-request-chevron${expanded ? " is-open" : ""}`}
            aria-hidden="true"
          />
        </button>
        {live ? (
          <div className="permission-request-actions">
            <button
              type="button"
              className="permission-request-btn"
              disabled={chosen !== null}
              onClick={() => answerWith(live.options.deny)}
            >
              Deny
            </button>
            {live.options.always && (
              <button
                type="button"
                className="permission-request-btn"
                title={ALWAYS_OPTION_NOTE}
                disabled={chosen !== null}
                onClick={() => answerWith(live.options.always!)}
              >
                {ALWAYS_OPTION_LABEL}
              </button>
            )}
            <button
              type="button"
              className="permission-request-btn permission-request-btn-primary"
              disabled={chosen !== null}
              onClick={() => answerWith(live.options.allow)}
            >
              Approve
            </button>
          </div>
        ) : answer ? (
          <span className={`permission-request-answer is-${tone}`}>{answer}</span>
        ) : data.status === "pending" ? (
          <span className="permission-request-answer is-none">Waiting for approval</span>
        ) : null}
      </div>
      {notes.map((note) => (
        <p key={note} className="permission-request-note">{note}</p>
      ))}
      {expanded && <pre className="permission-request-full">{data.prompt}</pre>}
    </div>
  );
});
