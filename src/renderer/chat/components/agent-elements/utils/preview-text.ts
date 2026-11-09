/**
 * Plain text for a short preview of a message (the prompt rail's tooltip):
 * Markdown syntax dropped, the readable text kept, on one line. Only the start
 * of a long message is read, since a preview shows a few words; a message cut
 * that way ends in "…".
 *
 * Line-based and regex-only on purpose: the rail rebuilds every preview as the
 * layout moves, so a full Markdown parse per message would be too slow.
 */

/** What stands in for a fenced code block. */
export const PREVIEW_CODE_PLACEHOLDER = "[code]";
/** How much of a message is read for its preview. */
export const PREVIEW_SOURCE_CHARS = 2000;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HORIZONTAL_RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function stripInline(text: string): string {
  // Escaped characters are set aside first, so `\*` is never read as emphasis, and put back last.
  const escaped: string[] = [];
  const kept = text.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_match, char: string) => {
    escaped.push(char);
    return `${escaped.length - 1}`;
  });
  return stripSyntax(kept).replace(/(\d+)/g, (_match, index: string) => escaped[Number(index)] ?? "");
}

function stripSyntax(text: string): string {
  return (
    text
      // Images go; links keep their text.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/!\[[^\]]*\]\[[^\]]*\]/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, "$1")
      // HTML tags go; block tags leave a space between the words around them.
      .replace(/<\/?(?:br|p|div|li|ul|ol|tr|td|th|h[1-6]|blockquote|pre|table)\b[^>]*>/gi, " ")
      .replace(/<\/?[a-zA-Z][^>]*>/g, "")
      .replace(/(`+)([^`]+?)\1/g, "$2")
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?=[^\w*]|$)/g, "$1$2")
      .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?=[^\w]|$)/g, "$1$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, name: string) => {
        if (name[0] === "#") {
          const hex = name[1] === "x" || name[1] === "X";
          const code = hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
        }
        return ENTITIES[name.toLowerCase()] ?? match;
      })
  );
}

/** The readable text of `markdown` on one line, with whitespace collapsed. */
export function markdownPreviewText(markdown: string, maxChars = PREVIEW_SOURCE_CHARS): string {
  let source = markdown.replace(/\r\n?/g, "\n");
  let cut = false;
  if (source.length > maxChars) {
    // Cut at a space so no word is split.
    const at = source.lastIndexOf(" ", maxChars);
    source = source.slice(0, at > maxChars / 2 ? at : maxChars);
    cut = true;
  }
  const out: string[] = [];
  let fence: { marker: string; length: number } | null = null;
  for (const rawLine of source.split("\n")) {
    const fenceMatch = FENCE.exec(rawLine);
    if (fence) {
      if (fenceMatch && fenceMatch[1]![0] === fence.marker && fenceMatch[1]!.length >= fence.length && rawLine.trim() === fenceMatch[1]) {
        fence = null;
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      out.push(PREVIEW_CODE_PLACEHOLDER);
      continue;
    }
    if (!rawLine.trim() || HORIZONTAL_RULE.test(rawLine)) continue;
    if (rawLine.includes("|") && rawLine.includes("-") && TABLE_DIVIDER.test(rawLine)) continue;
    let line = rawLine.replace(/^\s{0,3}(>\s?)+/, "");
    line = line.replace(/^\s{0,3}#{1,6}\s+(.*?)(\s+#+)?\s*$/, "$1");
    line = line.replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "");
    if (/^\s*\|.*\|\s*$/.test(line)) {
      line = line
        .trim()
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join(" ");
    }
    line = stripInline(line).trim();
    if (line) out.push(line);
  }
  const text = out.join(" ").replace(/\s+/g, " ").trim();
  return cut && text ? `${text} …` : text;
}

/** At most `limit` words of `text`, with "…" when there were more. */
export function cappedWords(text: string, limit: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, limit).join(" ") + (words.length > limit ? "…" : "");
}
