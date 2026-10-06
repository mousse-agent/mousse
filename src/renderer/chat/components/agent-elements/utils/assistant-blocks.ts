import { thoughtHeading } from "./format-tool";
import { normalizeAssistantToolParts } from "./tool-part-normalizer";

export type ToolPartBase = {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: unknown;
  output?: unknown;
  result?: unknown;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isTextPart(
  part: unknown,
): part is { type: "text"; text: string } {
  return (
    isRecord(part) && part.type === "text" && typeof part.text === "string"
  );
}

export function isErrorPart(
  part: unknown,
): part is { type: "error"; title?: string; message: string } {
  return (
    isRecord(part) && part.type === "error" && typeof part.message === "string"
  );
}

export function isV5ToolPart(part: unknown): part is ToolPartBase {
  if (!isRecord(part)) return false;
  const partType = part.type;
  return (
    partType === "dynamic-tool" ||
    (typeof partType === "string" && partType.startsWith("tool-"))
  );
}

/** Rows that need their own surface and never join an activity group. */
const STANDALONE_TOOL_TYPES = new Set(["tool-Question"]);

export type AssistantToolItem = {
  part: ToolPartBase;
  nestedTools?: ToolPartBase[];
};

export type AssistantMessageAnalysis = {
  /**
   * True when the message renders only groupable activity rows (tools,
   * thoughts, and file edits; no text, error, or question rows), so it can
   * merge into one activity group.
   */
  toolsOnly: boolean;
  toolItems: AssistantToolItem[];
};

/**
 * Pure per-message analysis mirroring AssistantParts rendering rules:
 * text/error/question rows disqualify grouping; thoughts and file edits join it.
 * TaskOutput,
 * nested, and suppressed-question parts are invisible and ignored.
 */
export function analyzeAssistantMessage(
  rawParts: unknown[],
  suppressQuestionTool: boolean,
): AssistantMessageAnalysis {
  const parts = normalizeAssistantToolParts(rawParts) as unknown[];

  const taskPartIds = new Set(
    parts
      .filter(
        (p): p is ToolPartBase =>
          isV5ToolPart(p) &&
          (p.type === "tool-Task" || p.type === "tool-Agent") &&
          typeof p.toolCallId === "string",
      )
      .map((p) => p.toolCallId!),
  );
  const nestedToolsMap = new Map<string, ToolPartBase[]>();
  const nestedToolIds = new Set<string>();
  for (const part of parts) {
    if (!isV5ToolPart(part)) continue;
    if (part.type === "tool-TaskOutput") continue;
    if (!part.toolCallId || !part.toolCallId.includes(":")) continue;
    const parentId = part.toolCallId.split(":")[0];
    if (!taskPartIds.has(parentId)) continue;
    if (!nestedToolsMap.has(parentId)) {
      nestedToolsMap.set(parentId, []);
    }
    nestedToolsMap.get(parentId)!.push(part);
    nestedToolIds.add(part.toolCallId);
  }

  const toolItems: AssistantToolItem[] = [];
  for (const part of parts) {
    if (isTextPart(part)) {
      if (part.text) return { toolsOnly: false, toolItems: [] };
      continue;
    }
    if (isRecord(part) && (part.type === "data-applet" || part.type === "data-applet-pending")) return { toolsOnly: false, toolItems: [] };
    if (isErrorPart(part)) return { toolsOnly: false, toolItems: [] };
    if (!isV5ToolPart(part)) continue;
    if (part.type === "tool-TaskOutput") continue;
    if (suppressQuestionTool && part.type === "tool-Question") continue;
    if (part.toolCallId && nestedToolIds.has(part.toolCallId)) continue;
    if (STANDALONE_TOOL_TYPES.has(part.type)) {
      return { toolsOnly: false, toolItems: [] };
    }
    const toolCallId = part.toolCallId;
    const nestedTools =
      (part.type === "tool-Task" || part.type === "tool-Agent") &&
      toolCallId
        ? nestedToolsMap.get(toolCallId)
        : undefined;
    toolItems.push({ part, nestedTools });
  }

  if (toolItems.length === 0) return { toolsOnly: false, toolItems: [] };
  return { toolsOnly: true, toolItems };
}

export type TurnSegment =
  | { kind: "message"; msgIndex: number }
  | { kind: "tools"; msgIndices: number[] };

/** First non-empty line of a thinking part, or "" when it has no message. */
export function thoughtMessageFromPart(part: ToolPartBase): string {
  if (part.type !== "tool-Thinking") return "";
  const input = isRecord(part.input) ? part.input.thought : undefined;
  const output = part.output ?? part.result;
  const raw =
    typeof input === "string" && input.trim()
      ? input
      : typeof output === "string"
        ? output
        : "";
  return thoughtHeading(raw);
}

/**
 * Title for a grouped run of thoughts and tool calls: the latest thought
 * that actually has text. Empty when the run should fall back to "Tool calls".
 */
export function activityGroupLabel(items: AssistantToolItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const heading = thoughtMessageFromPart(items[index]!.part);
    if (heading) return heading;
  }
  return "";
}

/**
 * Partition a turn's assistant messages into render segments: runs of
 * consecutive activity messages (tools and thoughts, length >= 2) collapse
 * into one group; everything else renders message by message.
 */
export function partitionTurnSegments(
  toolsOnlyFlags: boolean[],
): TurnSegment[] {
  const segments: TurnSegment[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 2) {
      segments.push({ kind: "tools", msgIndices: run });
    } else {
      for (const msgIndex of run) segments.push({ kind: "message", msgIndex });
    }
    run = [];
  };
  toolsOnlyFlags.forEach((flag, msgIndex) => {
    if (flag) {
      run.push(msgIndex);
    } else {
      flush();
      segments.push({ kind: "message", msgIndex });
    }
  });
  flush();
  return segments;
}
