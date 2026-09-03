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

/** Tool rows with their own distinct rendering that never join a group. */
const STANDALONE_TOOL_TYPES = new Set(["tool-Thinking", "tool-Question"]);

export type AssistantToolItem = {
  part: ToolPartBase;
  nestedTools?: ToolPartBase[];
};

export type AssistantMessageAnalysis = {
  /**
   * True when the message renders only groupable tool rows (no text, error,
   * thought, or question rows), so it can merge into a "Tool calls N" group.
   */
  toolsOnly: boolean;
  toolItems: AssistantToolItem[];
};

/**
 * Pure per-message analysis mirroring AssistantParts rendering rules:
 * text/error/thought/question rows disqualify grouping; TaskOutput, nested,
 * and suppressed-question parts are invisible and ignored.
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

/**
 * Partition a turn's assistant messages into render segments: runs of
 * consecutive tools-only messages (length >= 2) collapse into one
 * "Tool calls N" group; everything else renders message by message.
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
