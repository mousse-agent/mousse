/*
 * Derived from micromark-extension-gfm-table (lib/syntax.js), MIT License,
 * Copyright (c) Titus Wormer <tituswormer@gmail.com>.
 * See THIRD_PARTY_NOTICES.md for the full license text.
 *
 * Changes from the original: a formula inside a cell (`$|x|$`, `\(|x|\)`) is
 * skipped as a whole, so its pipes do not end the cell. A dollar after a
 * backslash is an escape and never starts a formula.
 */

import { gfmTable } from "micromark-extension-gfm-table";
import { factorySpace } from "micromark-factory-space";
import {
  markdownLineEnding,
  markdownLineEndingOrSpace,
  markdownSpace,
} from "micromark-util-character";
import { codes, types } from "micromark-util-symbol";
import type {
  Code,
  Construct,
  Effects,
  Extension,
  Resolver,
  State,
  TokenizeContext,
} from "micromark-util-types";
import { mathTextBackslash, mathTextDollar } from "./math-text";

// Cells and rows are resolved exactly as GFM resolves them.
const gfmTableConstruct = gfmTable().flow?.null as Construct;
const resolveTable = gfmTableConstruct.resolveAll as Resolver;

const mathTable: Construct = {
  name: "mathTable",
  tokenize: tokenizeTable,
  resolveAll: resolveTable,
};

/**
 * GFM tables whose cells may hold formulas with pipes. Replaces the table
 * construct from remark-gfm, so use it together with remark-gfm.
 */
export function mathTables(): Extension {
  return {
    disable: { null: [gfmTableConstruct.name as string] },
    flow: { null: [mathTable] },
  };
}

