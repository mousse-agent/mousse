import type { ReactNode } from "react";
import { IconGitHub } from "./icons";
import { isGitHubUrl, linkLabel } from "./link-label";

/** A short label stays on one line with its mark, so the mark never ends a line alone. */
const UNBROKEN_MAX = 24;

/** The text of a link whose content is one piece of text, else null. */
function plainText(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.length === 1 && typeof children[0] === "string") return children[0];
  return null;
}

/**
 * What goes inside a chat link (see link-label): the GitHub mark before a link to GitHub, and the short
 * label of a bare GitHub address. Each surface keeps its own anchor and routing.
 */
export function LinkLabel({ href, children }: { href: string; children?: ReactNode }) {
  const text = plainText(children);
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
