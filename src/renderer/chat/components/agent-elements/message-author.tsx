import { authorInitial } from "../../../../shared/humanAuthor";
import { paletteColorFor } from "../../../lib/profilePalette";

/** Who wrote a message, as the transcript adapter puts it in the message's metadata. */
export interface MessageAuthor {
  user: string;
  name: string;
}

/** The author a message's metadata names, or undefined for the account's owner (and anything malformed). */
export function messageAuthor(metadata: unknown): MessageAuthor | undefined {
  const author = (metadata as { author?: { user?: unknown; name?: unknown } } | undefined)?.author;
  if (typeof author?.user !== "string" || !author.user || typeof author.name !== "string" || !author.name) return undefined;
  return { user: author.user, name: author.name };
}

/** A small initial avatar and the name of a person other than the owner who wrote a message. */
export function MessageAuthorBadge({ author }: { author: MessageAuthor }) {
  return (
    <span className="chat-message-author">
      <span className="chat-message-author-avatar" style={{ background: paletteColorFor(author.user) }} aria-hidden="true">
        {authorInitial({ displayName: author.name })}
      </span>
      <span className="chat-message-author-name">{author.name}</span>
    </span>
  );
}
