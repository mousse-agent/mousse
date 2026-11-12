import type { UIMessage } from "ai";
import type { LightboxImage } from "./image-lightbox";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The file name an attached image part carries, if any. */
export function getImageNameFromPart(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const name = part.filename ?? part.name ?? part.fileName;
  return typeof name === "string" && name.trim() ? name : undefined;
}

export function getImageUrlFromPart(part: unknown): string | null {
  if (!isRecord(part)) return null;
  const type = part.type;
  if (typeof type !== "string") return null;

  if (type === "image") {
    const imagePart = part as { url?: string; image?: string };
    return imagePart.url ?? imagePart.image ?? null;
  }

  if (type === "data-image") {
    const dataPart = part as { data?: { url?: string } };
    return dataPart.data?.url ?? null;
  }

  if (type === "file") {
    const filePart = part as {
      mimeType?: string;
      mediaType?: string;
      url?: string;
      data?: string;
    };
    // The adapter emits AI SDK standard `mediaType`; be lenient and accept
    // legacy `mimeType` too.
    const mimeType = filePart.mimeType ?? filePart.mediaType;
    if (mimeType?.startsWith("image/")) {
      if (filePart.url) return filePart.url;
      if (filePart.data) {
        return `data:${mimeType};base64,${filePart.data}`;
      }
    }
  }

  return null;
}

/** The images attached to a prompt, in the order its tiles show them, with the names they were sent with. */
export function userMessageImageTiles(message: UIMessage): Array<{ url: string; name?: string }> {
  const images: Array<{ url: string; name?: string }> = [];
  for (const part of message.parts ?? []) {
    const url = getImageUrlFromPart(part);
    if (url) images.push({ url, name: getImageNameFromPart(part) });
  }
  const attachments = (message as { experimental_attachments?: unknown }).experimental_attachments;
  if (Array.isArray(attachments)) {
    for (const att of attachments as Array<{ contentType?: string; url?: string; name?: string }>) {
      if (att.contentType?.startsWith("image/") && att.url) images.push({ url: att.url, name: att.name || undefined });
    }
  }
  return images;
}

/** A prompt's attached image as the preview shows it. */
export function userMessageImageId(message: UIMessage, index: number): string {
  return `${message.id}-img-${index}`;
}

/** The images attached to a prompt, in the order its tiles show them. */
export function userMessageImages(message: UIMessage): LightboxImage[] {
  return userMessageImageTiles(message).map(({ url, name }, i) => ({ id: userMessageImageId(message, i), url, filename: name ?? `Image ${i + 1}` }));
}

const CODE = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\n]*`/g;
const IMAGE = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]*)>|([^\s()]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

/** The images a Markdown text shows (`![alt](src)`), in order, leaving out examples in code. */
export function markdownImages(text: string): Array<{ src: string; alt?: string }> {
  if (!text.includes("![")) return [];
  const images: Array<{ src: string; alt?: string }> = [];
  for (const match of text.replace(CODE, "").matchAll(IMAGE)) {
    const src = (match[2] ?? match[3] ?? "").trim();
    if (src) images.push({ src, alt: match[1]?.trim() || undefined });
  }
  return images;
}

/** One image of a Markdown text: its URL is its id, as an image in a reply knows only its URL. */
export function markdownLightboxImages(text: string, resolve: (src: string) => string | null | undefined): LightboxImage[] {
  const images: LightboxImage[] = [];
  for (const { src, alt } of markdownImages(text)) {
    const url = resolve(src);
    if (url) images.push({ id: url, url, filename: alt });
  }
  return images;
}

/**
 * Every image a thread shows, in display order: those attached to each prompt (steers too), then those in
 * the reply's text, folded work included. Images that only a tool card draws are left out (they open alone).
 * An image shown twice (the same URL) is in the set once, where it first shows.
 */
export function collectThreadImages(
  messages: readonly UIMessage[],
  resolve: (src: string) => string | null | undefined = (src) => src,
): LightboxImage[] {
  const images: LightboxImage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      images.push(...userMessageImages(message));
    } else if (message.role === "assistant") {
      for (const part of message.parts ?? []) {
        if (part.type === "text" && typeof part.text === "string") images.push(...markdownLightboxImages(part.text, resolve));
      }
    }
  }
  const seen = new Set<string>();
  return images.filter((image) => !seen.has(image.url) && Boolean(seen.add(image.url)));
}

/** Where the opened image sits in the set: by its id, else the first with its URL; -1 when it is not in it. */
export function indexInGallery(images: readonly LightboxImage[], image: LightboxImage): number {
  const byId = images.findIndex((candidate) => candidate.id === image.id);
  return byId >= 0 ? byId : images.findIndex((candidate) => candidate.url === image.url);
}
