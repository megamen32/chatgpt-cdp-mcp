# Driver contract

`chatgpt-cdp-mcp` is browser-runtime agnostic. It loads one local ES module
whose default export or `createCdpChatDriver()` function returns this shape:

```ts
interface CdpChatDriver {
  acquirePage(): Promise<CdpChatPage>;
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

`sendMessage`, `editMessage`, and `downloadMedia` are invoked only after the
server has already limited their target to the disposable fixture. Still verify
the target in your driver: a CDP implementation should not trust stale DOM
handles or text selectors.

For `editMessage`, honor either `expectedVersion` or `expectedText` when
provided. The server requires at least one of them.

## Page ownership pattern

Acquire or open a single browser page once per driver process, retain it in the
driver, and return that same page through `acquirePage()`. Never silently open
a tab per tool call. If the page is gone, fail the next call and make ownership
recovery an explicit driver action.

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
