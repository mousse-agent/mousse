"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  IconChevronLeft,
  IconChevronRight,
  IconX,
} from "../../../lib/icons";

export type LightboxImage = {
  /** Stable identifier — used for keys and to know which image is active. */
  id: string;
  /** Resolvable image URL (https / data: / blob:). */
  url: string;
  /** Optional filename used for the alt text. */
  filename?: string;
  /** The image's file on this computer, when it has one (a bot's picture): what `actions` act on. */
  path?: string;
};

export type ImageLightboxProps = {
  /** Whether the overlay is open. */
  open: boolean;
  /** Close handler — wired to overlay click, X button, and Esc key. */
  onClose: () => void;
  /** Full set of images for gallery navigation. */
  images: LightboxImage[];
  /** Index in `images` to start on. */
  initialIndex?: number;
  /** Buttons of the caller's own beside Close, for the image shown (a bot's picture: Save, Show in folder). */
  actions?: (image: LightboxImage) => ReactNode;
};

/** How far (px) a two-finger sideways swipe travels before it turns the image. */
const SWIPE_DISTANCE = 60;
/** A swipe ends when no wheel event has come for this long (ms); one swipe turns one image. */
const SWIPE_END_MS = 220;

/** Loads an image in the background, so showing it next is instant. */
function preload(url: string | undefined) {
  if (!url || typeof Image === "undefined") return;
  const image = new Image();
  image.decoding = "async";
  image.src = url;
}

/**
 * Portal-based fullscreen image preview. Renders to `document.body` so it
 * escapes any clipping/transform/stacking context. With more than one image,
 * Previous and Next sit at the edges (also the arrow keys and a sideways
 * two-finger swipe), with "3 / 12" under the image; the first and last image
 * have no arrow past them.
 */
