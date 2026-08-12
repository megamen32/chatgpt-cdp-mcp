# Tool reference

All browser-native identifiers are replaced with opaque `chatRef`,
`messageRef`, and `mediaRef` values. Refs are valid only while the page lease
remains the same.

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

Exports only the fixture chat. Output defaults to 50 messages and is capped at
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

Targets only the fixture. The confirmation and idempotency key are one-shot;
the key is tied to the exact payload and expires after 60 seconds by default.

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
