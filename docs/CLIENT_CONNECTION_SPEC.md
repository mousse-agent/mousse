# Mousse Client Connection Protocol 1.0

Status: Draft implementation contract  
Protocol identifier: `mousse-client/1.0`  
Last updated: 2026-08-13

This document defines how a third-party client connects to a user's Mousse Main
Service (MMS) over HTTP. It is the normative contract used by the official
Capacitor client. A conforming client does not need Electron, the local named
pipe protocol, or access to the Mousse home directory.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are interpreted as in
RFC 2119 and RFC 8174.

## 1. Design goals

- Any registered public client can connect without embedding a client secret.
- The user explicitly approves every client and its requested permissions.
- Native, browser, desktop, and command-line clients share one HTTP contract.
- Clients can recover from temporary network loss without losing ordered events.
- The server exposes MMS capabilities, not Electron window-management details.
- Credentials and provider API keys never cross this API.

## 2. Transport and base URL

The user supplies a Mousse server base URL, for example
`https://mousse.example.test:28478`. All paths in this specification are
relative to that URL.

Remote connections **MUST** use HTTPS with a certificate trusted by the client.
Plain HTTP **MUST** be accepted only when the host is a loopback literal
(`127.0.0.0/8` or `[::1]`). Clients **MUST NOT** offer an "ignore certificate"
mode. Servers **MUST** reject non-loopback requests when TLS is not in use.

Every response includes:

```http
Mousse-Protocol-Version: 1.0
Cache-Control: no-store
```

JSON request and response bodies use UTF-8 and `application/json`. Timestamps
are RFC 3339 UTC strings. IDs are opaque, case-sensitive strings.

## 3. Discovery

### 3.1 Authorization server metadata

`GET /.well-known/oauth-authorization-server`

The response follows RFC 8414 and includes at least:

```json
{
  "issuer": "https://mousse.example.test:28478",
  "authorization_endpoint": "https://mousse.example.test:28478/oauth/authorize",
  "token_endpoint": "https://mousse.example.test:28478/oauth/token",
  "revocation_endpoint": "https://mousse.example.test:28478/oauth/revoke",
  "registration_endpoint": "https://mousse.example.test:28478/oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none"],
  "code_challenge_methods_supported": ["S256"],
  "scopes_supported": [
    "mousse:read",
    "mousse:chat",
    "mousse:write",
    "mousse:terminal",
    "mousse:settings",
    "mousse:admin"
  ]
}
```

### 3.2 Mousse server metadata

`GET /.well-known/mousse-configuration`

```json
{
  "protocol_version": "1.0",
  "server_name": "Workstation Mousse",
  "server_version": "0.1.0",
  "api_endpoint": "https://mousse.example.test:28478/v1/rpc",
  "events_endpoint": "https://mousse.example.test:28478/v1/events",
  "max_request_bytes": 1048576,
  "event_retention": 2048
}
```

Discovery endpoints disclose no usernames, projects, filesystem paths, or
other private state and do not require authorization.

## 4. Client registration

Mousse supports RFC 7591-style registration for public clients:

`POST /oauth/register`

