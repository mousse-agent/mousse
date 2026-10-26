/*
 * Derived from micromark-extension-math (lib/math-flow.js), MIT License,
 * Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>.
 * See THIRD_PARTY_NOTICES.md for the full license text.
 *
 * Changes from the original: `\[` as a second opening fence; content may
 * follow the opening fence on its own line and the closing fence may end a
 * content line (`$$ 1+1 $$`); a block is only produced once its closing fence
 * exists, so unfinished input stays ordinary text; no meta string.
 */

import { factorySpace } from "micromark-factory-space";
import { markdownLineEnding } from "micromark-util-character";
import { codes, types } from "micromark-util-symbol";
import type { Code, Construct, Effects, State, TokenizeContext } from "micromark-util-types";
import { isSubstantiveCode } from "./math-text";

/** Blocks longer than this stay text, which also bounds the search for a closing fence. */
const MAX_BLOCK_LENGTH = 20_000;

const nonLazyContinuation: Construct = {
  tokenize: tokenizeNonLazyContinuation,
  partial: true,
};

/**
 * Display math as a block: `$$ … $$` or `\[ … \]`. The opening fence starts a
 * line; the closing fence is the last thing on a line. Text after a fence on
 * the opening line may still be part of a longer line of prose, in which case
 * the inline construct handles it instead.
 */
export const mathFlow: Construct = {
  name: "mathFlow",
  tokenize: tokenizeMathFlow,
  concrete: true,
};

function tokenizeMathFlow(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  const tail = self.events[self.events.length - 1];
  const initialSize =
    tail && tail[1].type === types.linePrefix ? tail[2].sliceSerialize(tail[1], true).length : 0;
  const closingTail: Construct = { tokenize: tokenizeClosingTail, partial: true };
  const startOffset = self.now().offset;
  let bracket = false;
  let sizeOpen = 0;
  let firstLine = true;
  let escaped = false;
  let substantive = false;
  // A closing sequence that is followed by more text on the opening line
  // means the whole thing is inline math in a sentence.
  let closedMidLine = false;
  // Text after the opening fence must be closed on that same line; otherwise
  // a line of prose that happens to start with `$$` would swallow what follows.
  let openedWithContent = false;

  return start;

  /** Start of math, at `$` or `\`. */
  function start(code: Code): State | undefined {
    effects.enter("mathFlow");
    effects.enter("mathFlowFence");
    effects.enter("mathFlowFenceSequence");
    if (code === codes.backslash) {
      effects.consume(code);
      return bracketOpen;
    }
    return sequenceOpen(code);
  }

  function bracketOpen(code: Code): State | undefined {
    if (code !== codes.leftSquareBracket) return nok(code);
    effects.consume(code);
    bracket = true;
    return afterOpen;
  }

  function sequenceOpen(code: Code): State | undefined {
    if (code === codes.dollarSign) {
      effects.consume(code);
      sizeOpen++;
      return sequenceOpen;
    }
    if (sizeOpen < 2) return nok(code);
    return afterOpen(code);
  }

  function afterOpen(code: Code): State | undefined {
    effects.exit("mathFlowFenceSequence");
    effects.exit("mathFlowFence");
    return factorySpace(effects, beforeContent, types.whitespace)(code);
  }

  /** At the start of a line's content, outside any value token. */
  function beforeContent(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) return lineEnd(code);
    if (firstLine) openedWithContent = true;
    if (startsClosing(code)) return effects.attempt(closingTail, afterClose, notClosing)(code);
    effects.enter("mathFlowValue");
    return content(code);
  }

  /** `$` for `$$` blocks, `\` for `\[` blocks: where a closing fence can begin. */
  function startsClosing(code: Code): boolean {
    return bracket ? code === codes.backslash : code === codes.dollarSign;
  }

  /** Inside a value token. */
  function content(code: Code): State | undefined {
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit("mathFlowValue");
      return lineEnd(code);
    }
    if (escaped) {
      escaped = false;
      return take(code);
    }
    if (startsClosing(code)) {
      effects.exit("mathFlowValue");
      return effects.attempt(closingTail, afterClose, notClosing)(code);
    }
    if (code === codes.backslash) {
      escaped = true;
      effects.consume(code);
      return content;
    }
    return take(code);
  }

  function take(code: Code): State | undefined {
    if (isSubstantiveCode(code)) substantive = true;
    effects.consume(code);
    return content;
  }

  /** A `$` or `\` that did not close the block: it is content. */
  function notClosing(code: Code): State | undefined {
    if (firstLine && closedMidLine) return nok(code);
    effects.enter("mathFlowValue");
    if (code === codes.backslash) escaped = true;
    effects.consume(code);
    return content;
  }

  function afterClose(code: Code): State | undefined {
    if (bracket && !substantive) return nok(code);
    effects.exit("mathFlow");
    return ok(code);
  }

  /** At a line ending: continue on the next line, unless the input ends first. */
  function lineEnd(code: Code): State | undefined {
    if (
      code === codes.eof ||
      (firstLine && openedWithContent) ||
      self.now().offset - startOffset > MAX_BLOCK_LENGTH
    ) {
      return nok(code);
    }
    firstLine = false;
    escaped = false;
    return effects.attempt(nonLazyContinuation, beforeLine, nok)(code);
  }

  function beforeLine(code: Code): State | undefined {
    return (
      initialSize
        ? factorySpace(effects, beforeContent, types.linePrefix, initialSize + 1)
        : beforeContent
    )(code);
  }

  /** The closing fence: at least as long as the opening one and last on its line. */
  function tokenizeClosingTail(effects: Effects, ok: State, nok: State): State {
    let size = 0;
    return start;

    function start(code: Code): State | undefined {
      effects.enter("mathFlowFence");
      effects.enter("mathFlowFenceSequence");
      if (bracket) {
        effects.consume(code);
        return bracketClose;
      }
      return sequenceClose(code);
    }

    function bracketClose(code: Code): State | undefined {
      if (code !== codes.rightSquareBracket) return nok(code);
      effects.consume(code);
      return afterSequence;
    }

    function sequenceClose(code: Code): State | undefined {
      if (code === codes.dollarSign) {
        effects.consume(code);
        size++;
        return sequenceClose;
      }
      if (size < sizeOpen) return nok(code);
      return afterSequence(code);
    }

    function afterSequence(code: Code): State | undefined {
      effects.exit("mathFlowFenceSequence");
      return factorySpace(effects, afterWhitespace, types.whitespace)(code);
    }

    function afterWhitespace(code: Code): State | undefined {
      if (code === codes.eof || markdownLineEnding(code)) {
        effects.exit("mathFlowFence");
        return ok(code);
      }
      closedMidLine = true;
      return nok(code);
    }
  }
}

function tokenizeNonLazyContinuation(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  return start;

  function start(code: Code): State | undefined {
    if (code === codes.eof) return ok(code);
    effects.enter(types.lineEnding);
    effects.consume(code);
    effects.exit(types.lineEnding);
    return lineStart;
  }

  function lineStart(code: Code): State | undefined {
    return self.parser.lazy[self.now().line] ? nok(code) : ok(code);
  }
}
