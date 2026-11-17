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

/** The newest paragraph of a thought, whole, in plain text: the tooltip of a line that shows its headline. */
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

/** Longest headline, in code points: a row cuts it at its width well before this. */
const HEADLINE_MAX = 200;

/** Words that end in a dot without ending a sentence, lower case and without their last dot. */
const ABBREVIATIONS = new Set([
  "e.g", "i.e", "eg", "ie", "etc", "vs", "cf", "approx", "incl", "esp", "resp", "viz", "al", "fig", "no", "nos",
  "mr", "mrs", "ms", "dr", "st", "jr", "sr", "inc", "ltd", "co", "corp", "dept", "est", "min", "max", "ca",
]);

/** A paragraph's title line: `**Title**`, `__Title__` or a markdown heading. The title in plain text, or undefined. */
function titleOf(line: string): string | undefined {
  const trimmed = line.trim();
  const bold = /^(\*\*|__)(?=\S)(.+?)\1[:.]?$/.exec(trimmed);
  if (bold) return plainLine(bold[2]!).replace(/:$/, "");
  const heading = /^#{1,6}\s+(.+)$/.exec(trimmed);
  return heading ? plainLine(heading[1]!) : undefined;
}

function plainLine(text: string): string {
  return stripInlineMarkdown(text).replace(/(\*\*|__)/g, "").replace(/\s+/g, " ").trim();
}

/** A code fence at any indent: a thought nests them in list items, and is no full markdown document. */
const FENCE_LINE = /^\s*(`{3,}|~{3,})(.*)$/;

/**
 * Which of `lines` belong to a fenced code block, its fence lines included. A fence still open at the end (being
 * written) runs to the last line.
 */
function fencedLines(lines: readonly string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const match = FENCE_LINE.exec(line);
    if (fence === null) {
      if (match) fence = match[1]!;
      return fence !== null;
    }
    if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) fence = null;
    return true;
  });
}

/** `text` cut to `max` code points (never inside a surrogate pair), with an ellipsis when cut. */
function cutCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("").trimEnd()}…`;
}

/**
 * Where the first sentence of `text` ends (the index after its closing mark), or -1 while it has not ended. A sentence
 * ends at `.`, `?` or `!` (with any closing quotes, brackets or emphasis after it) followed by white space or the end.
 * It does not end inside inline code, on an abbreviation ("e.g.", "etc.", "vs."), on a single initial, or on a dot
 * inside a name or path ("config.ts", "v1.2"), which has no space after it.
 */
function firstSentenceEnd(text: string): number {
  let inCode = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode || (char !== "." && char !== "?" && char !== "!")) continue;
    let end = index + 1;
    while (end < text.length && /["'”’)\]*_]/.test(text[end]!)) end += 1;
    if (end < text.length && !/\s/.test(text[end]!)) continue;
    if (char === ".") {
      // The word the dot closes: an abbreviation or an initial does not end the sentence; nor does "..." mid-thought.
      const word = /([\p{L}\p{N}.]*)$/u.exec(text.slice(0, index))?.[1] ?? "";
      const bare = word.toLowerCase();
      if (ABBREVIATIONS.has(bare) || /^\p{L}$/u.test(word)) continue;
    }
    return end;
  }
  return -1;
}

/**
 * A thought's headline: one still line that stands for it, used wherever a thought is summarised (the live line, a
 * finished thought's row, a group's heading). A thought written in titled sections reads as its latest title: a
 * `**Title**` or `# Heading` line heads every paragraph after it, until the next title. Text with no title above it
 * reads as its newest paragraph's first sentence. Plain text, cut by code point.
 *
 * So the line changes only when a new section or a new untitled paragraph starts (and while a paragraph's first words
 * are still arriving): a long thought moves on section by section, and never reflows with every word.
 */
export function thoughtHeadline(content: string | undefined): string {
  if (!content?.trim()) return "";
  const allLines = content.split("\n");
  const code = fencedLines(allLines);
  for (let index = allLines.length - 1; index >= 0; index -= 1) {
    // A `# comment` or a bold line in a code block is code, not a title.
    if (code[index]) continue;
    const title = titleOf(allLines[index]!);
    if (title) return cutCodePoints(title, HEADLINE_MAX);
  }
  // The newest paragraph of prose: a code block is no paragraph, so a thought that ends in code reads as the prose
  // before it.
  const prose = allLines.map((line, index) => (code[index] ? "" : line)).join("\n");
  const paragraphs = prose.split(/\n\s*\n/).filter((block) => block.trim());
  const newest = paragraphs[paragraphs.length - 1];
  if (!newest) return "";
  const lines = newest.split("\n").map((line) => line.trim()).filter(Boolean);
  // List markers and quote marks are not words of the sentence.
  const body = lines
    .map((line) => line.replace(/^>\s?/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, ""))
    .join(" ");
  const end = firstSentenceEnd(body);
  const sentence = plainLine(end === -1 ? body : body.slice(0, end));
  return cutCodePoints(sentence, HEADLINE_MAX);
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

/** How many a code or file search found (`numFiles` on its output), or undefined when it does not say. */
export function searchResultCount(output: unknown): number | undefined {
  const value = output && typeof output === "object" ? (output as { numFiles?: unknown }).numFiles : undefined;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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
