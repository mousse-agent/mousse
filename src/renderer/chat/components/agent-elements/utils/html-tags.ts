import { defaultRehypePlugins } from "streamdown";

/**
 * Which text in angle brackets the chat draws as HTML. Everything else (`<command>`, `<work of first task>`) shows as
 * written, in a reply (markdown.tsx) and in the prompt rail's preview of it (preview-text.ts).
 */

/** The tags the sanitizer keeps; any other tag would be dropped from the text. */
const KEPT_TAGS = new Set(
  ((defaultRehypePlugins.sanitize as unknown as [unknown, { tagNames?: string[] }])[1].tagNames ?? []).map((name) => name.toLowerCase()),
);

/** Attributes HTML writes as a bare word (`<details open>`). Any other bare word is a word of the text. */
const BARE_ATTRIBUTES = new Set([
  "async", "autofocus", "autoplay", "checked", "compact", "controls", "default", "defer", "disabled", "hidden", "inert",
  "ismap", "itemscope", "loop", "multiple", "muted", "nohref", "noshade", "novalidate", "nowrap", "open", "readonly",
  "required", "reversed", "selected",
]);

const ATTRIBUTE = /\s+([A-Za-z_:][\w.:-]*)(\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?/g;

/** One HTML open, close or self-closing tag, as Markdown reads raw HTML. */
export const HTML_TAG = /<\/?([A-Za-z][A-Za-z0-9-]*)((?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*)\s*\/?>/g;

/**
 * Whether a tag `HTML_TAG` matched is HTML the chat draws: a tag the sanitizer keeps, with no bare word that is not
 * an attribute. `<kbd>` and `<details open>` draw; `<command>`, `<a of first task>` and `<img of first task>` are text.
 */
export function isDrawnTag(name: string, attributes = ""): boolean {
  if (!KEPT_TAGS.has(name.toLowerCase())) return false;
  for (const [, attribute, value] of attributes.matchAll(ATTRIBUTE)) {
    if (!value && !BARE_ATTRIBUTES.has(attribute!.toLowerCase())) return false;
  }
  return true;
}
