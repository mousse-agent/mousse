import type { ReactNode } from "react";
import { IconGitHub } from "./icons";
import { isGitHubUrl, linkLabel } from "./link-label";
import { parseThreadLink } from "../../../../shared/threadLink";
import { useAppStore } from "../../../stores/appStore";

/** A short label stays on one line with its mark, so the mark never ends a line alone. */
const UNBROKEN_MAX = 24;

/** The text of a link whose content is one piece of text, else null. */
function plainText(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === "string") return children[0];
  return null;
}

/** A bare thread address reads as the thread's title; one this window does not list keeps its address. */
function ThreadTitle({ threadId, text }: { threadId: string; text: string }) {
  const title = useAppStore((state) => state.threads.find((thread) => thread.id === threadId)?.name);
  return <>{title?.trim() || text}</>;
}

/**
 * The text a thread chip shows for a link: the link's own text, or nothing (the thread's title) when its text is the
 * address itself.
 */
export function threadLinkLabel(href: string, children: ReactNode): ReactNode | undefined {
  const text = plainText(children);
  if (text === href || (text !== null && !text.trim())) return undefined;
  return children ?? undefined;
}

/**
 * What goes inside a chat link (see link-label): the GitHub mark before a link to GitHub, and the short
 * label of a bare GitHub address. Each surface keeps its own anchor and routing.
 */
export function LinkLabel({ href, children }: { href: string; children?: ReactNode }) {
  const text = plainText(children);
  const threadId = text === href ? parseThreadLink(href) : null;
  if (threadId && text !== null) return <ThreadTitle threadId={threadId} text={text} />;
  const label = text === null ? children : linkLabel(href, text);
  if (!isGitHubUrl(href)) return <>{label}</>;
  const unbroken = typeof label === "string" && label.length <= UNBROKEN_MAX;
  return (
    <span className={unbroken ? "chat-link-unbroken" : undefined}>
      <IconGitHub className="chat-link-mark" />
      {label}
    </span>
  );
}
