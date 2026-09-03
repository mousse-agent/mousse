type CachedToolState = {
  state: string | undefined;
  inputJson: string;
  outputJson: string;
};

const toolStateCache = new Map<string, CachedToolState>();

function getToolStateSnapshot(part: any): CachedToolState {
  return {
    state: part.state,
    inputJson: JSON.stringify(part.input || {}),
    outputJson: JSON.stringify(part.output || {}),
  };
}

function hasToolStateChanged(toolCallId: string, part: any): boolean {
  const cached = toolStateCache.get(toolCallId);
  const current = getToolStateSnapshot(part);

  if (!cached) {
    toolStateCache.set(toolCallId, current);
    return true;
  }

  const changed =
    cached.state !== current.state ||
    cached.inputJson !== current.inputJson ||
    cached.outputJson !== current.outputJson;

  if (changed) {
    toolStateCache.set(toolCallId, current);
  }

  return changed;
}

function arePartsEqual(prev: any, next: any): boolean {
  if (prev.toolCallId !== next.toolCallId) return false;
  if (prev.type !== next.type) return false;

  const toolCallId = next.toolCallId;
  if (!toolCallId) {
    return prev.state === next.state;
  }

  const changed = hasToolStateChanged(toolCallId, next);
  return !changed;
}

function isToolCompleted(part: any): boolean {
  if (part.output !== undefined && part.output !== null) return true;
  if (part.state === "error") return true;
  if (part.state === "result") return true;
  return false;
}

/** Deep compare function for tool part props. Used with React.memo(). */
export function areToolPropsEqual(
  prevProps: { part: any; chatStatus?: string },
  nextProps: { part: any; chatStatus?: string },
): boolean {
  const partsEqual = arePartsEqual(prevProps.part, nextProps.part);
  if (!partsEqual) return false;
  if (isToolCompleted(nextProps.part)) return true;
  if (prevProps.chatStatus !== nextProps.chatStatus) return false;
  return true;
}

/** Get tool status from part state */
export function getToolStatus(part: any, chatStatus?: string) {
  const basePending =
    part.state !== "output-available" && part.state !== "output-error";
  const isError =
    part.state === "output-error" ||
    (part.state === "output-available" && part.output?.success === false);
  const isSuccess = part.state === "output-available" && !isError;
  const isPending = basePending && chatStatus === "streaming";
  const isInterrupted =
    basePending && chatStatus !== "streaming" && chatStatus !== undefined;

  return { isPending, isError, isSuccess, isInterrupted };
}

/**
 * Heading for a Thought row: first non-empty line of the thought content,
 * truncated. Rendered at lower opacity after the "Thought" label.
 */
export function thoughtHeading(content: string | undefined): string {
  if (!content) return "";
  const firstLine =
    content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const plainText = stripInlineMarkdown(
    firstLine.replace(/^#{1,6}\s+/, "").replace(/^>\s?/, ""),
  ).trim();
  if (plainText.length <= 64) return plainText;
  return `${plainText.slice(0, 61).trimEnd()}...`;
}

/** Remove inline markdown formatting, keeping the readable text. */
function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(^|[\s(])(\*|_)([^*_]+)\2/g, "$1$3")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/**
 * One-line command summary for the Bash card header: collapsed whitespace,
 * truncated. Empty when the command is unknown (old transcripts) so the
 * header falls back to a bare Ran/Failed label instead of a fake command.
 */
export function extractCommandSummary(cmd: string): string {
  const collapsed = cmd.replace(/\s+/g, " ").trim();
  if (collapsed.length <= 64) return collapsed;
  return `${collapsed.slice(0, 61).trimEnd()}...`;
}

/**
 * Labels for a SearchTool row. Always names the tool and query — a bare
 * "Found 0 results" doesn't say what ran.
 */
export function formatSearchRowLabels(
  toolName: string | undefined,
  query: string | undefined,
  totalResults: number,
): { completeLabel: string; detail?: string } {
  const tool = toolName?.trim() || "Search";
  const cleanQuery = query?.trim();
  const detail = cleanQuery ? `${tool} \u201C${cleanQuery}\u201D` : tool;
  if (totalResults > 0) {
    return {
      completeLabel: `Found ${totalResults} ${totalResults === 1 ? "result" : "results"}`,
      detail,
    };
  }
  return { completeLabel: "No matches", detail };
}
