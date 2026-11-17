import { Image as ImageIcon } from "../../../lib/icons";
import { botFileImageUrl, useFileImage } from "../../../components/bots/BotImages";
import { botImageSource, fileNameOf } from "../../../components/bots/imageSources";
import { safeMarkdownUrl } from "../../../utils/chatLinks";
import type { MarkdownImages } from "./markdown";
import { MessageImage } from "./message-image";

/**
 * Images in a thread's reply. An image file of this computer, written as a full path or a `file:` URL, shows from
 * wherever it is (a bot's files folder, another worktree): it is read through the Files panel's preview path
 * (`fs.readAsset`), and only PNG, JPEG, GIF and WebP become a picture, never SVG. A `data:` image of those types shows
 * as it is, and a web image as it did before. Anything else shows its alt text, marked as not shown.
 */
export function ThreadMarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const source = botImageSource(src);
  if (source.kind === "file") return <ThreadFileImage path={source.path} alt={alt} />;
  if (source.kind === "data") return <MessageImage src={source.url} alt={alt} />;
  if (source.kind === "link") {
    const url = safeMarkdownUrl(source.url);
    if (url) return <MessageImage src={url} alt={alt} />;
  }
  return <NotShown label={alt} />;
}

function ThreadFileImage({ path, alt }: { path: string; alt?: string }) {
  const image = useFileImage(path);
  const label = alt?.trim() || fileNameOf(path);
  if (image?.url) return <MessageImage src={image.url} alt={label} title={path} />;
  if (image?.failed) return <NotShown label={label} title={path} />;
  return null;
}

function NotShown({ label, title }: { label?: string; title?: string }) {
  const text = label?.trim() || "Image";
  return (
    <span className="an-md-image-blocked" role="img" aria-label={`${text} (can't be shown)`} title={title ?? "This image can't be shown"}>
      <ImageIcon size={13} aria-hidden />
      <span>{text}</span>
    </span>
  );
}

/** A thread's image rule (`MarkdownImages`), kept at module scope so its parsed blocks stay cached. */
export const THREAD_IMAGES: MarkdownImages = { Image: ThreadMarkdownImage };

/** What an image's `src` in a reply opens as in the thread's preview: a file's picture once read, else the URL. */
export function threadImageUrl(src: string): string | null | undefined {
  const source = botImageSource(src);
  if (source.kind === "file") return botFileImageUrl(source.path);
  if (source.kind === "data") return source.url;
  return safeMarkdownUrl(src) || null;
}
