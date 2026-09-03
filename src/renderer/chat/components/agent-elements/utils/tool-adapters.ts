import type { TimelineStep, StepState } from "../types/timeline";

function calculateDiffStatsFromPatch(
  patches: Array<{ lines?: string[] }>,
): string | undefined {
  let addedLines = 0;
  let removedLines = 0;

  for (const patch of patches) {
    if (!patch.lines) continue;
    for (const line of patch.lines) {
      if (line.startsWith("+")) addedLines++;
      else if (line.startsWith("-")) removedLines++;
    }
  }

  if (addedLines === 0 && removedLines === 0) return undefined;

  const parts: string[] = [];
  if (addedLines > 0) parts.push(`+${addedLines}`);
  if (removedLines > 0) parts.push(`-${removedLines}`);
  return parts.join(" ");
}

function getDiffLinesFromPatch(
  patches: Array<{ lines?: string[] }>,
): { type: "add" | "remove" | "context"; content: string }[] {
  const result: { type: "add" | "remove" | "context"; content: string }[] = [];

  for (const patch of patches) {
    if (!patch.lines) continue;
    for (const line of patch.lines) {
      if (line.startsWith("+")) {
        result.push({ type: "add", content: line.slice(1) });
      } else if (line.startsWith("-")) {
        result.push({ type: "remove", content: line.slice(1) });
      } else if (line.startsWith(" ")) {
        result.push({ type: "context", content: line.slice(1) });
      }
    }
  }

  return result;
}

export function mapToolStateToStepState(
  aiState: "partial-call" | "call" | "result",
): StepState {
  return aiState === "result" ? "complete" : "animating";
}

/**
 * Map a UIMessage tool part state to an invocation state. `output-error`
 * counts as finished ("result") so failed calls render their error UI
 * instead of shimmering forever as if still running.
 */
export function mapPartStateToInvocationState(
  state: unknown,
): "partial-call" | "call" | "result" {
  return state === "output-available" || state === "output-error"
    ? "result"
    : state === "input-streaming"
      ? "partial-call"
      : "call";
}

export function mapToolNameToVariant(
  toolName: string,
): "thinking" | "action" | "search" | undefined {
  const lower = toolName.toLowerCase();
  if (lower === "thinking" || lower === "reasoning") return "thinking";
  if (
    lower === "websearch" ||
    lower === "web_search" ||
    lower === "grep" ||
    lower === "glob" ||
    lower === "webfetch" ||
    lower === "web_fetch"
  )
    return "search";
  return undefined;
}

