import { parseMarkdownIntoBlocks } from "streamdown";

const MATH_FENCE_RE = /^[ \t>]*(?:`{3,}|~{3,})[ \t]*math\b/im;

/** Cheap gate: most messages have no math, and then none of the math machinery is used. */
export function mayContainMath(content: string): boolean {
  return (
    content.includes("$") ||
    content.includes("\\(") ||
    content.includes("\\[") ||
    MATH_FENCE_RE.test(content)
  );
}

const FENCE_OPEN_RE = /^([ \t>]*)(`{3,}|~{3,})([ \t]*)(\S*)/;

/**
 * While a reply streams, a ```math fence has no closing line yet and its
 * partial TeX would typeset as garbage. Relabel such a trailing fence as plain
 * text so the source shows until the fence closes.
 */
export function hideUnclosedMathFence(content: string): string {
  if (!MATH_FENCE_RE.test(content)) return content;
  let fence: { marker: string; size: number; infoStart: number; math: boolean } | null = null;
  let offset = 0;
  for (const line of content.split("\n")) {
    if (fence) {
      const trimmed = line.replace(/^[ \t>]*/, "").trimEnd();
      if (trimmed.length >= fence.size && trimmed === fence.marker.repeat(trimmed.length)) {
        fence = null;
      }
    } else {
      const open = FENCE_OPEN_RE.exec(line);
      if (open) {
        fence = {
          marker: open[2][0],
          size: open[2].length,
          infoStart: offset + open[1].length + open[2].length + open[3].length,
          math: open[4].toLowerCase() === "math",
        };
      }
    }
    offset += line.length + 1;
  }
  if (!fence?.math) return content;
  return `${content.slice(0, fence.infoStart)}text${content.slice(fence.infoStart + 4)}`;
}

/** Whether a block of Markdown ends inside a `\[` display that has not been closed. */
function endsInsideBracketDisplay(block: string): boolean {
  let open = false;
  let fenced = false;
  for (const line of block.split("\n")) {
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) fenced = !fenced;
    if (fenced) continue;
    if (open) {
      if (line.trimEnd().endsWith("\\]")) open = false;
    } else if (/^ {0,3}\\\[/.test(line) && !line.trimEnd().endsWith("\\]")) {
      open = true;
    }
  }
  return open;
}

/**
 * Streamdown renders each top-level block separately and already keeps `$$`
 * displays together. A `\[` display can be cut by blank lines or by block
 * syntax inside it (`- y`, `# z`, `=`), so glue the pieces back together.
 */
export function parseBlocksKeepingMath(markdown: string): string[] {
  const blocks: string[] = [];
  for (const block of parseMarkdownIntoBlocks(markdown)) {
    const last = blocks.length - 1;
    if (last >= 0 && endsInsideBracketDisplay(blocks[last])) blocks[last] += block;
    else blocks.push(block);
  }
  return blocks;
}
