"use client";

import { cloneElement, createContext, isValidElement, memo, useContext, useRef, type ReactElement, type ReactNode } from "react";
import { Block, type BlockProps } from "streamdown";
import { ByteLruCache } from "../../../lib/byteLruCache";
import { registerByteCache } from "../../../lib/windowCounters";
import { countRender } from "./render-counts";

/**
 * Parsed Markdown kept for text drawn again: a row scrolled back into the window, a thread opened
 * again. Each block keeps the elements its Markdown parsed into, and each message keeps how it
 * splits into blocks, so drawing it again builds its elements without parsing. Bounded by an
 * estimate of the bytes they hold.
 */
export const MARKDOWN_CACHE_BYTES = 10 * 1024 * 1024;
/**
 * What a parsed block holds, fitted to the heap it retains for dense lists with inline code and links,
 * prose, tables and code fences (within 3% for the first three; code is overestimated about 1.5x).
 * Each element is a React element with its props and the syntax-tree node Streamdown keeps on it,
 * with its position and properties; each piece of text is a text node with its position; each block
 * has its tree's root and the parse's own objects. Text and keys count at 2 bytes a character.
 */
const BYTES_PER_ELEMENT = 1100;
const BYTES_PER_TEXT_NODE = 450;
const BYTES_PER_BLOCK = 4000;
/** A split holds its blocks' text (UTF-16) and the list. */
const SPLIT_BYTES_PER_CHAR = 2;
const SPLIT_BYTES_PER_BLOCK = 64;

/** The elements, pieces of text and characters of text in a parsed tree. */
export function parsedTreeShape(node: ReactNode, shape = { elements: 0, texts: 0, chars: 0 }): { elements: number; texts: number; chars: number } {
  if (Array.isArray(node)) {
    for (const child of node) parsedTreeShape(child, shape);
  } else if (typeof node === "string") {
    shape.texts += 1;
    shape.chars += node.length;
  } else if (isValidElement<{ children?: ReactNode }>(node)) {
    shape.elements += 1;
    parsedTreeShape(node.props.children, shape);
  }
  return shape;
}

/** The estimated bytes of a parsed tree kept under `key`. */
export function parsedTreeBytes(tree: ReactNode, key: string): number {
  const shape = parsedTreeShape(tree);
  return BYTES_PER_BLOCK + shape.elements * BYTES_PER_ELEMENT + shape.texts * BYTES_PER_TEXT_NODE + shape.chars * 2 + key.length * 2;
}

const cache = new ByteLruCache<string, ReactNode | string[]>(MARKDOWN_CACHE_BYTES);

/** The parsed-Markdown cache, for the profiler and tests. */
export const markdownCache: Pick<ByteLruCache<string, unknown>, "bytes" | "size" | "hits" | "misses" | "budgetBytes" | "clear"> = cache;

// The profiler's window breakdown reads the Markdown cache's size.
registerByteCache("markdown", cache);

/**
 * Which setup the blocks inside are parsed with. Markdown's components and plugins differ with math
 * on and off, so the same text parses differently in each. Blocks outside a setup are not cached.
 */
export const MarkdownSetupContext = createContext<string | null>(null);

/** `split`, answered from the cache for text it split before. `setup` names what `split` does. */
export function cachedSplit(setup: string, split: (text: string) => string[]): (text: string) => string[] {
  return (text) => {
    const key = `split\0${setup}\0${text}`;
    const held = cache.get(key) as string[] | undefined;
    if (held) return held;
    const blocks = split(text);
    cache.set(key, blocks, key.length * 2 + text.length * SPLIT_BYTES_PER_CHAR + blocks.length * SPLIT_BYTES_PER_BLOCK);
    return blocks;
  };
}

type MemoParts = { type?: (props: BlockProps) => ReactNode; compare?: (a: BlockProps, b: BlockProps) => boolean };
const streamdownBlock = (Block as unknown as MemoParts).type;
const streamdownBlockCompare = (Block as unknown as MemoParts).compare;

type ParseElement = ReactElement<{ children: string }, (props: { children: string }) => ReactNode>;

function isParseElement(node: unknown): node is ParseElement {
  return isValidElement<{ children?: unknown }>(node) && typeof node.type === "function" && typeof node.props.children === "string";
}

/**
 * Streamdown's block draws its text with one element that parses it (`<Parse>{text}</Parse>`),
 * inside a context provider and, when the block has a text direction, a wrapper. Returns that
 * element and a copy of `drawn` with something else in its place; null when drawn another way.
 */
function findParse(drawn: ReactNode): { parse: ParseElement; replace: (tree: ReactNode) => ReactElement } | null {
  if (!isValidElement<{ children?: ReactNode }>(drawn)) return null;
  const child = drawn.props.children;
  if (isParseElement(child)) return { parse: child, replace: (tree) => cloneElement(drawn, undefined, tree) };
  const inner = isValidElement(child) ? findParse(child) : null;
  return inner && { parse: inner.parse, replace: (tree) => cloneElement(drawn, undefined, inner.replace(tree)) };
}

/**
 * Streamdown's block, with the elements its text parses into taken from the cache. A block whose text
 * changes (the end of a streaming reply) drops the text it put there before, so only what it ends
 * with stays.
 */
function CachedBlockView(props: BlockProps) {
  const setup = useContext(MarkdownSetupContext);
  const inserted = useRef<string | null>(null);
  // Streamdown's own block runs as before (its effects included); only its parse is swapped.
  const drawn = streamdownBlock!(props);
  if (setup === null || props.isIncomplete) return drawn;
  const found = findParse(drawn);
  if (!found) return drawn;
  const text = found.parse.props.children;
  const key = `block\0${setup}\0${text}`;
  // The text this block put there before is a step on the way to `text`, whether `text` is new or held.
  if (inserted.current !== null && inserted.current !== key) {
    cache.delete(inserted.current);
    inserted.current = null;
  }
  let tree = cache.get(key) as ReactNode | undefined;
  if (tree === undefined) {
    countRender("blockParse");
    tree = found.parse.type(found.parse.props);
    cache.set(key, tree, parsedTreeBytes(tree, key));
    inserted.current = key;
  }
  return found.replace(tree);
}

/** Streamdown's block with parsed Markdown kept across mounts; Streamdown's own if its shape is not the one read here. */
export const CachedBlock = typeof streamdownBlock === "function" ? memo(CachedBlockView, streamdownBlockCompare) : Block;
