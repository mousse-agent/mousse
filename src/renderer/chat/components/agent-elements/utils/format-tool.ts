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
  // A typed item that ended without a result says so in its output, whatever the chat is doing now.
  const endedInterrupted = part.output?.interrupted === true;
  const isSuccess =
    part.state === "output-available" && !isError && !endedInterrupted;
  const isPending = basePending && chatStatus === "streaming";
  const isInterrupted =
    endedInterrupted ||
    (basePending && chatStatus !== "streaming" && chatStatus !== undefined);

  return { isPending, isError, isSuccess, isInterrupted };
}

/**
 * Heading for a thinking row: first non-empty line of the thought content,
 * truncated. Shown beside the thinking icon, and as an activity-group title.
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

/**
 * One line for the newest part of a thought. A thought made of titled
 * summaries ("**Title**" lines, as Codex sends them) gives its last title;
 * any other gives the first line of its last paragraph.
 */
export function latestThoughtHeading(content: string | undefined): string {
  if (!content?.trim()) return "";
  const lines = content.split("\n").map((line) => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^(\*\*|__)[^*_].*\1$/.test(lines[index]!)) {
      return thoughtHeading(lines[index]);
    }
  }
  const paragraphs = content.split(/\n\s*\n/).filter((block) => block.trim());
  return thoughtHeading(paragraphs[paragraphs.length - 1]);
}

/**
 * Characters of a live thought kept for its one line: more than any row shows. The row cuts what does not fit at
 * the start (`an-live-thought`), so the newest words are what shows at any width.
 */
const LIVE_THOUGHT_CHARS = 160;

/** The newest paragraph of a thought being written, whole, in plain text: the live line's tooltip and what is read out. */
export function liveThoughtText(content: string | undefined): string {
  if (!content?.trim()) return "";
  const paragraphs = content.split(/\n\s*\n/).filter((block) => block.trim());
  const latest = paragraphs[paragraphs.length - 1]!
    .split("\n")
    .map((line) => line.trim().replace(/^#{1,6}\s+/, "").replace(/^>\s?/, ""))
    .filter(Boolean)
    .join(" ");
  return stripInlineMarkdown(latest).replace(/(\*\*|__)/g, "").replace(/\s+/g, " ").trim();
}

/**
 * The thought as it is being written, for its one live line: the newest paragraph in plain text (a title's
 * markers dropped, even one still open), and of a long one its end, where the words arrive. Empty while the
 * thought has no text.
 */
export function liveThoughtLine(content: string | undefined): string {
  const plain = liveThoughtText(content);
  if (plain.length <= LIVE_THOUGHT_CHARS) return plain;
  const tail = plain.slice(plain.length - LIVE_THOUGHT_CHARS);
  // Start the tail at a word.
  const space = tail.indexOf(" ");
  return `…${space > 0 && space < 24 ? tail.slice(space + 1) : tail}`;
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