export function ImageLightbox({
  open,
  onClose,
  images,
  initialIndex = 0,
  actions,
}: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const count = images.length;
  const hasMultipleImages = count > 1;
  const index = Math.min(Math.max(currentIndex, 0), Math.max(count - 1, 0));
  const hasPrevious = index > 0;
  const hasNext = index < count - 1;

  // Sync the active index whenever the consumer re-opens with a new initial.
  useEffect(() => {
    if (open) setCurrentIndex(initialIndex);
  }, [open, initialIndex]);

  const goToPrevious = useCallback(
    (event?: React.MouseEvent) => {
      event?.stopPropagation();
      setCurrentIndex((prev) => Math.max(0, Math.min(prev, count - 1) - 1));
    },
    [count],
  );

  const goToNext = useCallback(
    (event?: React.MouseEvent) => {
      event?.stopPropagation();
      setCurrentIndex((prev) => Math.min(count - 1, Math.max(prev, 0) + 1));
    },
    [count],
  );

  // Esc / arrow-key navigation. Capture phase so we beat any local handlers
  // (e.g. an Editor that swallows Esc, or the transcript scrolling on arrows).
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      switch (event.key) {
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          onClose();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          if (!hasMultipleImages) break;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "ArrowLeft") goToPrevious();
          else goToNext();
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () =>
      window.removeEventListener("keydown", handleKeyDown, true);
  }, [open, hasMultipleImages, onClose, goToPrevious, goToNext]);

  // Keyboard focus moves to Close while open and returns to the image that opened it.
  const closeButton = useRef<HTMLButtonElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => opener?.focus();
  }, [open]);

  // An arrow that goes away at the first or last image takes the focus with it: keep it in the preview.
  useEffect(() => {
    if (!open) return;
    if (!overlay.current?.contains(document.activeElement)) closeButton.current?.focus();
  }, [open, index]);

  // The images either side load in the background, so switching is instant.
  useEffect(() => {
    if (!open) return;
    preload(images[index - 1]?.url);
    preload(images[index + 1]?.url);
  }, [open, images, index]);

  // Lock body scroll while open so the page underneath doesn't move.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  // A two-finger sideways swipe on a trackpad turns one image per swipe; pinches and up-down scrolls do nothing.
  const swipe = useRef({ distance: 0, turned: false, timer: 0 });
  useEffect(() => () => window.clearTimeout(swipe.current.timer), []);
  const handleWheel = (event: React.WheelEvent) => {
    if (!hasMultipleImages || event.ctrlKey) return;
    const state = swipe.current;
    window.clearTimeout(state.timer);
    state.timer = window.setTimeout(() => {
      state.distance = 0;
      state.turned = false;
    }, SWIPE_END_MS);
    if (state.turned || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    state.distance += event.deltaX;
    if (Math.abs(state.distance) < SWIPE_DISTANCE) return;
    state.turned = true;
    if (state.distance > 0) goToNext();
    else goToPrevious();
  };

  if (typeof document === "undefined") return null;
  if (!open) return null;
  const currentImage = images[index];
  if (!currentImage?.url) return null;

  // A tall strip at each edge: the whole strip is the button, its round arrow shows on hover or focus
  // (always on touch screens, which have no hover). The looks sit on an inner span, as the app's base
  // button style would win over them on the button itself.
  const edge =
    "image-preview-edge group/edge absolute top-16 bottom-16 z-10 flex w-20 items-center justify-center outline-none";
  const arrow =
    "inline-flex size-10 items-center justify-center rounded-full bg-white/10 text-white/80 opacity-0 transition-[opacity,background-color] group-hover/edge:opacity-100 group-hover/edge:bg-white/20 group-hover/edge:text-white group-focus-visible/edge:opacity-100 group-focus-visible/edge:bg-white/25 group-focus-visible/edge:text-white [@media(hover:none)]:opacity-100";

  return createPortal(
    <div
      ref={overlay}
      role="dialog"
      aria-modal="true"
      aria-label={currentImage.filename ?? "Image"}
      className="image-preview-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={onClose}
      onWheel={handleWheel}
    >
      <button
        ref={closeButton}
        type="button"
        onClick={onClose}
        aria-label="Close fullscreen (Esc)"
        className="group/close absolute top-4 right-4 z-10 outline-none"
      >
        <span className="inline-flex size-9 items-center justify-center rounded-full bg-white/10 text-white/80 transition-colors group-hover/close:bg-white/20 group-hover/close:text-white group-focus-visible/close:bg-white/25 group-focus-visible/close:text-white">
          <IconX className="size-4" />
        </span>
      </button>

      {actions && (
        // A click on an action is not a click on the backdrop, which closes the preview.
        <div className="image-preview-actions absolute top-4 right-16 z-10 flex gap-2" onClick={(event) => event.stopPropagation()}>
          {actions(currentImage)}
        </div>
      )}

      {hasPrevious && (
        <button
          type="button"
          onClick={goToPrevious}
          aria-label="Previous image (←)"
          className={`${edge} left-0`}
        >
          <span className={arrow}>
            <IconChevronLeft className="size-5" />
          </span>
        </button>
      )}

      <img
        key={currentImage.id}
        src={currentImage.url}
        alt={currentImage.filename ?? "Image preview"}
        className="max-w-[calc(100vw-11rem)] max-h-[85vh] object-contain select-none"
        onClick={(event) => event.stopPropagation()}
        draggable={false}
      />

      {hasNext && (
        <button
          type="button"
          onClick={goToNext}
          aria-label="Next image (→)"
          className={`${edge} right-0`}
        >
          <span className={arrow}>
            <IconChevronRight className="size-5" />
          </span>
        </button>
      )}

      {hasMultipleImages && (
        <span
          className="image-preview-counter absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-2.5 py-0.5 text-xs tabular-nums text-white/75"
          aria-live="polite"
        >
          {index + 1} / {count}
        </span>
      )}
    </div>,
    document.body,
  );
}