```json
{
  "client_name": "Example Mousse Client",
  "redirect_uris": ["com.example.mousse:/oauth/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

The response contains a generated `client_id`; it never contains a client
secret. Registration is rate-limited. Redirect URIs are validated and stored
with the client record:

- HTTPS redirect URIs are allowed.
- Private-use schemes are allowed for installed apps and must contain a dot in
  the scheme to reduce collisions.
- Loopback HTTP redirect URIs are allowed; the port may vary at authorization
  time as permitted by RFC 8252.
- Fragments, embedded credentials, wildcard hosts, and non-loopback HTTP URIs
  are rejected.

Registration alone grants no access. The user still approves an authorization
request. Servers may remove registrations that have never been approved and
have been inactive for 24 hours.

## 5. Authorization

Clients use OAuth Authorization Code flow with PKCE in an external system
browser, following RFC 8252 and the OAuth Security BCP (RFC 9700).

### 5.1 Authorization request

`GET /oauth/authorize` with these query parameters:

| Parameter | Requirement |
| --- | --- |
| `response_type` | MUST be `code` |
| `client_id` | Registered client identifier |
| `redirect_uri` | Exact registered URI, except a loopback port may vary |
| `scope` | Space-separated scopes |
| `state` | REQUIRED, at least 128 bits of entropy |
| `code_challenge` | REQUIRED PKCE challenge |
| `code_challenge_method` | MUST be `S256` |

The server shows the registered client name, redirect destination, requested
scopes, and the server name. Consent is never inferred from network proximity.
The user must approve in a currently authenticated Mousse owner session. A
headless server uses a short-lived, single-use owner approval code printed by
`mousse-cli connections approve`; the approval code never travels to the
client redirect URI.

On approval the server redirects with `code`, `state`, and the RFC 9207 `iss`
parameter. Authorization codes are random, single-use, bound to the client,
redirect URI, scopes, and PKCE challenge, and expire after 60 seconds.

### 5.2 Token request

`POST /oauth/token` uses `application/x-www-form-urlencoded`.

Authorization-code exchange fields:

```text
grant_type=authorization_code
client_id=...
code=...
redirect_uri=...
code_verifier=...
```

Refresh fields:

```text
grant_type=refresh_token
client_id=...
refresh_token=...
```

Successful response:

```json
{
  "access_token": "opaque-random-token",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "opaque-random-refresh-token",
  "scope": "mousse:read mousse:chat"
}
```

Access and refresh tokens are opaque random values. Only keyed hashes are
stored at rest. Refresh tokens rotate on every use; reuse of an invalidated
refresh token revokes its entire token family. Refresh tokens expire after 30
days of inactivity and 90 days absolutely.

### 5.3 Revocation

`POST /oauth/revoke` follows RFC 7009 and accepts `token`, `client_id`, and an
optional `token_type_hint`. Revoking a refresh token revokes its token family.
The Mousse owner can revoke a client and all its grants from the desktop GUI or
CLI at any time.

Bearer tokens appear only in the `Authorization: Bearer ...` header. They MUST
NOT appear in URLs, cookies, logs, or SSE query parameters.

## 6. Scopes

| Scope | Allows |
| --- | --- |
| `mousse:read` | Health, capabilities, projects, threads, messages, agents, tasks, schedules, channels, workspace state, file reads, git reads, and events |
| `mousse:chat` | Send, queue, steer, retry, abort, and answer questions; includes `mousse:read` |
| `mousse:write` | Create/update/delete projects, threads, tasks, schedules, files, git branches/commits, undo/redo, and publish; includes `mousse:read` |
| `mousse:terminal` | Create/read/write/resize/kill PTYs; includes `mousse:read` |
| `mousse:settings` | Read/update non-secret settings, MCP and skills configuration, and provider login intents; provider credentials are write-only |
| `mousse:admin` | Channel configuration, client/grant management, daemon shutdown, and every other scope |

The server validates the scope for every RPC method. A client cannot increase
scope during refresh. Unknown scopes are rejected. Responses redact provider
tokens, channel bot tokens, webhook secrets, filesystem owner tokens, and
environment secrets regardless of scope.

## 7. RPC endpoint

`POST /v1/rpc`

```http
Authorization: Bearer ACCESS_TOKEN
Content-Type: application/json
Idempotency-Key: 87f0d64b-e2dd-4f37-a7bc-90fbfa38dd45
```

```json
{
  "jsonrpc": "2.0",
  "id": "client-request-42",
  "method": "threads.list",
  "params": { "projectId": "optional-project-id" }
}
```

Success:

```json
{
  "jsonrpc": "2.0",
  "id": "client-request-42",
  "result": []
}
```

Failure:

```json
{
  "jsonrpc": "2.0",
  "id": "client-request-42",
  "error": {
    "code": -32003,
    "message": "Scope mousse:write is required",
    "data": { "required_scope": "mousse:write", "retryable": false }
  }
}
```

The server supports one JSON-RPC request per HTTP request. Batches are rejected.
Request IDs are client-chosen strings up to 128 characters. Mutating requests
MUST include a UUID `Idempotency-Key`; the server caches the outcome for 24
hours per grant and key. Request bodies larger than the advertised limit return
HTTP 413.

HTTP status reflects transport/authentication handling: 200 for a processed
JSON-RPC response (including method errors), 400 malformed input, 401 invalid
token, 403 insufficient scope, 409 idempotency conflict, 413 body too large,
429 rate limited, and 503 daemon draining.

The initial method namespace is the MMS local protocol namespace advertised by
the `capabilities` method, excluding Electron-only operations. Implementations
MUST expose at least:

- `health`, `capabilities`
- `projects.*`, `threads.*`, `thread.snapshot`
- `orchestrator.*`, `queue.*`
- `agents.*`, `tasks.*`, `mousseAgent.*`
- `pty.*`, `activity.*`
- `scheduled.*`, `channels.*`
- `mcp.*`, `skills.*`, `settings.*`, `providers.*`
- `workspace.*`, `actions.*`, `operations.*`, `publish.*`
- `files.*` and read/write `git.*` methods implemented by MMS

`events.subscribe` is not accepted over RPC; clients use SSE. Electron window,
application restart, native browser view, OS dialog, and window chrome methods
are intentionally not part of the server protocol. A client implements those
locally when meaningful on its platform.

## 8. Server-Sent Events

`GET /v1/events` opens a `text/event-stream` response and requires the bearer
header. Event authorization requires `mousse:read`.

Clients resume with the standard `Last-Event-ID` header. Event IDs are decimal
monotonic sequence numbers scoped to the current server instance.

```text
id: 1842
event: thread.message
data: {"seq":1842,"serverInstanceId":"...","threadId":"...","payload":{"message":{}}}

