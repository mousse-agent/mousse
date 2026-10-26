/*
 * Derived from micromark-extension-math (lib/math-text.js), MIT License,
 * Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>.
 * See THIRD_PARTY_NOTICES.md for the full license text.
 *
 * Changes from the original: `\(` `\)` and `\[` `\]` delimiters; a single
 * `$` only opens math that does not look like a price or a shell variable;
 * backslash escapes are skipped while looking for the closing delimiter; code
 * spans and URLs are never swallowed; math needs real content.
 */

import {
  asciiDigit,
  markdownLineEnding,
  markdownLineEndingOrSpace,
} from "micromark-util-character";
import { codes, types } from "micromark-util-symbol";
import type {
  Code,
  Construct,
  Effects,
  Event,
  State,
  Token,
  TokenizeContext,
} from "micromark-util-types";

declare module "micromark-util-types" {
  interface TokenTypeMap {
    mathFlow: "mathFlow";
    mathFlowFence: "mathFlowFence";
    mathFlowFenceSequence: "mathFlowFenceSequence";
    mathFlowValue: "mathFlowValue";
    mathText: "mathText";
    mathTextData: "mathTextData";
    mathTextPadding: "mathTextPadding";
    mathTextSequence: "mathTextSequence";
  }
}

/** Formulas longer than this stay text, which also bounds the search for a closer. */
const MAX_INLINE_LENGTH = 5000;

/** A character that makes `\[…\]` more than an escaped reference like `\[1\]`. */
export function isSubstantiveCode(code: Code): boolean {
  return (
    code !== codes.eof &&
    code !== codes.backslash &&
    code !== codes.comma &&
    !markdownLineEndingOrSpace(code) &&
    !asciiDigit(code)
  );
}

/** Starts at `$`. A run of dollars: `$x$`, `$$x$$`. */
export const mathTextDollar: Construct = {
  name: "mathTextDollar",
  tokenize: tokenizeMathText,
  resolve: resolveMathText,
  previous: previousIsNotDollar,
};

/** Starts at `\`: `\(x\)` and `\[x\]`. Anything else falls through to escapes. */
export const mathTextBackslash: Construct = {
  name: "mathTextBackslash",
  tokenize: tokenizeMathText,
  resolve: resolveMathText,
};

