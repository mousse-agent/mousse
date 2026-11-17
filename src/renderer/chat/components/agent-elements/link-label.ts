/**
 * How a link reads wherever chat text is drawn: a prompt, an agent's reply, a bot's chat. A link to
 * GitHub leads with the GitHub mark, and a bare address to a pull request, issue or commit reads as
 * `#123` or the short hash. `LinkLabel` draws it; Find reads the same label, so its matches line up.
 */

/** True for an address on github.com (or a subdomain). */
export function isGitHubUrl(href: string): boolean {
  try {
    const host = new URL(href).hostname.toLowerCase();
    return host === "github.com" || host.endsWith(".github.com");
  } catch {
    return false;
  }
}

/** `#123` for a pull request or issue, the short hash for a commit; otherwise null. */
export function shortGitHubLabel(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const [, , kind, id] = url.pathname.split("/").filter(Boolean);
  if ((kind === "pull" || kind === "issues") && id && /^\d+$/.test(id)) return `#${id}`;
  if (kind === "commit" && id && /^[0-9a-f]{7,40}$/i.test(id)) return id.slice(0, 7);
  return null;
}

/** The label a link shows: its own text, except a bare GitHub address (the text is the address) reads short. */
export function linkLabel(href: string, text: string): string {
  return text === href ? (shortGitHubLabel(href) ?? text) : text;
}
