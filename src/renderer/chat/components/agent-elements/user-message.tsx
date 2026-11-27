import { Fragment, memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { UIMessage } from "ai";
import { FIND_REVEAL_EVENT } from "./find/reveal";
import { cn } from "./utils/cn";
import { FileAttachment } from "./input/file-attachment";
import { ImageLightbox } from "./image-lightbox";
import { useImageGallery } from "./image-gallery";
import { userMessageImages, userMessageImageTiles } from "./image-sources";
import { imageDragItem, startDragOut } from "../../../lib/fileDragOut";
import { ChatReferencePill, REFERENCE_ICONS, openChatReference, referenceTitle } from "../../../components/ReferencePill";
import { findSentChips, sentChipName, type SentChipSpan } from "../../../../shared/inlineAttachments";
import { parseChatReference, type ChatReference } from "../../../../shared/chatReferences";
import { openFileInPanel, openLinkedThread, routeLink } from "../../../utils/chatLinks";
import { parseThreadLink, threadLink } from "../../../../shared/threadLink";
import { LinkLabel, threadLinkLabel } from "./link-label-view";
import { ThreadChip } from "../../../components/ThreadChip";
import { promptSegments } from "./prompt-links";
import { WithSentQuotes } from "../../../components/QuotePill";
import { Bot, File as FileIcon, IconPhoto } from "../../../lib/icons";
import { useAppStore } from "../../../stores/appStore";
import { threadIdHere, useSelfNode } from "../../../lib/computers";
import { useBotsStore } from "../../../stores/botsStore";
import { useChatsStore } from "../../../stores/chatsStore";
import { BotFace } from "../../../components/bots/face/BotFace";
import type { AgentOrigin } from "../../../../shared/types";
import type { BotSummary } from "../../../../shared/bots/personal/chat";
import { BOT_COLOUR_HEX, normalizeBotLook } from "../../../../shared/bots/personal/look";

export type UserMessageProps = {
  message: UIMessage;
  className?: string;
  /**
   * When true (default) clicking an attached image opens a fullscreen
   * lightbox preview. Set to false to render images as plain thumbnails.
   */
  enableImagePreview?: boolean;
};

type MessagePart = UIMessage["parts"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTextPart(part: MessagePart): part is { type: "text"; text: string } {
  return (
    part.type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

type FilePart = {
  type: "file";
  filename?: string;
  name?: string;
  fileName?: string;
  size?: number;
  mimeType?: string;
  mediaType?: string;
  url?: string;
  data?: string;
  /** Where a sent file was (`[Attached files: name (path)]`). */
  path?: string;
};

function getFileFromPart(part: unknown) {
  if (!isRecord(part)) return null;
  if (part.type !== "file") return null;
  const filePart = part as FilePart;
  const filename =
    filePart.filename || filePart.name || filePart.fileName || "Attachment";
  const mimeType = filePart.mimeType ?? filePart.mediaType;
  const isImage = mimeType?.startsWith("image/") ?? false;
  // Image parts WITH renderable data/url are shown as thumbnails via
  // getImageUrlFromPart — skip them here to avoid double rendering.
  // Image-named parts WITHOUT data (e.g. legacy messages saved before
  // image payloads persisted) render as image-icon chips so the attachment
  // is visible instead of silently vanishing.
  if (isImage && (filePart.url || filePart.data)) return null;
  return {
    filename,
    size: filePart.size,
    isImage,
    path: typeof filePart.path === "string" && filePart.path ? filePart.path : undefined,
  };
}

/** A long prompt shows this much (px) until "Show full message" is pressed. */
export const PROMPT_FOLD_HEIGHT = 176;
/** An agent's message folds sooner: it is read less closely than a prompt the person wrote. */
export const AGENT_FOLD_HEIGHT = 110;

/**
 * The agent or bot that sent this message, from the origin stored with it (never from its text); undefined for anyone
 * else. A sender is a thread of this computer (`threadId`) or an agent on another of the user's computers (`from`). Its
 * bubble names the sender and offers Copy of its words, never Edit.
 */
export function agentOriginOfMessage(message: UIMessage): AgentOrigin | undefined {
  const origin = (message.metadata as { origin?: AgentOrigin } | undefined)?.origin;
  if (origin?.kind !== "agent") return undefined;
  return typeof origin.threadId === "string" || (typeof origin.from === "object" && origin.from !== null) ? origin : undefined;
}

/**
 * The owner's bot behind a message: the one the origin names (`AgentOrigin.bot`), else, for a message stored before it
 * named one, the bot whose chat thread sent it. A sender on another computer names no thread here, so no bot.
 */
function botOfOrigin<T extends { id: string; homeThreadId?: string }>(origin: AgentOrigin, bots: readonly T[]): T | undefined {
  if (origin.bot) return bots.find((bot) => bot.id === origin.bot!.id);
  return origin.threadId ? bots.find((bot) => bot.homeThreadId === origin.threadId) : undefined;
}

/**
 * The header inside an agent's bubble: the robot, "Agent", then the sending thread's title, which opens that thread. A
 * sender that was deleted shows the title it had when it sent, with nothing to open.
 */
function AgentSenderHeader({ origin }: { origin: AgentOrigin }) {
  // A sender on another computer (`origin.from`) names its thread by its id there: this computer's own thread when the
  // sender is here (a message in a thread of another computer), else that computer's row. Either opens when listed here;
  // anything else shows its title as it was sent, with nothing to open.
  const self = useSelfNode(Boolean(origin.from));
  const localId = origin.from ? threadIdHere(origin.from.node, origin.from.thread, self) : origin.threadId;
  const live = useAppStore((state) => (localId ? state.threads.find((thread) => thread.id === localId)?.name : undefined));
  const title = live || origin.from?.title || origin.title;
  return (
    <div className="chat-agent-sender" data-find-ignore>
      <Bot size={13} strokeWidth={2} aria-hidden="true" />
      <span className="chat-agent-sender-kind">Agent</span>
      {title && <span aria-hidden="true">·</span>}
      {title && (live && localId ? (
        <a
          href={threadLink(localId)}
          className="chat-agent-sender-link"
          title={`Open ${title}`}
          onClick={(event) => {
            event.preventDefault();
            openLinkedThread(localId);
          }}
        >
          {title}
        </a>
      ) : (
        <span className="chat-agent-sender-title">{title}</span>
      ))}
    </div>
  );
}

/**
 * The header inside a bot's bubble: its face, drawn still, its name, and "open", which opens its chat. A bot this window
 * does not list (deleted, or on another computer) shows the name it had when it sent, with nothing to open; a bot of
 * another computer also shows the face that came with its message.
 */
function BotSenderHeader({ origin, bot }: { origin: AgentOrigin; bot: BotSummary | undefined }) {
  const name = bot?.name ?? origin.bot?.name ?? "Bot";
  const look = bot?.look ?? (origin.bot?.look ? normalizeBotLook(origin.bot.look) : undefined);
  return (
    <div className="chat-agent-sender chat-bot-sender" data-find-ignore>
      {look ? (
        <BotFace look={look} state="idle" size={18} view="head" still className="chat-bot-sender-face" />
      ) : (
        <Bot size={13} strokeWidth={2} aria-hidden="true" />
      )}
      <span className="chat-agent-sender-kind">{name}</span>
      {bot && <span aria-hidden="true">·</span>}
      {bot && (
        <button
          type="button"
          className="chat-agent-sender-link"
          title={`Open ${name}'s chat`}
          aria-label={`Open ${name}'s chat`}
          onClick={() => void useChatsStore.getState().openBot(bot.id)}
        >
          open
        </button>
      )}
    </div>
  );
}

/** The sender's header: a bot's name and face (`BotSenderHeader`), or "Agent · <sending thread>" (`AgentSenderHeader`). */
function SenderHeader({ origin }: { origin: AgentOrigin }) {
  const bot = useBotsStore((state) => botOfOrigin(origin, state.bots));
  const loaded = useBotsStore((state) => state.loaded);
  // In a window that has not read the bots yet, they are read (once): a bot's message shows its face and opens its chat.
  useEffect(() => {
    if (!bot && !loaded) void useBotsStore.getState().refresh();
  }, [bot, loaded]);
  return bot || origin.bot ? <BotSenderHeader origin={origin} bot={bot} /> : <AgentSenderHeader origin={origin} />;
}

/**
 * True when the element's text is at least twice the fold height, so folding it hides enough to matter.
 *
 * Measured in the resize observer's callback only, never while React commits: reading a size during a
 * commit lays out the transcript half-way through a move of the turn window (the previous window's
 * spacers still in place), and the browser clamps the scroll position to that layout, undoing a jump
 * such as Find's to the last turn. The observer reports every element once it is observed, before the
 * frame is painted, and the fold is applied in that same frame.
 */
function useTallEnoughToFold(ref: RefObject<HTMLElement | null>, text: string, foldHeight = PROMPT_FOLD_HEIGHT): boolean {
  const [tall, setTall] = useState(false);
  const tallRef = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = element.scrollHeight >= foldHeight * 2;
      if (next === tallRef.current) return;
      tallRef.current = next;
      flushSync(() => setTall(next));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text, foldHeight]);
  return tall;
}

/** What a chip in the sent text points at: its icon, the tooltip (where it is), and what a click opens. */
type SentChipTarget = { icon: "image" | "file" | ChatReference["kind"]; title: string; open?: () => void };
type SentChipResolver = (chip: SentChipSpan) => SentChipTarget | null;

/**
 * The message's own attachments for the chips in its text (`shared/inlineAttachments.ts`): an image by its place among
 * the images (or its name), a file by its name in the files marker, a reference by its kind and title. A bracket that
 * names none of them stays text.
 */
function sentChipResolver(
  images: Array<{ name?: string }>,
  files: Array<{ filename: string; path?: string }>,
  references: ChatReference[],
  openImage: (index: number) => void,
): SentChipResolver {
  const same = (a: string | undefined, b: string) => a !== undefined && sentChipName(a) === b;
  return (chip) => {
    if (chip.kind === "image" || chip.kind === "file") {
      const atPlace = chip.kind === "image" && chip.image ? chip.image - 1 : -1;
      const imageIndex = atPlace >= 0 && atPlace < images.length && (!images[atPlace]!.name || same(images[atPlace]!.name, chip.name))
        ? atPlace
        : images.findIndex((image) => same(image.name, chip.name));
      if (chip.kind === "image" && imageIndex >= 0) return { icon: "image", title: images[imageIndex]!.name ?? chip.name, open: () => openImage(imageIndex) };
      const file = files.find((entry) => same(entry.filename, chip.name));
      if (file) return { icon: "file", title: file.path ?? file.filename, open: file.path ? () => openFileInPanel({ path: file.path! }) : undefined };
      if (imageIndex >= 0) return { icon: "image", title: images[imageIndex]!.name ?? chip.name, open: () => openImage(imageIndex) };
    }
    const kind = chip.kind === "image" ? null : chip.kind;
    const reference = kind ? references.find((entry) => entry.kind === kind && same(entry.title, chip.name)) : undefined;
    return reference ? { icon: reference.kind, title: referenceTitle(reference), open: () => openChatReference(reference) } : null;
  };
}

/** An attachment's chip in the sent text, where the composer showed it: its icon and name; a click opens it. */
function SentAttachmentChip({ name, target }: { name: string; target: SentChipTarget }) {
  const Icon = target.icon === "image" ? IconPhoto : target.icon === "file" ? FileIcon : REFERENCE_ICONS[target.icon];
  const content = (
    <>
      <Icon size={12} strokeWidth={2} className="thread-chip-icon" aria-hidden />
      {name}
    </>
  );
  return target.open ? (
    <button type="button" className="thread-chip sent-attachment-chip" title={target.title} onClick={target.open}>{content}</button>
  ) : (
    <span className="thread-chip sent-attachment-chip" title={target.title}>{content}</span>
  );
}

/** `text` with each bracket that names one of the message's attachments drawn as its chip. */
function withSentChips(text: string, resolve: SentChipResolver | undefined, key: string): React.ReactNode {
  const chips = resolve ? findSentChips(text) : [];
  if (!chips.length) return text;
  const nodes: React.ReactNode[] = [];
  let from = 0;
  for (const chip of chips) {
    const target = resolve!(chip);
    if (!target) continue;
    nodes.push(text.slice(from, chip.index));
    nodes.push(<SentAttachmentChip key={`${key}-${chip.index}`} name={chip.name} target={target} />);
    from = chip.index + chip.length;
  }
  if (from === 0) return text;
  nodes.push(text.slice(from));
  return <>{nodes}</>;
}

/**
 * The prompt's text with its links drawn as links, the way a reply draws them (see prompt-links, link-label): a thread's
 * link as the thread's chip, in place; an attachment's bracket as its chip.
 */
function PromptText({ text, chips }: { text: string; chips?: SentChipResolver }) {
  const segments = promptSegments(text);
  if (segments.length === 1 && segments[0]!.kind === "text") return <>{withSentChips(text, chips, "t")}</>;
  return (
    <>
      {segments.map((segment, i) => {
        if (segment.kind === "text") return <Fragment key={i}>{withSentChips(segment.text, chips, String(i))}</Fragment>;
        const threadId = parseThreadLink(segment.href);
        if (threadId) return <ThreadChip key={i} threadId={threadId} label={threadLinkLabel(segment.href, segment.text)} />;
        return (
          <a
            key={i}
            href={segment.href}
            title={segment.href}
            className="chat-user-link"
            onClick={(event) => {
              event.preventDefault();
              routeLink(segment.href);
            }}
          >
            <LinkLabel href={segment.href}>{segment.text}</LinkLabel>
          </a>
        );
      })}
    </>
  );
}

export const UserMessage = memo(function UserMessage({
  message,
  className,
  enableImagePreview = true,
}: UserMessageProps) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const gallery = useImageGallery();
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const textParts = message.parts?.filter(isTextPart) ?? [];
  const text = textParts.map((p) => p.text).join("");
  const agent = agentOriginOfMessage(message);
  // A bot's message is filled with a soft tint of its own colour (global.css: .chat-user-bubble.is-bot).
  const botLook = useBotsStore((state) => (agent ? botOfOrigin(agent, state.bots)?.look : undefined));
  const botColour = botLook ? BOT_COLOUR_HEX[normalizeBotLook(botLook).colour] : undefined;
  const foldable = useTallEnoughToFold(textRef, text, agent ? AGENT_FOLD_HEIGHT : PROMPT_FOLD_HEIGHT);
  const folded = foldable && !expanded;
  // Find landing on a match in the folded part opens the prompt, so the match is not hidden under the fold.
  useEffect(() => {
    const element = textRef.current;
    if (!element || !folded) return;
    const open = () => setExpanded(true);
    element.addEventListener(FIND_REVEAL_EVENT, open);
    return () => element.removeEventListener(FIND_REVEAL_EVENT, open);
  }, [folded]);

  const images = userMessageImageTiles(message);
  const files: Array<{ filename: string; size?: number; isImage?: boolean; path?: string }> = [];
  const references: ChatReference[] = [];
  for (const part of message.parts ?? []) {
    if (isRecord(part) && part.type === "data-mousse-reference") {
      const reference = parseChatReference(part.data);
      if (reference) references.push(reference);
    }
    const file = getFileFromPart(part);
    if (file) files.push(file);
  }

  if (!text && images.length === 0 && files.length === 0 && references.length === 0) return null;

  // A turn sent from another of the user's computers says which one.
  const sentFromName = (message.metadata as { sentFrom?: { name?: unknown } } | undefined)?.sentFrom?.name;
  const sentFrom = typeof sentFromName === "string" && sentFromName ? sentFromName : undefined;

  const lightboxImages = userMessageImages(message);
  // In a conversation its one preview steps through all of the conversation's images; alone, through this prompt's.
  const openImage = (i: number) => (gallery ? gallery.open(lightboxImages[i]!) : setLightboxIndex(i));
  const chipResolver = sentChipResolver(images, files, references, openImage);

  return (
    <div className={cn("flex flex-col items-end gap-1", className)}>
      <div
        data-mousse="user-message"
        className={cn(
          "chat-user-bubble max-w-[80%] p-3 rounded-an-message",
          agent ? "is-agent" : "bg-an-user-message-bg text-an-user-message-text",
          botColour && "is-bot",
        )}
        style={botColour ? ({ "--from-colour": botColour } as CSSProperties) : undefined}
      >
      {agent && <SenderHeader origin={agent} />}
      {images.length > 0 && <div className="chat-user-image-carousel" role="region" aria-label="Attached images" tabIndex={0}>
        {images.map(({ url, name }, i) => {
          const label = name ?? `Image ${i + 1}`;
          const image = (
            <img
              src={url}
              alt={label}
              loading="lazy"
              decoding="async"
              draggable={false}
              className="block h-[120px] w-[184px] object-cover rounded-an-message-inner"
            />
          );
          // Dragged out of the window, the tile drops the image as a file under its name.
          const dragImage = (event: React.DragEvent) => startDragOut(event, { name: name ?? label, item: () => imageDragItem(url, name) });
          const tileClass = "chat-user-image h-[132px] w-[196px] shrink-0 p-1.5 bg-an-foreground/4 rounded-an-message";
          return enableImagePreview ? (
            <button
              key={i}
              type="button"
              className={cn(tileClass, "cursor-pointer")}
              aria-label={name ? `Open ${name}` : `Open image ${i + 1}`}
              title={name}
              onClick={() => openImage(i)}
              draggable
              onDragStart={dragImage}
            >
              {image}
            </button>
          ) : (
            <div key={i} className={tileClass} draggable onDragStart={dragImage}>
              {image}
            </div>
          );
        })}
      </div>}
      {enableImagePreview && !gallery && lightboxImages.length > 0 && (
        <ImageLightbox
          open={lightboxIndex !== null}
          onClose={() => setLightboxIndex(null)}
          images={lightboxImages}
          initialIndex={lightboxIndex ?? 0}
        />
      )}
      {references.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {references.map((reference) => <ChatReferencePill key={reference.id} reference={reference} />)}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-col items-end gap-2">
          {files.map((file, i) => (
            <FileAttachment
              key={`${file.filename}-${i}`}
              id={`${file.filename}-${i}`}
              filename={file.filename}
              size={file.size}
              isImage={file.isImage}
              title={file.path}
              onOpen={file.path ? () => openFileInPanel({ path: file.path! }) : undefined}
              onDragStart={file.path ? (event) => {
                const started = startDragOut(event, {
                  name: file.filename,
                  threadId: useAppStore.getState().activeThreadId,
                  item: { kind: "attachment", path: file.path!, name: file.filename },
                });
                // A thread on another computer: the chip has nothing to drag.
                if (!started) event.preventDefault();
              } : undefined}
            />
          ))}
        </div>
      )}
      {text && (
        <p
          ref={textRef}
          className={cn("chat-user-text whitespace-pre-wrap wrap-break-word", folded && "is-folded")}
          data-find-text
          data-message-id={message.id}
          data-part-index="0"
        >
          <WithSentQuotes text={text} render={(part) => <PromptText text={part} chips={chipResolver} />} />
        </p>
      )}
      {text && foldable && (
        <button
          type="button"
          className="chat-user-fold"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Show less" : "Show full message"}
        </button>
      )}
      </div>
      {sentFrom && (
        <span className="chat-user-sent-from" title={`Sent from ${sentFrom}`}>
          from {sentFrom}
        </span>
      )}
    </div>
  );
});
