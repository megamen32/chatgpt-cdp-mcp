# Driver contract

`chatgpt-cdp-mcp` is browser-runtime agnostic. It loads one local ES module
whose default export or `createCdpChatDriver()` function returns this shape:

```ts
interface CdpChatDriver {
  acquirePage(): Promise<CdpChatPage>;
  capabilities?: Record<CdpChatOperation, boolean>;
}
```

The page implements:

```ts
interface CdpChatPage {
  identity(): Promise<PageIdentity>;
  snapshot(): Promise<ChatSnapshot>;
  createChat(input: { title?: string }): Promise<ChatRecord>;
  sendMessage(input: { chatId: string; text: string }): Promise<MessageRecord>;
  editMessage(input: {
    chatId: string;
    messageId: string;
    text: string;
    expectedVersion?: number;
    expectedText?: string;
  }): Promise<MessageRecord>;
  downloadMedia(input: {
    chatId: string;
    messageId: string;
    mediaId: string;
  }): Promise<DownloadedMedia>;
  runTask?(input: {
    chatId: string;
    kind: "research" | "search" | "draw";
    prompt: string;
  }): Promise<MessageRecord>;
}
```

Import the complete exported TypeScript definitions from the package:

```ts
import type { CdpChatDriver, CdpChatPage } from "chatgpt-cdp-mcp";
```

## Identity is a lease, not a username

`identity()` must return:

```ts
{
  origin: "https://chatgpt.com",
  accountRef: "opaque-account-reference",
  pageRef: "opaque-page-reference",
  leaseRef: "opaque-lease-reference"
}
```

All four values must remain stable from the start to the end of a tool call.
The server compares them on every call. If the browser swaps a tab, account,
or page lease, the operation fails rather than applying an old reference to a
new page.

Do not place a cookie, a browser debugging endpoint, or a recognizable email
address into a reference. The values reach MCP receipts.

## Snapshot requirements

`snapshot()` returns the chats currently observable on the owned page. Each
record needs an internal `id`, a title, `unread`, `working`, an ISO `updatedAt`,
and its visible messages/media. Browser-native IDs remain in the driver; the
MCP server converts them into random opaque refs.

Use actual observable values for `unread` and `working`. `recent` is calculated
by the server from `updatedAt` within the last seven days.

## Mutation requirements

`createChat()` must create a new empty chat and return a chat ID that was not
in the immediately preceding snapshot. It must not send a prompt.

`sendMessage` can target a page-visible chat after the server has checked its
opaque page-bound ref plus the explicit confirmation/idempotency gate.
`editMessage` and `downloadMedia` remain limited to the disposable fixture.
Still verify the target in your driver: a CDP implementation should not trust
stale DOM handles or text selectors.

For `editMessage`, honor either `expectedVersion` or `expectedText` when
provided. The server requires at least one of them.

## Optional native task capability

Implement `runTask()` to expose the MCP `research`, `search`, and `draw`
tools. It receives the one disposable fixture chat, selects the corresponding
capability available in the current ChatGPT UI, submits one prompt, waits for a
final assistant response, and returns that response as a `MessageRecord`.

- `research`: use the page's deep-research-style control when available.
- `search`: use the page's web-search control when available.
- `draw`: use the page's image-generation control and include generated media
  records in the returned message when the UI exposes them.

Do not implement this by opening a second page or tab per tool call. If a
capability is unavailable to the authenticated page, fail the call explicitly.
Drivers should declare `capabilities` truthfully so unsupported tools are not
advertised. Drivers that omit `runTask()` retain their core tools; calling a
missing task capability returns a clear `task_not_supported` error.

## Page ownership pattern

Acquire or open a single browser page once per driver process, retain it in the
driver, and return that same page through `acquirePage()`. Reuse an existing
target page where possible; if your product contract allows a fallback, create
one only when no target page exists. Never silently open a tab per tool call.
If the page is gone, fail the next call and make ownership recovery explicit.

## Bundled BrowserClaw driver

Set `CDP_CHAT_DRIVER=browserclaw` to use the included adapter. It connects to a
BrowserClaw Streamable HTTP session, uses the one ChatGPT tab accessible to
that session when there is exactly one, and otherwise creates one
`https://chatgpt.com/` tab. A visible tab may belong to another BrowserClaw
session and cannot be reused; the adapter detects that with a read-only
snapshot. It keeps its page in memory for the process lifetime and rejects
ambiguity when multiple accessible ChatGPT tabs exist unless
`CDP_CHAT_BROWSERCLAW_PAGE` selects one.

It uses BrowserClaw accessibility snapshots plus semantic `act` calls for the
ChatGPT composer and its research/search/draw controls. It currently declares
only `new_chat`, `send_message`, `download_media`, `research`, `search`, and
`draw`; a draw download is a settled-page PNG screenshot.

## Minimal factory

```js
import { connectToMyCdpRuntime } from "./my-cdp-runtime.mjs";

export async function createCdpChatDriver() {
  const page = await connectToMyCdpRuntime();
  return {
    async acquirePage() {
      return page;
    },
  };
}
```

Use the [mock driver](../examples/mock-driver.mjs) as a running reference and
the exported declarations for the complete record shapes.
