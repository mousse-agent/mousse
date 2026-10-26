# Third-party notices

Mousse includes code adapted from the projects below. Each adapted file says so in its header.

## T3 Code

Ported in logic (not copied verbatim) from T3 Code at commit `d53873b6a4`:

- `src/mms/harness/acp/loadGate.ts`: the `session/load` replay gate.
- `src/mms/harness/acp/permissions.ts`: the mapping of ACP permission options.

Rules ported in logic from T3 Code's `apps/server/src/provider/CodexChatGptAuth.ts`:

- `src/mms/harness/chatgpt/oauth.ts`, `idToken.ts`, `tokens.ts` and `lifecycle.ts`: the ID token verification rules, the callback checks, the refresh and terminal-error rules, revocation with retries, and the profile key.

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

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

## pi-ai

Adapted from `@earendil-works/pi-ai` 1.4.0 (MIT, declared in its `package.json`; author Mario Zechner), `dist/auth/oauth/openai-chatgpt.js` and `dist/auth/oauth/pkce.js`:

- `src/mms/harness/chatgpt/oauth.ts`, `pkce.ts` and `tokens.ts`: the Sign in with ChatGPT authorize request, the local callback server, the race between the browser callback and a pasted redirect, and PKCE.

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
