/**
 * How a link reads wherever chat text is drawn: a prompt, an agent's reply, a bot's chat. A web link
 * leads with a monochrome vector mark in the link colour (a site mark for known hosts, or a globe for
 * any other web address), and a bare GitHub address to a pull request, issue or commit reads as `#123`
 * or the short hash. `LinkLabel` draws it; Find reads the same label, so its matches line up.
 */

export type SiteMark =
  | "github"
  | "gitlab"
  | "npm"
  | "youtube"
  | "x"
  | "reddit"
  | "stackoverflow"
  | "mdn"
  | "wikipedia"
  | "google"
  | "discord"
  | "slack"
  | "figma"
  | "linear"
  | "notion"
  | "vercel"
  | "cloudflare"
  | "supabase"
  | "openai"
  | "anthropic"
  | "huggingface"
  | "hackernews"
  | "linkedin"
  | "docker"
  | "python"
  | "rust"
  | "stripe"
  | "apple"
  | "microsoft"
  | "web";

const HOST_MARKS: ReadonlyArray<[mark: Exclude<SiteMark, "web">, hosts: readonly string[]]> = [
  ["github", ["github.com", "github.io"]],
  ["gitlab", ["gitlab.com"]],
  ["npm", ["npmjs.com", "npmjs.org"]],
  ["youtube", ["youtube.com", "youtu.be"]],
  ["x", ["x.com", "twitter.com"]],
  ["reddit", ["reddit.com", "redd.it"]],
  ["stackoverflow", ["stackoverflow.com", "stackexchange.com", "superuser.com", "serverfault.com"]],
  ["mdn", ["developer.mozilla.org"]],
  ["wikipedia", ["wikipedia.org"]],
  ["google", ["google.com", "web.dev", "developers.google.com", "cloud.google.com"]],
  ["discord", ["discord.com", "discord.gg"]],
  ["slack", ["slack.com"]],
  ["figma", ["figma.com"]],
  ["linear", ["linear.app"]],
  ["notion", ["notion.so", "notion.site"]],
  ["vercel", ["vercel.com", "nextjs.org"]],
  ["cloudflare", ["cloudflare.com", "workers.dev"]],
  ["supabase", ["supabase.com", "supabase.io"]],
  ["openai", ["openai.com", "chatgpt.com"]],
  ["anthropic", ["anthropic.com", "claude.ai"]],
  ["huggingface", ["huggingface.co", "hf.co"]],
  ["hackernews", ["news.ycombinator.com"]],
  ["linkedin", ["linkedin.com"]],
  ["docker", ["docker.com"]],
  ["python", ["python.org", "pypi.org"]],
  ["rust", ["rust-lang.org", "crates.io", "docs.rs"]],
  ["stripe", ["stripe.com"]],
  ["apple", ["apple.com"]],
  ["microsoft", ["microsoft.com", "visualstudio.com", "azure.com"]],
];

function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/** The monochrome site mark for an `http(s)` address, or null for non-web links (files, threads). */
export function siteMarkForUrl(href: string): SiteMark | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  for (const [mark, domains] of HOST_MARKS) {
    if (domains.some((domain) => hostMatches(host, domain))) return mark;
  }
  return "web";
}

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
