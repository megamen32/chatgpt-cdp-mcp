# Tool reference

All browser-native identifiers are replaced with opaque `chatRef`,
`messageRef`, and `mediaRef` values. Refs are valid only while the page lease
remains the same.

The server registers only the operations declared by its driver. The bundled
BrowserClaw driver currently registers `new_chat`, `send_message`,
`download_media`, `research`, `search`, and `draw`; the remaining sections
apply to a custom driver that exposes those capabilities.

## `new_chat`

Creates the one disposable fixture chat for this MCP process. It does not
submit a prompt.

```json
{
  "confirmation": "NEW_CHAT",
  "idempotencyKey": "unique-key",
  "title": "Optional fixture title"
}
```

The exact `NEW_CHAT` confirmation and an idempotency key are required. A
process can bind only one fixture.

## `list_chats`

```json
{ "view": "unread", "limit": 50, "cursor": "optional" }
```

`view` is one of:

- `unread`: the driver-observed unread marker.
- `working`: the driver-observed generating/stopped state.
- `recent`: `updatedAt` in the last seven days, calculated in UTC.

Results are ordered newest first and contain at most 100 chats.

## `search_chat`

```json
{ "query": "invoice", "limit": 50 }
```

Performs a case-insensitive title/message search over one fresh page snapshot.
It never opens another page.

## `export_chat`

```json
{ "chatRef": "...", "format": "markdown", "maxMessages": 50 }
```

Exports one page-visible chat. Output defaults to 50 messages and is capped at
64 KiB of UTF-8 data. The receipt tells you when content was truncated.

## `send_message`

```json
{
  "chatRef": "...",
  "text": "Hello",
  "confirmation": "SEND_MESSAGE",
  "idempotencyKey": "unique-key"
}
```

Targets one page-visible chat. The confirmation and idempotency key are
one-shot; the key is tied to the exact payload and expires after 60 seconds by
default.

## `edit_message`

```json
{
  "chatRef": "...",
  "messageRef": "...",
  "text": "Corrected text",
  "confirmation": "EDIT_MESSAGE",
  "idempotencyKey": "unique-key",
  "expectedVersion": 1
}
```

Targets only a fixture message. Provide `expectedVersion` or `expectedText` to
avoid overwriting a changed message.

## `download_media`

```json
{
  "chatRef": "...",
  "messageRef": "...",
  "mediaRef": "...",
  "outputDir": "optional-subdirectory"
}
```

Targets only fixture media. PNG, JPEG, WebP, PDF, and plain text are allowed by
default; the default size limit is 5 MiB. Files are written as `0600` below
`CDP_CHAT_MEDIA_ROOT` (or `./cdp-chat-media`). Attempts to escape that root or
overwrite an existing file fail.

For the bundled BrowserClaw driver, a `draw` result can expose a PNG screenshot
of the settled owned page. `download_media` saves that screenshot; it does not
claim to download the native ChatGPT image asset.

## `research`

```json
{ "chatRef": "...", "prompt": "Compare approaches and cite the trade-offs" }
```

Runs one research prompt in the disposable fixture chat. The driver selects the
ChatGPT page's currently available research capability, waits for it to settle,
and returns the last visible assistant result as an opaque message.

## `search`

```json
{ "chatRef": "...", "prompt": "Find current primary sources for this claim" }
```

Runs one web-search prompt in the disposable fixture chat. The driver must
implement that page-native control; this server does not substitute a separate
search API.

## `draw`

```json
{ "chatRef": "...", "prompt": "A concise product-diagram prompt" }
```

Runs one image-generation prompt in the disposable fixture chat. The returned
assistant message can contain opaque media refs. With BrowserClaw, the exposed
media is a settled-page PNG screenshot; pass its ref to `download_media`.

All three task tools require a `runTask()` implementation in the driver. The
bundled BrowserClaw driver reuses an accessible ChatGPT tab, or creates one
only when none is accessible to its MCP session, then keeps all calls on that
page.
