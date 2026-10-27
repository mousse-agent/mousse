# Third-party notices

Mousse includes code adapted from the projects below. Each adapted file says so in its header.

## pi-ai

Adapted from `@earendil-works/pi-ai` 1.4.0 (MIT, declared in its `package.json`; author Mario Zechner), `dist/auth/oauth/openai-chatgpt.js` and `dist/auth/oauth/pkce.js`:

- `src/mms/harness/chatgpt/oauth.ts`, `pkce.ts` and `tokens.ts`: the Sign in with ChatGPT authorize request, the local callback server, the race between the browser callback and a pasted redirect, and PKCE.

Adapted from `@earendil-works/pi-ai` 0.85.1 (MIT, same author), `dist/types.d.ts` and `dist/utils/diagnostics.d.ts`:

- `src/shared/transcript.ts`: the message, content-block, tool-call and usage types, kept as the shape of Mousse's stored transcript.

```
MIT License

Copyright (c) Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## micromark-extension-math

Adapted from micromark-extension-math 3.1.0:

- `src/renderer/markdown/math/math-flow.ts`, `math-text.ts` and `syntax.ts`: the tokenizers for math blocks and inline math, extended with `\(…\)` and `\[…\]` delimiters and rules that keep prices and shell variables as text.

```
(The MIT License)

Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## micromark-extension-gfm-table

Adapted from micromark-extension-gfm-table 2.1.2:

- `src/renderer/markdown/math/math-table.ts`: the GFM table tokenizer, changed so a formula inside a cell keeps its pipes.

```
(The MIT License)

Copyright (c) Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Cursor SDK

`@cursor/sdk` and its platform packages (`@cursor/sdk-<platform>-<arch>`, which carry `rg` and the
Cursor sandbox helper) ship with Mousse unmodified. They are proprietary and used under Cursor's
terms (`node_modules/@cursor/sdk/LICENSE.md`). Mousse loads them only in its Cursor host process.
