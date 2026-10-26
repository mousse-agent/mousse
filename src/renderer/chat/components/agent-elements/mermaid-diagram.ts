import type { Config, DOMPurify } from "dompurify";
import type { DiagramType } from "pele/lazy";

/** Longest diagram source that is drawn; anything larger stays a code block. */
export const MERMAID_SOURCE_LIMIT = 50_000;
const MERMAID_MAX_EDGES = 5_000;
/** Settled results kept so a remounted message shows its diagram at once. */
const RESULT_CACHE_SIZE = 64;

export type DiagramOutcome =
  | { status: "ready"; svg: string }
  /** The source cannot be drawn; `message` explains why. */
  | { status: "error"; message: string }
  /** The renderer chunk failed to load; trying again may work. */
  | { status: "unavailable"; message: string };

type Purifier = Pick<DOMPurify, "sanitize" | "isSupported">;

// Pele already drops links, images and styles it was not asked for. This is the
// second layer: whatever a renderer bug or a hostile label slips into the SVG,
// nothing that navigates, loads, or runs can survive.
const SVG_PURIFY_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  ADD_ATTR: ["role"],
  FORBID_TAGS: ["a", "image", "foreignObject", "style", "script"],
  FORBID_ATTR: ["href", "xlink:href", "src", "srcset"],
};

export function sanitizeDiagramSvg(svg: string, purifier: Purifier): string {
  // Without a DOM, DOMPurify hands the input back untouched.
  if (!purifier.isSupported) throw new Error("The diagram sanitizer is unavailable.");
  const clean = purifier.sanitize(svg, SVG_PURIFY_CONFIG);
  if (!clean.trimStart().startsWith("<svg")) throw new Error("The diagram was empty after sanitizing.");
  return clean;
}

function describe(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** Stable per-source suffix so two diagrams on one page never share SVG ids. */
function idPrefixFor(source: string): string {
  let hash = 5381;
  for (let i = 0; i < source.length; i++) hash = ((hash << 5) + hash + source.charCodeAt(i)) | 0;
  return `mmd${(hash >>> 0).toString(36)}`;
}

type Engine = {
  pele: typeof import("pele/lazy");
  purifier: DOMPurify;
};

let enginePromise: Promise<Engine> | undefined;

// pele and DOMPurify only load when a reply actually contains a diagram. A
// failed load is forgotten so a later attempt can fetch the chunk again.
function loadEngine(): Promise<Engine> {
  enginePromise ??= Promise.all([import("pele/lazy"), import("dompurify")]).then(
    ([pele, purify]) => ({ pele, purifier: purify.default }),
    (error) => {
      enginePromise = undefined;
      throw error;
    },
  );
  return enginePromise;
}

async function drawDiagram(source: string): Promise<DiagramOutcome> {
  if (source.length > MERMAID_SOURCE_LIMIT) {
    return {
      status: "error",
      message: `Diagram source is longer than the limit of ${MERMAID_SOURCE_LIMIT} characters.`,
    };
  }
  let engine: Engine;
  try {
    engine = await loadEngine();
    let type: DiagramType | null = null;
    try {
      type = engine.pele.detectType(source);
    } catch {
      // Unrecognized source: render() below reports it as a PeleError.
    }
    // Each diagram type is its own chunk.
    await engine.pele.load(type);
  } catch (error) {
    return { status: "unavailable", message: describe(error) };
  }
  try {
    const { svg } = engine.pele.render(source, {
      links: false,
      images: false,
      limit: MERMAID_SOURCE_LIMIT,
      maxEdges: MERMAID_MAX_EDGES,
      idPrefix: idPrefixFor(source),
    });
    return { status: "ready", svg: sanitizeDiagramSvg(svg, engine.purifier) };
  } catch (error) {
    return { status: "error", message: describe(error) };
  }
}

type CacheEntry = { promise: Promise<DiagramOutcome>; settled?: DiagramOutcome };

const results = new Map<string, CacheEntry>();

function remember(source: string, entry: CacheEntry) {
  results.delete(source);
  results.set(source, entry);
  if (results.size > RESULT_CACHE_SIZE) results.delete(results.keys().next().value as string);
}

/** The finished result for `source`, if it has already been drawn. */
export function peekDiagram(source: string): DiagramOutcome | undefined {
  const entry = results.get(source);
  if (!entry?.settled) return undefined;
  remember(source, entry);
  return entry.settled;
}

/** Draws `source` once; repeat calls share the result. Never rejects. */
export function renderDiagram(source: string): Promise<DiagramOutcome> {
  const known = results.get(source);
  if (known) return known.promise;
  const entry: CacheEntry = {
    promise: drawDiagram(source).then((outcome) => {
      if (outcome.status === "unavailable") results.delete(source);
      else entry.settled = outcome;
      return outcome;
    }),
  };
  remember(source, entry);
  return entry.promise;
}

/** Test hook: forget every drawn diagram and the loaded renderer. */
export function resetDiagramCache() {
  results.clear();
  enginePromise = undefined;
}