function tokenizeTable(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  const self = this;
  let size = 0;
  let sizeB = 0;
  let seen: boolean | undefined;
  // Where the formula found by `cellMath` ends.
  let mathEnd = 0;

  const cellMath: Construct = { tokenize: tokenizeCellMath, partial: true };
  const headRowData = rowData(() => headRowBreak);
  const bodyRowData = rowData(() => bodyRowBreak);

  return start;

  function start(code: Code): State | undefined {
    let index = self.events.length - 1;
    while (index > -1) {
      const type = self.events[index][1].type;
      if (type === types.lineEnding || type === types.linePrefix) index--;
      else break;
    }
    const tail = index > -1 ? self.events[index][1].type : null;
    const next = tail === "tableHead" || tail === "tableRow" ? bodyRowStart : headRowBefore;
    // Don’t allow lazy body rows.
    if (next === bodyRowStart && self.parser.lazy[self.now().line]) return nok(code);
    return next(code);
  }

  function headRowBefore(code: Code): State | undefined {
    effects.enter("tableHead");
    effects.enter("tableRow");
    return headRowStart(code);
  }

  function headRowStart(code: Code): State | undefined {
    if (code === codes.verticalBar) return headRowBreak(code);
    seen = true;
    // Count the first character, that isn’t a pipe, double.
    sizeB += 1;
    return headRowBreak(code);
  }

  function headRowBreak(code: Code): State | undefined {
    if (code === codes.eof) return nok(code);
    if (markdownLineEnding(code)) {
      // If anything other than one pipe (ignoring whitespace) was used, it’s fine.
      if (sizeB > 1) {
        sizeB = 0;
        self.interrupt = true;
        effects.exit("tableRow");
        effects.enter(types.lineEnding);
        effects.consume(code);
        effects.exit(types.lineEnding);
        return headDelimiterStart;
      }
      return nok(code);
    }
    if (markdownSpace(code)) return factorySpace(effects, headRowBreak, types.whitespace)(code);
    sizeB += 1;
    if (seen) {
      seen = false;
      // Header cell count.
      size += 1;
    }
    if (code === codes.verticalBar) {
      effects.enter("tableCellDivider");
      effects.consume(code);
      effects.exit("tableCellDivider");
      seen = true;
      return headRowBreak;
    }
    effects.enter(types.data);
    return headRowData(code);
  }

  function headDelimiterStart(code: Code): State | undefined {
    self.interrupt = false;
    if (self.parser.lazy[self.now().line]) return nok(code);
    effects.enter("tableDelimiterRow");
    // Track if we’ve seen a `:` or `|`.
    seen = false;
    if (markdownSpace(code)) {
      return factorySpace(
        effects,
        headDelimiterBefore,
        types.linePrefix,
        self.parser.constructs.disable.null?.includes("codeIndented") ? undefined : 4,
      )(code);
    }
    return headDelimiterBefore(code);
  }

  function headDelimiterBefore(code: Code): State | undefined {
    if (code === codes.dash || code === codes.colon) return headDelimiterValueBefore(code);
    if (code === codes.verticalBar) {
      seen = true;
      effects.enter("tableCellDivider");
      effects.consume(code);
      effects.exit("tableCellDivider");
      return headDelimiterCellBefore;
    }
    return nok(code);
  }

  function headDelimiterCellBefore(code: Code): State | undefined {
    if (markdownSpace(code)) {
      return factorySpace(effects, headDelimiterValueBefore, types.whitespace)(code);
    }
    return headDelimiterValueBefore(code);
  }

  function headDelimiterValueBefore(code: Code): State | undefined {
    if (code === codes.colon) {
      sizeB += 1;
      seen = true;
      effects.enter("tableDelimiterMarker");
      effects.consume(code);
      effects.exit("tableDelimiterMarker");
      return headDelimiterLeftAlignmentAfter;
    }
    if (code === codes.dash) {
      sizeB += 1;
      return headDelimiterLeftAlignmentAfter(code);
    }
    if (code === codes.eof || markdownLineEnding(code)) return headDelimiterCellAfter(code);
    return nok(code);
  }

  function headDelimiterLeftAlignmentAfter(code: Code): State | undefined {
    if (code === codes.dash) {
      effects.enter("tableDelimiterFiller");
      return headDelimiterFiller(code);
    }
    return nok(code);
  }

  function headDelimiterFiller(code: Code): State | undefined {
    if (code === codes.dash) {
      effects.consume(code);
      return headDelimiterFiller;
    }
    if (code === codes.colon) {
      seen = true;
      effects.exit("tableDelimiterFiller");
      effects.enter("tableDelimiterMarker");
      effects.consume(code);
      effects.exit("tableDelimiterMarker");
      return headDelimiterRightAlignmentAfter;
    }
    effects.exit("tableDelimiterFiller");
    return headDelimiterRightAlignmentAfter(code);
  }

  function headDelimiterRightAlignmentAfter(code: Code): State | undefined {
    if (markdownSpace(code)) {
      return factorySpace(effects, headDelimiterCellAfter, types.whitespace)(code);
    }
    return headDelimiterCellAfter(code);
  }

  function headDelimiterCellAfter(code: Code): State | undefined {
    if (code === codes.verticalBar) return headDelimiterBefore(code);
    if (code === codes.eof || markdownLineEnding(code)) {
      // Not a table without a `:` or `|` (thematic break, setext underline),
      // or when the head and delimiter rows have different cell counts.
      if (!seen || size !== sizeB) return nok(code);
      effects.exit("tableDelimiterRow");
      effects.exit("tableHead");
      return ok(code);
    }
    return nok(code);
  }

  function bodyRowStart(code: Code): State | undefined {
    effects.enter("tableRow");
    return bodyRowBreak(code);
  }

  function bodyRowBreak(code: Code): State | undefined {
    if (code === codes.verticalBar) {
      effects.enter("tableCellDivider");
      effects.consume(code);
      effects.exit("tableCellDivider");
      return bodyRowBreak;
    }
    if (code === codes.eof || markdownLineEnding(code)) {
      effects.exit("tableRow");
      return ok(code);
    }
    if (markdownSpace(code)) return factorySpace(effects, bodyRowBreak, types.whitespace)(code);
    effects.enter(types.data);
    return bodyRowData(code);
  }

  /** Cell content of a head or body row; `rowBreak` takes over at a pipe or space. */
  function rowData(rowBreak: () => State): State {
    return data;

    function data(code: Code): State | undefined {
      if (code === codes.dollarSign && !mathTextDollar.previous?.call(self, self.previous)) {
        return plain(code);
      }
      if (code === codes.dollarSign || code === codes.backslash) {
        return effects.check(cellMath, formula, plain)(code);
      }
      return plain(code);
    }

    function plain(code: Code): State | undefined {
      if (code === codes.eof || code === codes.verticalBar || markdownLineEndingOrSpace(code)) {
        effects.exit(types.data);
        return rowBreak()(code);
      }
      effects.consume(code);
      return code === codes.backslash ? escape : data;
    }

    function escape(code: Code): State | undefined {
      if (code === codes.backslash || code === codes.verticalBar || code === codes.dollarSign) {
        effects.consume(code);
        return data;
      }
      return data(code);
    }

    function formula(code: Code): State | undefined {
      if (self.now().offset >= mathEnd) return data(code);
      effects.consume(code);
      return formula;
    }
  }

  /** Succeeds at a formula that ends on this line, and records where it ends. */
  function tokenizeCellMath(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
    const context = this;
    const line = context.now().line;
    return (code) => {
      const construct = code === codes.dollarSign ? mathTextDollar : mathTextBackslash;
      return construct.tokenize.call(context, effects, done, nok)(code);
    };

    function done(code: Code): State | undefined {
      if (context.now().line !== line) return nok(code);
      mathEnd = context.now().offset;
      return ok(code);
    }
  }
}