function tokenizeMathText(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let startOffset = 0;
  let kind: "dollar" | "paren" | "bracket" = "dollar";
  let sizeOpen = 0;
  let size = 0;
  let token: Token;
  // The last two content characters, for the single dollar rules and `://`.
  let last: Code = codes.eof;
  let beforeLast: Code = codes.eof;
  let hasContent = false;
  let substantive = false;

  return start;

  /** Start of math (text), at `$` or `\`. */
  function start(code: Code): State | undefined {
    startOffset = self.now().offset;
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    if (code === codes.backslash) {
      effects.consume(code);
      return backslashOpen;
    }
    return sequenceOpen(code);
  }

  function backslashOpen(code: Code): State | undefined {
    if (code === codes.leftParenthesis) kind = "paren";
    else if (code === codes.leftSquareBracket) kind = "bracket";
    else return nok(code);
    effects.consume(code);
    effects.exit("mathTextSequence");
    return between;
  }

  function sequenceOpen(code: Code): State | undefined {
    if (code === codes.dollarSign) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }
    // A lone dollar opens math only right before content: `$5`, `$x`.
    if (
      sizeOpen === 1 &&
      (code === codes.eof || markdownLineEndingOrSpace(code) || code === codes.comma)
    ) {
      return nok(code);
    }
    effects.exit("mathTextSequence");
    return between(code);
  }

  /** Records a content character. */
  function take(code: Code): void {
    effects.consume(code);
    beforeLast = last;
    last = code;
    if (!markdownLineEndingOrSpace(code)) hasContent = true;
    if (isSubstantiveCode(code)) substantive = true;
  }

  function between(code: Code): State | undefined {
    if (code === codes.eof || self.now().offset - startOffset > MAX_INLINE_LENGTH) return nok(code);
    if (markdownLineEnding(code)) {
      // A lone dollar never spans lines: `$5 and $\n10` is prose.
      if (kind === "dollar" && sizeOpen === 1) return nok(code);
      effects.enter(types.lineEnding);
      effects.consume(code);
      effects.exit(types.lineEnding);
      last = code;
      return between;
    }
    // Tabs don’t work, and virtual spaces don’t make sense.
    if (code === codes.space) {
      effects.enter("space");
      effects.consume(code);
      effects.exit("space");
      last = code;
      return between;
    }
    if (code === codes.graveAccent) return nok(code);
    if (kind === "dollar") {
      if (code === codes.dollarSign) {
        token = effects.enter("mathTextSequence");
        size = 0;
        return sequenceClose(code);
      }
    } else if (code === codes.backslash) {
      token = effects.enter("mathTextSequence");
      effects.consume(code);
      return backslashClose;
    }
    effects.enter("mathTextData");
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (
      code === codes.eof ||
      code === codes.space ||
      code === codes.dollarSign && kind === "dollar" ||
      markdownLineEnding(code)
    ) {
      effects.exit("mathTextData");
      return between(code);
    }
    if (code === codes.backslash) {
      if (kind !== "dollar") {
        effects.exit("mathTextData");
        return between(code);
      }
      // `\$` is TeX for a literal dollar and never closes the math.
      effects.consume(code);
      return escapedCharacter;
    }
    if (code === codes.graveAccent) return nok(code);
    // URLs in a lone-dollar span mean it is prose: `$x and https://a/?$b`.
    if (
      sizeOpen === 1 &&
      code === codes.slash &&
      last === codes.slash &&
      beforeLast === codes.colon
    ) {
      return nok(code);
    }
    take(code);
    return data;
  }

  /** In a data token, right after a backslash. */
  function escapedCharacter(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) return data(code);
    if (code === codes.graveAccent) return nok(code);
    take(code);
    return data;
  }

  function sequenceClose(code: Code): State | undefined {
    if (code === codes.dollarSign) {
      effects.consume(code);
      size++;
      return sequenceClose;
    }
    if (size === sizeOpen) {
      // A lone dollar closes only after content and before a non-digit:
      // `$5-$10` and `$x $` are prose.
      if (
        sizeOpen === 1 &&
        (markdownLineEndingOrSpace(last) || asciiDigit(code))
      ) {
        return nok(code);
      }
      if (!hasContent) return nok(code);
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok(code);
    }
    // Any other dollars end a lone-dollar span (`$a$$b`); longer spans may
    // contain them as data.
    if (sizeOpen === 1) return nok(code);
    token.type = "mathTextData";
    last = codes.dollarSign;
    hasContent = true;
    return data(code);
  }

  function backslashClose(code: Code): State | undefined {
    if (code === (kind === "paren" ? codes.rightParenthesis : codes.rightSquareBracket)) {
      if (kind === "paren" ? !hasContent : !substantive) return nok(code);
      effects.consume(code);
      effects.exit("mathTextSequence");
      effects.exit("mathText");
      return ok;
    }
    // Some other escape; the backslash is data.
    token.type = "mathTextData";
    last = codes.backslash;
    return escapedCharacter(code);
  }
}

function resolveMathText(events: Event[]): Event[] {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index: number;
  let enter: number | undefined;

  // If we start and end with an EOL or a space.
  if (
    (events[headEnterIndex][1].type === types.lineEnding ||
      events[headEnterIndex][1].type === "space") &&
    (events[tailExitIndex][1].type === types.lineEnding ||
      events[tailExitIndex][1].type === "space")
  ) {
    index = headEnterIndex;

    // And we have data.
    while (++index < tailExitIndex) {
      if (events[index][1].type === "mathTextData") {
        // Then we have padding.
        events[tailExitIndex][1].type = "mathTextPadding";
        events[headEnterIndex][1].type = "mathTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }

  // Merge adjacent spaces and data.
  index = headEnterIndex - 1;
  tailExitIndex++;
  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex && events[index][1].type !== types.lineEnding) {
        enter = index;
      }
    } else if (index === tailExitIndex || events[index][1].type === types.lineEnding) {
      events[enter][1].type = "mathTextData";
      if (index !== enter + 2) {
        events[enter][1].end = events[index - 1][1].end;
        events.splice(enter + 2, index - enter - 2);
        tailExitIndex -= index - enter - 2;
        index = enter + 2;
      }
      enter = undefined;
    }
  }
  return events;
}

/** `$` may not start in the middle of a run of dollars, except after an escape. */
function previousIsNotDollar(this: TokenizeContext, code: Code): boolean {
  return (
    code !== codes.dollarSign ||
    this.events[this.events.length - 1][1].type === types.characterEscape
  );
}
