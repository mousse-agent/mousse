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

## ssh2 (the SSH endpoint)

Mousse answers an editor's SSH connection itself (`src/mms/net/editor/endpoint/`), using `ssh2` 1.17.0 in server mode. It ships unmodified, pinned to that exact version, and Mousse ships none of its optional native add-ons (`cpu-features`, `buildcheck`, `nan` and the `sshcrypto` binding): the packaging excludes them, and `ssh2` falls back to Node's own crypto without them. `ssh2` has an install script that would build `sshcrypto` wherever a compiler is found; this repository allows install scripts only for `node-pty` (`allowScripts` in `package.json`), so it does not run here, and a built copy would be left out of the package by the exclusions in any case.

| Package | Licence | Copyright |
| --- | --- | --- |
| `ssh2` 1.17.0 | MIT | Brian White |
| `asn1` 0.2.6 | MIT | Mark Cavage |
| `bcrypt-pbkdf` 1.0.2 | BSD-3-Clause | Niels Provos, Ted Unangst, Joyent Inc |
| `tweetnacl` 0.14.5 | Unlicense (public domain) | none |
| `safer-buffer` 2.1.2 | MIT | Nikita Skovoroda |

`node-pty` (MIT; Christopher Jeffrey, Daniel Imms and Microsoft Corporation) already ships with Mousse for terminals; the endpoint also uses it for the pseudo-terminal of an editor's shell.

The full licence text of each package is in its folder under `node_modules` and is included in every build.

## windows-sys and the Rust standard library (the Windows SSH helper)

The Windows package carries `resources\editor-ssh\sshd.exe`, built from `native/sshd-helper` (Mousse's own code, in Rust). The program links the Rust standard library and these crates, unmodified and pinned in `native/sshd-helper/Cargo.lock`. Each is offered under MIT or Apache-2.0, and Mousse uses them under MIT.

| Crate | Licence | Copyright |
| --- | --- | --- |
| `windows-sys` 0.60.2 | MIT or Apache-2.0 | Microsoft Corporation |
| `windows-targets` 0.53.5 | MIT or Apache-2.0 | Microsoft Corporation |
| `windows_x86_64_msvc` 0.53.1 and `windows_x86_64_gnu` 0.53.1 | MIT or Apache-2.0 | Microsoft Corporation |
| `windows-link` 0.2.1 | MIT or Apache-2.0 | Microsoft Corporation |
| Rust standard library (`std`, `core`, `alloc`) | MIT or Apache-2.0 | The Rust Project Developers |

```
MIT License

Copyright (c) Microsoft Corporation.
Copyright (c) The Rust Project Developers.

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

## kokoro-js (read aloud's Kokoro text front end)

Adapted from `kokoro-js` 1.2.1 (Apache-2.0; hexgrad and Xenova), `dist/kokoro.js`:

- `src/main/readAloud/kokoroText.ts`: the text normalisation before phonemes, the punctuation kept around the espeak-ng phonemes, the fixes to those phonemes, and the choice of a voice's style by input length.

The full Apache License 2.0 text is in `node_modules/kokoro-js/LICENSE`.

## ONNX Runtime and the ort crate (read aloud's voice engine)

The packages carry `resources/voice-engine/mousse-voice` (`mousse-voice.exe` on Windows), built from `native/voice-engine` (Mousse's own code, in Rust). It links ONNX Runtime 1.31 from the prebuilt libraries the `ort` crate downloads while building, the Rust standard library and these crates, unmodified and pinned in `native/voice-engine/Cargo.lock`. The crates offered under MIT or Apache-2.0 are used under MIT. On Windows, the Visual C++ runtime DLLs (`msvcp140.dll`, `msvcp140_1.dll`, `vcruntime140.dll`, `vcruntime140_1.dll`) from Visual Studio's redistributable folder sit beside the engine, under Microsoft's terms for redistributable code.

| Component | Licence | Copyright |
| --- | --- | --- |
| ONNX Runtime 1.31 | MIT | Microsoft Corporation |
| `ort` 2.0.0-rc.15 and `ort-sys` 2.0.0-rc.15 | MIT or Apache-2.0 | pyke.io |
| `smallvec` 1.16.5 | MIT or Apache-2.0 | The Servo Project Developers |
| Rust standard library (`std`, `core`, `alloc`) | MIT or Apache-2.0 | The Rust Project Developers |

```
MIT License

Copyright (c) Microsoft Corporation.
Copyright (c) pyke.io
Copyright (c) The Servo Project Developers
Copyright (c) The Rust Project Developers.

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
