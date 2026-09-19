# Chat links and references

## File links emitted by agents

Use this canonical Markdown target to open a file in Mousse's **Files** view:

```text
mousse-file://open?path=<URL-encoded-path>&line=<1-based-line>&column=<1-based-column>
```

Example:

```markdown
[Open the parser](mousse-file://open?path=C%3A%5Cwork%5Capp%5Csrc%5Cparser.ts&line=42&column=7)
```

`line` and `column` are optional. Paths may be absolute Windows/POSIX paths or paths relative to the active project. Mousse also recognizes common agent output such as `src/parser.ts#L42C7` and `C:\work\app\src\parser.ts:42:7`. File activation is delivered through:

```ts
window.dispatchEvent(new CustomEvent('mousse:open-file', {
  detail: { path, line, column, threadId, projectId }
}))
```

HTTP(S) links open in a new Mousse built-in browser tab. Unsafe and unsupported schemes (`javascript:`, `data:`, `vbscript:`, `file:`, `mailto:`, and `tel:`) are not navigated.

## Drag references

Internal drag sources use MIME type `application/x-mousse-reference` with JSON:

```ts
{
  kind: 'file' | 'project' | 'thread' | 'terminal' | 'browser' | 'agent',
  title: string,
  path?: string,
  threadId?: string,
  projectId?: string,
  // resource-specific IDs/context may follow
}
```

The composer validates this untrusted payload, displays a removable blue titled link, and permits an attachment-only send. References are persisted per profile/thread. Sent messages contain a hidden, reconstructable reference block plus human-readable path/session context for the model.

Project/thread metadata paths must be resolved in the daemon for the active profile. Use `ChatReferenceMetadataResolver`: thread references point to `ThreadDataStore.getThreadDir(id)/meta.json`; project references point to the active profile's `projects.json`. Renderer code must not infer profile storage paths.
