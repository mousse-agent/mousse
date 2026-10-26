/*
 * Derived from micromark-extension-math (lib/syntax.js), MIT License,
 * Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>.
 * See THIRD_PARTY_NOTICES.md for the full license text.
 */

import { codes } from "micromark-util-symbol";
import type { Extension } from "micromark-util-types";
import { mathFlow } from "./math-flow";
import { mathTextBackslash, mathTextDollar } from "./math-text";

/**
 * micromark extension for chat math: `$x$`, `$$x$$`, `\(x\)` and `\[x\]` in
 * text, and `$$` / `\[` blocks. The token names match the ones
 * `mdast-util-math` turns into `math` and `inlineMath` nodes.
 */
export function mousseMath(): Extension {
  return {
    flow: {
      [codes.dollarSign]: mathFlow,
      [codes.backslash]: mathFlow,
    },
    text: {
      [codes.dollarSign]: mathTextDollar,
      [codes.backslash]: mathTextBackslash,
    },
  };
}
