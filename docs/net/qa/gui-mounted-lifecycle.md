# Mounted network view lifecycle qualification

I preserved the mounted regressions from the UI review in
`tests/net/chats/gui-renderer-lifecycle.test.ts` and its
`tests/fixtures/net-gui/mounted-lifecycle` fixture. The fixture mounts the actual
React components in Electron 43.2.0, on a secure loopback origin with browser
WebCrypto. The test runner used Node 24.20.0 on Darwin arm64.

## Reproduced defects and source dependencies

On frozen UI `107e4242`, I held the original private-opening reply, unmounted the
composer, then released the reply. It still issued `chats.snapshot` and called
`onOpen`. A similarly delayed permission reply still called `onChanged`; through
WorkView that caused an additional `chats.aside.get` after unmount. I preserved
the original trace in `/private/tmp/mousse-ui-review-mounted-red.json`. These
were late presentation callbacks/read I/O, not a demonstrated authorization
bypass or additional mutation. Parent-owned source checkpoint `c0e6af68` fences
those continuations. The same three mounted cases passed against those guards.

I also mounted a remote display, delivered a complete snapshot with
`activeTurn.active:true`, then changed the selected peer from open to closed.
The old UI still showed Working beside an Offline device. Parent-owned
`b541d64b` and `1e99620a` now label the retained display Offline/Cached and await a
complete current display after a new carrier. I verified the original offline
scenario, then the extended reconnect regression on `1e99620a`.

## Repeatable acceptance

The single focused test launches six independent mounted scenarios:

- Late private-opening reply: no refresh read or callback after unmount.
- Late permission reply: no decision callback after unmount.
- Late WorkView permission reply: no additional private read after unmount.
- Lost opening reply: explicit retry preserves the exact aside ID and input.
- Lost approval reply: explicit retry preserves the exact request and decision.
- Remote offline/reconnect: cached transcript survives; the departed carrier has
  no listener; no Working is shown before a fresh complete snapshot. An
  incremental-only event and a real hashed multipart snapshot without its final
  frame cannot promote the cached display. Only the decoded complete snapshot
  restores Working and replaces the retained body. Attach/detach calls remain
  serialized and the final unmount releases the listener.

I verified all six scenarios in one passing Vitest check (2.62 seconds) on the
source base `1e99620a`. The log is
`/private/tmp/mousse-ui-mounted-remote-green.log`. Scoped fixture/test TypeScript
also passed. Run the regression with:

```sh
TMPDIR=/private/tmp node node_modules/vitest/vitest.mjs run tests/net/chats/gui-renderer-lifecycle.test.ts
```

Use supported Node 24.20 or newer and the installed Electron dependency. The
fixture removes inherited `ELECTRON_RUN_AS_NODE` only from its own child, owns a
unique user-data directory and loopback server, bounds its execution/logs, and
cleans only its spawned child handle and temporary files.

## Limits

The UI API port is controlled. Its private-body responses are display inputs,
not signed records or authenticated ciphertext. This test does not qualify MMS
profile binding, TLS, current membership, selfwrap/key access, actual grant
execution, paid-provider use, or packaged GUI behavior. Those have separate
backend/IPC evidence. I verified mounted DOM text and callbacks, not pixels or
visual approval. I changed only QA files; no application source, default-branch
release, authentication policy or full-suite result is part of this checkpoint.

I verified that the actual shell remounts ProfileSettingsPage and ChatWorkspace
by profile ID. A missing child profile dependency alone was therefore not a
cross-profile mixing defect. Existing authorized retained private/plaintext
history also does not itself prove an access-control bypass. The broader P9,
platform/package and other-human sensitive-review gates remain open.