// File tools across backends name the path arg differently (Claude Code uses
// `file_path`, Pi coding tools use `path`). Check every known key so headers
// can show "Created <filename>" / "Edited <filename>".
export function extractFilePathArg(
  args: Record<string, any> | undefined,
): string | undefined {
  if (!args) return undefined;
  const raw = args.file_path ?? args.path ?? args.filePath ?? args.file;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function extractToolDetail(
  toolName: string,
  args: Record<string, any>,
): string {
  switch (toolName) {
    case "Bash":
      return args?.command ? String(args.command).slice(0, 80) : "";
    case "Edit":
    case "Write":
    case "Read": {
      const filePath = extractFilePathArg(args);
      return filePath ? (filePath.split("/").pop() ?? "") : "";
    }
    case "Grep":
      return args?.pattern ? String(args.pattern) : "";
    case "Glob":
      return args?.pattern ? String(args.pattern) : "";
    case "WebSearch":
    case "web_search":
      return args?.query ? String(args.query) : "";
    case "WebFetch":
    case "web_fetch":
      return args?.url ? String(args.url).slice(0, 60) : "";
    default:
      return "";
  }
}

export function mapToolInvocationToStep(
  toolCallId: string,
  toolInvocation: {
    toolName: string;
    args?: Record<string, any>;
    state: "partial-call" | "call" | "result";
    result?: any;
  },
): Extract<TimelineStep, { type: "tool-call" }> {
  const { toolName, args = {}, result } = toolInvocation;
  const displayToolName =
    toolName === "PlanWrite"
      ? "Plan"
      : toolName === "TodoWrite"
        ? "Todo"
        : toolName;
  const detail = extractToolDetail(toolName, args);

  const step: Extract<TimelineStep, { type: "tool-call" }> = {
    id: toolCallId,
    type: "tool-call",
    toolName: displayToolName,
    toolDetail: detail,
    duration: Number.MAX_SAFE_INTEGER,
    toolVariant: mapToolNameToVariant(toolName),
  };

  if (toolName === "Bash") {
    step.bashCommand = args?.command ? String(args.command) : undefined;
    if (toolInvocation.state === "result" && result) {
      if (typeof result === "string") {
        step.bashOutput = result;
        step.bashSuccess = true;
      } else if (typeof result === "object") {
        const stdout =
          typeof result?.stdout === "string"
            ? result.stdout
            : typeof result?.output === "string"
              ? result.output
              : "";
        const stderr = typeof result?.stderr === "string" ? result.stderr : "";
        step.bashOutput = [stdout, stderr]
          .filter(Boolean)
          .join(stdout && stderr ? "\n" : "");
        const exitCode = result?.exitCode ?? result?.exit_code;
        step.bashSuccess = exitCode === undefined ? true : exitCode === 0;
      } else {
        step.bashOutput = JSON.stringify(result);
        step.bashSuccess = true;
      }
    }
  }

  if (toolName === "Edit" || toolName === "Write" || toolName === "Read") {
    step.filePath = extractFilePathArg(args);
  }

  if (toolName === "Write") {
    const content =
      typeof result?.content === "string"
        ? result.content
        : typeof args?.content === "string"
          ? args.content
          : "";

    if (content) {
      const lines = content.split("\n");
      step.diffStats = `+${lines.length}`;
      step.diffLines = lines.map((line: string) => ({
        type: "add",
        content: line,
      }));
    }
  }

  if (toolName === "Edit") {
    if (Array.isArray(result?.structuredPatch)) {
      step.diffStats = calculateDiffStatsFromPatch(result.structuredPatch);
      step.diffLines = getDiffLinesFromPatch(result.structuredPatch);
    } else if (Array.isArray(args?.edits)) {
      // Pi edit tool sends `{ path, edits: [{ oldText, newText }] }` — turn
      // each side into diff lines so the card can render the change.
      const removedLines: string[] = [];
      const addedLines: string[] = [];
      for (const edit of args.edits) {
        if (edit && typeof edit.oldText === "string") {
          removedLines.push(...edit.oldText.split("\n"));
        }
        if (edit && typeof edit.newText === "string") {
          addedLines.push(...edit.newText.split("\n"));
        }
      }
      const parts: string[] = [];
      if (addedLines.length > 0) parts.push(`+${addedLines.length}`);
      if (removedLines.length > 0) parts.push(`-${removedLines.length}`);
      if (parts.length > 0) {
        step.diffStats = parts.join(" ");
        step.diffLines = [
          ...removedLines.map(
            (content): { type: "remove"; content: string } => ({
              type: "remove",
              content,
            }),
          ),
          ...addedLines.map(
            (content): { type: "add"; content: string } => ({
              type: "add",
              content,
            }),
          ),
        ];
      }
    }
  }

  if (
    toolName === "WebSearch" ||
    toolName === "web_search" ||
    toolName === "Grep" ||
    toolName === "Glob"
  ) {
    step.searchQuery =
      (args?.query ?? args?.pattern)
        ? String(args?.query ?? args?.pattern)
        : undefined;
    step.searchSource =
      toolName === "WebSearch" || toolName === "web_search" ? "web" : "code";
  }

  if (
    toolName.toLowerCase() === "thinking" ||
    toolName.toLowerCase() === "reasoning"
  ) {
    step.thoughtContent =
      typeof args?.thought === "string"
        ? args.thought
        : typeof result === "string"
          ? result
          : undefined;
  }

  return step;
}