```

The event names and payloads match the local MMS protocol. The server sends an
SSE comment heartbeat every 15 seconds. If the requested event ID is older than
the replay buffer, the server emits `stream.reset` and closes; the client then
reloads snapshots and reconnects without `Last-Event-ID`. A changed
`serverInstanceId` also requires a full snapshot reload.

Mobile clients SHOULD suspend the live stream while backgrounded and refresh
snapshots on resume. Push notifications are outside version 1.0.

## 9. Errors, limits, and concurrency

OAuth errors use RFC 6749 fields. API authentication failures include a
`WWW-Authenticate: Bearer` challenge as defined by RFC 6750.

Default per-grant limits are 60 RPC requests per minute, 10 concurrent RPC
requests, one SSE connection, and 1 MiB per request. PTY writes and chat image
attachments may use stricter limits. A 429 response includes `Retry-After`.

When two clients mutate the same versioned resource, methods that accept an
expected generation use it as an optimistic concurrency precondition. The
server returns a structured conflict rather than silently overwriting newer
state.

## 10. Security requirements

- Authorization Code is the only interactive flow; implicit and password
  grants are forbidden.
- PKCE S256 and `state` are mandatory for every authorization request.
- Redirect matching is exact except for the native loopback-port exception.
- The authorization response includes `iss`; clients validate it.
- Tokens have at least 256 bits of entropy and are compared in constant time.
- Persistent authorization data is owner-readable only and written atomically.
- Secrets are redacted from API responses, errors, audit entries, and logs.
- Authorization, grant, refresh, revocation, and denied-scope operations are
  recorded in a bounded local audit log without token values.
- CORS is disabled by default. An owner may allow exact HTTPS origins; wildcard
  origins are forbidden, and origin checks never replace OAuth.
- The server sends `X-Content-Type-Options: nosniff`, a restrictive CSP on
  consent pages, `Referrer-Policy: no-referrer`, and no-store caching headers.
- Clients store refresh tokens using Keychain/Keystore-backed secure storage.

The server implementation uses `@jmondi/oauth2-server` 4.3.x as a compact,
framework-neutral OAuth authorization-server dependency. It is actively
maintained, written in TypeScript, supports PKCE, and has three runtime
dependencies. Mousse pins the exact audited version and uses its own atomic
repositories. This dependency choice is not part of the wire contract.

## 11. Versioning and compatibility

The URL major version and `Mousse-Protocol-Version` header define compatibility.
Within 1.x, servers may add methods, event types, discovery fields, optional
parameters, and error data. They do not remove or change existing fields.
Clients ignore unknown object fields and event types.

A server rejects an unsupported requested major version with HTTP 426 and lists
its supported versions. The `capabilities` result is authoritative for optional
method support.

## 12. Minimum conformance tests

A server is compliant only if automated tests prove:

1. discovery and public registration validation;
2. exact redirect matching and loopback-port handling;
3. authorization denial and approval;
4. mandatory S256 PKCE and one-time, expiring codes;
5. scope enforcement for every exported method;
6. access expiry, refresh rotation, reuse-family revocation, and explicit
   revocation;
7. no token or configured secret appears in responses, logs, or packaged files;
8. RPC idempotency and size/rate/concurrency limits;
9. SSE ordering, replay, reset, heartbeat, and server-instance recovery;
10. HTTP rejection for non-loopback traffic and HTTPS operation for remote
    traffic.

## 13. Normative references

- RFC 6749, OAuth 2.0: <https://www.rfc-editor.org/rfc/rfc6749>
- RFC 6750, Bearer Token Usage: <https://www.rfc-editor.org/rfc/rfc6750>
- RFC 7009, Token Revocation: <https://www.rfc-editor.org/rfc/rfc7009>
- RFC 7591, Dynamic Client Registration: <https://www.rfc-editor.org/rfc/rfc7591>
- RFC 7636, PKCE: <https://www.rfc-editor.org/rfc/rfc7636>
- RFC 8252, OAuth for Native Apps: <https://www.rfc-editor.org/rfc/rfc8252>
- RFC 8414, Authorization Server Metadata: <https://www.rfc-editor.org/rfc/rfc8414>
- RFC 9207, Authorization Server Issuer Identification:
  <https://www.rfc-editor.org/rfc/rfc9207>
- RFC 9700, OAuth Security Best Current Practice:
  <https://www.rfc-editor.org/rfc/rfc9700>
